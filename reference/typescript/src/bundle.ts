import type { Document } from "./types.js";
import { fail, object, refAddress } from "./errors.js";
import { visitSyntax } from "./traverse.js";
function tokens(pointer: string) {
  return pointer
    .split("/")
    .slice(1)
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function get(root: unknown, pointer: string): unknown {
  let v = root;
  for (const t of tokens(pointer)) {
    if (!v || typeof v !== "object" || !Object.hasOwn(v, t)) return;
    v = (v as Document)[t];
  }
  return v;
}
function set(root: Document, pointer: string, value: unknown) {
  const parts = tokens(pointer);
  const key = parts.pop()!;
  let node = root;
  for (const p of parts) node = node[p] as Document;
  node[key] = value;
}
function hash(text: string) {
  let v = 14695981039346656037n;
  for (const c of text) {
    v ^= BigInt(c.codePointAt(0)!);
    v = BigInt.asUintN(64, v * 1099511628211n);
  }
  return v.toString(16);
}
/** Keep references portable when a nested JSON Schema resource changes the URI base. */
export function portableBundle(root: Document, uri: string): void {
  const resources = new Map<string, string>([[uri, ""]]);
  const ids = new Map<string, string>();
  const refs: {
    node: Document;
    pointer: string;
    base: string;
    schema: boolean;
    ref: string;
    target?: string;
  }[] = [];
  visitSyntax(
    root,
    (node, p, schema, base) => {
      if (schema && typeof node.$id === "string") {
        node.$id = base;
        resources.set(base, p);
        ids.set(p, base);
      }
      for (const key of ["$anchor", "$dynamicAnchor"])
        if (schema && typeof node[key] === "string")
          resources.set(new URL("#" + node[key], base).href, p);
      if (typeof node.$ref === "string")
        refs.push({ node, pointer: p, base, schema, ref: node.$ref });
    },
    uri,
  );
  for (const entry of refs) {
    const address = new URL(entry.ref, entry.base);
    const direct = resources.get(address.href);
    if (direct !== undefined) entry.target = direct;
    else {
      const fragment = address.hash;
      address.hash = "";
      const base = resources.get(address.href);
      if (base !== undefined && (!fragment || fragment.startsWith("#/")))
        entry.target =
          base + (fragment ? decodeURIComponent(fragment.slice(1)) : "");
    }
    if (entry.target === undefined || get(root, entry.target) === undefined)
      fail(
        "BUNDLE_UNRESOLVED",
        `Bundled reference has no embedded target: ${entry.ref}`,
        { uri, pointer: entry.pointer },
      );
  }
  const nearest = (p: string) =>
    [...ids]
      .filter(([at]) => p === at || p.startsWith(at + "/"))
      .sort((a, b) => b[0].length - a[0].length)[0];
  for (const entry of refs) {
    if (!entry.schema || !nearest(entry.pointer) || nearest(entry.target!))
      continue;
    let target = get(root, entry.target!);
    if (typeof target === "boolean") {
      target = { allOf: [target] };
      set(root, entry.target!, target);
    }
    if (!object(target))
      fail("BUNDLE_TARGET_INVALID", "Schema reference target is not a schema", {
        uri,
        pointer: entry.target!,
      });
    let id = "urn:octri:bundle:" + hash(uri + "#" + entry.target);
    while (resources.has(id)) id += "0";
    target.$id = id;
    ids.set(entry.target!, id);
    resources.set(id, entry.target!);
  }
  for (const entry of refs) {
    const resource = entry.schema ? nearest(entry.target!) : undefined;
    entry.node.$ref = resource
      ? refAddress({
          uri: resource[1],
          pointer: entry.target!.slice(resource[0].length),
        })
      : refAddress({ uri, pointer: entry.target! }).slice(uri.length);
  }
}
