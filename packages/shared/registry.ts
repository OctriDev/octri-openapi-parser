import type { Address, Report } from "./types.js";

/** Lookup facade over Rust's canonical resource index. Mutation affects this
 * working registry only; original source snapshots remain unchanged. */
export class ReferenceRegistry {
  readonly circular: boolean;
  readonly #root: string;
  readonly #resources: Record<string, Address>;
  readonly #anchors: Record<string, Address>;
  readonly #retrievalAliases: Record<string, string>;
  readonly #documents: Map<string, unknown>;
  readonly #originals: Map<string, unknown>;
  readonly #edges: Map<string, Address>;

  constructor(report?: Report) {
    this.circular = report?.graph?.circular ?? false;
    this.#root = report?.registry.rootUri ?? "memory://octri/openapi.yaml";
    this.#resources = report?.registry.resources ?? {};
    this.#anchors = report?.registry.anchors ?? {};
    this.#retrievalAliases = report?.registry.retrievalAliases ?? {};
    this.#originals = new Map(
      report?.sources.map((source) => [source.uri, source.document]) ?? [],
    );
    if (report?.registry.rootDocument)
      this.#originals.set(this.#root, report.registry.rootDocument);
    this.#documents = new Map();
    this.#edges = new Map(
      report?.references
        .filter((edge) => edge.target && edge.kind === "$ref")
        .map((edge) => [
          key({
            uri: edge.from.uri,
            pointer: edge.from.pointer.replace(/\/\$(dynamicRef|ref)$/, ""),
          }),
          edge.target!,
        ]) ?? [],
    );
  }
  paths(...schemes: string[]): string[] {
    return [...this.#originals.keys()].filter(
      (uri) =>
        !schemes.length ||
        schemes.some((scheme) =>
          scheme === "http"
            ? /^https?:/.test(uri)
            : uri.startsWith(`${scheme}:`),
        ),
    );
  }
  values(...schemes: string[]): Record<string, unknown> {
    return Object.fromEntries(
      this.paths(...schemes).map((uri) => [uri, this.#document(uri)]),
    );
  }
  exists(reference: string): boolean {
    try {
      this.get(reference);
      return true;
    } catch {
      return false;
    }
  }
  get(reference: string): unknown {
    let address = this.#address(reference);
    const seen = new Set<string>();
    while (!seen.has(key(address))) {
      seen.add(key(address));
      const target = this.#edges.get(key(address));
      if (!target) break;
      address = target;
    }
    let value = this.#document(address.uri);
    for (const token of tokens(address.pointer)) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, token)
      )
        throw new Error(`Reference target does not exist: ${reference}`);
      value = (value as Record<string, unknown>)[token];
    }
    if (!this.#originals.has(address.uri))
      throw new Error(`Unknown reference document: ${reference}`);
    return value;
  }
  set(reference: string, value: unknown): this {
    const address = this.#address(reference);
    const path = tokens(address.pointer);
    if (
      path.some((token) =>
        ["__proto__", "prototype", "constructor"].includes(token),
      )
    )
      throw new Error("Unsafe reference mutation path");
    if (!this.#originals.has(address.uri))
      throw new Error(`Unknown reference document: ${reference}`);
    if (!path.length) this.#documents.set(address.uri, value);
    else {
      const last = path.pop()!;
      let parent = this.#document(address.uri);
      for (const token of path) {
        if (
          parent === null ||
          typeof parent !== "object" ||
          !Object.hasOwn(parent, token)
        )
          throw new Error(`Reference parent does not exist: ${reference}`);
        parent = (parent as Record<string, unknown>)[token];
      }
      if (parent === null || typeof parent !== "object")
        throw new Error("Reference parent must be an object or array");
      Object.defineProperty(parent, last, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return this;
  }
  #document(uri: string): unknown {
    if (!this.#documents.has(uri) && this.#originals.has(uri))
      this.#documents.set(uri, structuredClone(this.#originals.get(uri)));
    return this.#documents.get(uri);
  }
  #address(reference: string): Address {
    if (/%(?![\da-f]{2})/i.test(reference))
      throw new Error("Invalid percent escape in reference");
    const url = new URL(reference, this.#root);
    const fragment = decodeURIComponent(url.hash.slice(1));
    url.hash = "";
    const uri = Object.hasOwn(this.#retrievalAliases, url.href)
      ? this.#retrievalAliases[url.href]!
      : url.href;
    if (fragment && !fragment.startsWith("/")) {
      const anchor =
        this.#anchors[`${url.href}#${fragment}`] ??
        this.#anchors[`${uri}#${fragment}`];
      if (!anchor) throw new Error(`Unknown anchor: ${reference}`);
      return anchor;
    }
    const resource = this.#resources[uri];
    if (!resource) throw new Error(`Unknown resource: ${reference}`);
    return { uri: resource.uri, pointer: resource.pointer + fragment };
  }
}
function key(address: Address): string {
  return `${address.uri}#${address.pointer}`;
}
function tokens(pointer: string): string[] {
  if (/~(?![01])/.test(pointer)) throw new Error("Invalid JSON Pointer escape");
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}
