import { realpath, readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { fail } from "./errors.js";
import type { ReadContext, Runtime } from "./types.js";
export function isPublicAddress(address: string): boolean {
  try {
    let a = ipaddr.parse(address.replace(/^\[|\]$/g, ""));
    if (a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress())
      a = (a as ipaddr.IPv6).toIPv4Address();
    return a.range() === "unicast";
  } catch {
    return false;
  }
}
function denied(uri: string, msg: string): never {
  fail("RESOLVER_DENIED", msg, { uri, pointer: "" });
}
export const nodeRuntime: Runtime = {
  normalizeUri(value) {
    try {
      return new URL(value).href;
    } catch {
      return pathToFileURL(resolve(value)).href;
    }
  },
  async read(uri, context) {
    const u = new URL(uri);
    if (u.protocol === "file:") {
      const policy = context.options.resolve?.file;
      const root = new URL(context.rootUri);
      if (policy === false || (!policy && root.protocol !== "file:"))
        denied(uri, "Filesystem access is disabled");
      const fence =
        typeof policy === "object"
          ? resolve(policy.root)
          : dirname(fileURLToPath(root));
      const [actual, allowed] = await Promise.all([
        realpath(fileURLToPath(u)),
        realpath(fence),
      ]);
      const rel = relative(allowed, actual);
      if (
        rel === ".." ||
        rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
        isAbsolute(rel)
      )
        denied(uri, "File reference escapes permitted root");
      const handleStat = await stat(actual);
      if (!handleStat.isFile()) denied(uri, "Only regular files can be loaded");
      if (handleStat.size > context.maxBytes)
        denied(uri, "File exceeds byte limit");
      const bytes = await readFile(actual, { signal: context.signal });
      if (bytes.byteLength > context.maxBytes)
        denied(uri, "File exceeds byte limit");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      denied(uri, "Unsupported URI scheme");
    const policy = context.options.resolve?.http;
    if (!policy)
      denied(uri, "Network access is disabled; enable resolve.http explicitly");
    const options = policy === true ? {} : policy;
    async function fetchAt(url: URL, redirects: number): Promise<string> {
      if (context.signal.aborted) throw context.signal.reason;
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        denied(url.href, "Unsafe URL scheme or embedded credentials");
      if (options.allowHosts && !options.allowHosts.includes(url.hostname))
        denied(url.href, "Host is not on the allowlist");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (
        !options.allowPrivate &&
        (hostname === "localhost" ||
          /\.(localhost|local|internal|intranet|corp|home|lan)$/i.test(
            hostname,
          ))
      )
        denied(url.href, "Private hostname is blocked");
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      if (
        !addresses.length ||
        (!options.allowPrivate &&
          addresses.some((a) => !isPublicAddress(a.address)))
      )
        denied(url.href, "Non-public address is blocked");
      const chosen = addresses[0]!;
      const headers: Record<string, string> = {
        Accept: "application/json, application/yaml, text/yaml, */*",
        "Accept-Encoding": "identity",
      };
      if (url.origin === new URL(context.rootUri).origin)
        Object.assign(headers, options.headers);
      return await new Promise<string>((resolveText, reject) => {
        const request = (url.protocol === "https:" ? https : http).get(
          url,
          {
            headers,
            agent: false,
            signal: context.signal,
            lookup: (_h, _opts, callback) => callback(null, [chosen]),
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (
              [301, 302, 303, 307, 308].includes(status) &&
              response.headers.location
            ) {
              response.resume();
              if (redirects >= (options.maxRedirects ?? 3))
                return reject(new Error("Redirect limit exceeded"));
              const next = new URL(response.headers.location, url);
              if (url.protocol === "https:" && next.protocol === "http:")
                return reject(new Error("HTTPS downgrade redirect blocked"));
              fetchAt(next, redirects + 1).then(resolveText, reject);
              return;
            }
            if (status < 200 || status >= 300) {
              response.resume();
              reject(new Error(`HTTP ${status}`));
              return;
            }
            if (
              response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity"
            ) {
              response.resume();
              reject(new Error("Compressed responses are not accepted"));
              return;
            }
            let length = 0;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > context.maxBytes) {
                const error = new Error("Response exceeds byte limit");
                reject(error);
                request.destroy(error);
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              try {
                resolveText(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                );
              } catch (e) {
                reject(e);
              }
            });
            response.on("error", reject);
          },
        );
        request.setTimeout(options.timeoutMs ?? 10_000, () =>
          request.destroy(new Error("HTTP timeout")),
        );
        request.on("error", reject);
      });
    }
    return fetchAt(u, 0);
  },
};
