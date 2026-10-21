import type {
  Document,
  Input,
  ParserOptions,
  Runtime,
  SourceDocument,
  Limits,
  ReferenceEdge,
  Location,
  Dialect,
  Diagnostic,
} from "./types.js";
import { DEFAULT_LIMITS, parseSource, locate } from "./source.js";
import {
  fail,
  object,
  childPointer,
  refAddress,
  errorDiagnostics,
} from "./errors.js";
import { visitSyntax } from "./traverse.js";

export class Session {
  readonly sources = new Map<string, SourceDocument>();
  readonly working = new Map<string, unknown>();
  readonly opaque = new WeakSet<object>();
  readonly schemaNodes = new WeakSet<object>();
  readonly resources = new Map<string, Location>();
  readonly limits: Limits;
  readonly controller = new AbortController();
  rootUri = "memory://octri/openapi.yaml";
  readonly cache = new Map<string, Promise<string>>();
  private total = 0;
  private timer: ReturnType<typeof setTimeout>;
  private onAbort: () => void;
  private refNodes: {
    node: Record<string, unknown>;
    base: string;
    kind: "$ref" | "$dynamicRef";
  }[] = [];
  private keyAliases = new Map<string, string>();
  private masked = false;
  constructor(
    readonly options: ParserOptions,
    readonly runtime: Runtime,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [name, v] of Object.entries(this.limits))
      if (!Number.isSafeInteger(v) || v < 1)
        fail("INVALID_OPTIONS", `${name} must be a positive safe integer`, {
          uri: this.rootUri,
          pointer: "",
        });
    this.onAbort = () => this.controller.abort(options.signal?.reason);
    if (options.signal?.aborted) this.onAbort();
    else
      options.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(
      () => this.controller.abort(new Error("Operation time limit exceeded")),
      this.limits.timeoutMs,
    );
    this.timer.unref?.();
  }
  dispose() {
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.onAbort);
  }
  check() {
    if (this.controller.signal.aborted)
      fail(
        "ABORTED",
        this.controller.signal.reason?.message ?? "Operation aborted",
        { uri: this.rootUri, pointer: "" },
      );
  }
  async abortable<T>(promise: Promise<T>): Promise<T> {
    this.check();
    const signal = this.controller.signal;
    let listener: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          listener = () => reject(new Error("Operation aborted"));
          signal.addEventListener("abort", listener, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", listener);
      this.check();
    }
  }
  normalize(value: string, base = this.rootUri): string {
    return new URL(value, base).href;
  }
  async initialize(input: Input): Promise<Document> {
    this.check();
    let content: unknown;
    if (typeof input === "string") {
      if (
        input.includes("\n") ||
        /^\s*[\[{]/.test(input) ||
        /^\s*(openapi|swagger):/.test(input)
      ) {
        this.rootUri = this.options.uri
          ? this.runtime.normalizeUri(this.options.uri)
          : this.rootUri;
        content = input;
      } else {
        this.rootUri = this.runtime.normalizeUri(input);
        content = await this.read(this.rootUri);
      }
    } else if (
      object(input) &&
      typeof input.uri === "string" &&
      "content" in input
    ) {
      this.rootUri = this.runtime.normalizeUri(input.uri);
      content = input.content;
    } else {
      this.rootUri = this.options.uri
        ? this.runtime.normalizeUri(this.options.uri)
        : this.rootUri;
      content = input;
    }
    return this.add(this.rootUri, content) as Document;
  }
  async read(uri: string): Promise<string> {
    this.check();
    uri = new URL(uri).href;
    const cached = this.cache.get(uri);
    if (cached) return cached;
    if (this.cache.size >= this.limits.maxDocuments)
      fail("LIMIT_DOCUMENTS", "Too many referenced documents", {
        uri,
        pointer: "",
      });
    const p = (async () => {
      const entry = Object.entries(this.options.files ?? {}).find(
        ([k]) => this.normalize(k) === uri,
      );
      if (entry)
        return typeof entry[1] === "string"
          ? entry[1]
          : JSON.stringify(entry[1]);
      const context = {
        signal: this.controller.signal,
        maxBytes: this.limits.maxDocumentBytes,
        rootUri: this.rootUri,
        options: this.options,
      };
      const plugin = this.options.resolve?.plugins?.find((r) => r.canRead(uri));
      return await this.abortable(
        plugin ? plugin.read(uri, context) : this.runtime.read(uri, context),
      );
    })();
    this.cache.set(uri, p);
    return p;
  }
  add(uri: string, content: unknown): unknown {
    this.check();
    uri = this.normalize(uri);
    if (this.working.has(uri)) return this.working.get(uri);
    if (this.sources.size >= this.limits.maxDocuments)
      fail("LIMIT_DOCUMENTS", "Too many referenced documents", {
        uri,
        pointer: "",
      });
    const source = parseSource(uri, content, this.options, this.limits);
    this.total += source.bytes;
    if (this.total > this.limits.maxTotalBytes)
      fail("LIMIT_TOTAL_BYTES", "Total input bytes exceed limit", {
        uri,
        pointer: "",
      });
    this.sources.set(uri, source);
    const value = structuredClone(source.document);
    this.working.set(uri, value);
    const standalone =
      object(value) &&
      !value.openapi &&
      !value.swagger &&
      [
        "type",
        "properties",
        "$defs",
        "$id",
        "$schema",
        "allOf",
        "anyOf",
        "oneOf",
        "$ref",
      ].some((k) => k in value);
    this.resources.set(uri, { uri, pointer: "" });
    visitSyntax(
      value,
      (node, p, schema, base) => {
        for (const kind of ["$ref", "$dynamicRef"] as const)
          if (typeof node[kind] === "string")
            this.refNodes.push({ node, base, kind });
        if (schema) {
          this.schemaNodes.add(node);
          if (typeof node.$id === "string") {
            const old = this.resources.get(base);
            if (old && (old.uri !== uri || old.pointer !== p))
              fail(
                "DUPLICATE_RESOURCE_ID",
                `Duplicate schema resource ${base}`,
                locate(source, p),
              );
            this.resources.set(base, { uri, pointer: p });
          }
          for (const k of ["$anchor", "$dynamicAnchor"])
            if (typeof node[k] === "string") {
              const id = base.split("#")[0] + "#" + node[k];
              const old = this.resources.get(id);
              if (old && (old.uri !== uri || old.pointer !== p))
                fail(
                  "DUPLICATE_ANCHOR",
                  `Duplicate schema anchor ${node[k]}`,
                  locate(source, p),
                );
              this.resources.set(id, { uri, pointer: p });
            }
        }
      },
      uri,
      this.opaque,
      standalone ? "schema" : "api",
    );
    return value;
  }
  async preload(): Promise<Diagnostic[]> {
    const errors: Diagnostic[] = [];
    for (let index = 0; index < this.refNodes.length; index++) {
      try {
        this.check();
        const { node, base, kind } = this.refNodes[index]!;
        let absolute: URL;
        try {
          absolute = new URL(node[kind] as string, base);
        } catch {
          continue;
        }
        const address = absolute.href;
        absolute.hash = "";
        if (
          !this.resources.has(absolute.href) &&
          this.options.resolve?.external !== false
        ) {
          const text = await this.read(absolute.href);
          this.add(absolute.href, text);
        }
        const target = this.target(address, base);
        if (target && kind === "$ref")
          node.$ref =
            target.uri === base
              ? refAddress(target).slice(target.uri.length)
              : refAddress(target);
      } catch (error) {
        if (!this.options.continueOnError || this.controller.signal.aborted)
          throw error;
        errors.push(...errorDiagnostics(error, this.rootUri));
      }
    }
    return errors;
  }
  engineAddress(target: Location): string {
    if (!this.masked) return refAddress(target);
    const pointer = target.pointer
      .split("/")
      .map((t) => {
        const key = t.replaceAll("~1", "/").replaceAll("~0", "~");
        return (this.keyAliases.get(key) ?? key)
          .replaceAll("~", "~0")
          .replaceAll("/", "~1");
      })
      .join("/");
    return refAddress({ ...target, pointer });
  }
  /** Isolate upstream URI-decoding defects without patching installed dependencies. */
  maskSpecialKeys() {
    const seen = new WeakSet<object>();
    const nodes: Record<string, unknown>[] = [];
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") {
        strings.push(v);
        return;
      }
      if (!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      nodes.push(v as Record<string, unknown>);
      for (const [k, n] of Object.entries(v)) {
        strings.push(k);
        walk(n);
      }
    };
    for (const v of this.working.values()) walk(v);
    let prefix = "__octri_pointer_";
    while (strings.some((s) => s.includes(prefix))) prefix += "_";
    for (const node of nodes)
      for (const key of Object.keys(node))
        if (/[#%]/.test(key)) {
          let alias = this.keyAliases.get(key);
          if (!alias) {
            alias = prefix + this.keyAliases.size;
            this.keyAliases.set(key, alias);
          }
          node[alias] = node[key];
          delete node[key];
        }
    this.masked = true;
    for (const { node, base, kind } of this.refNodes)
      if (kind === "$ref") {
        const target = this.target(node.$ref as string, base);
        if (target) {
          const address = this.engineAddress(target);
          node.$ref =
            target.uri === base ? address.slice(target.uri.length) : address;
        }
      }
  }
  restoreSpecialKeys(output?: unknown) {
    if (!this.masked) return;
    const reverse = new Map([...this.keyAliases].map(([k, v]) => [v, k]));
    const seen = new WeakSet<object>();
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      const node = v as Record<string, unknown>;
      for (const [key, n] of Object.entries(node)) {
        if (reverse.has(key)) {
          node[reverse.get(key)!] = n;
          delete node[key];
        }
        if (
          (key === "$ref" || key === "$dynamicRef") &&
          typeof n === "string" &&
          n.includes("#")
        ) {
          const at = n.indexOf("#");
          const fragment = n
            .slice(at + 1)
            .split("/")
            .map((token) => {
              const decoded = decodeURIComponent(token);
              return reverse.has(decoded)
                ? encodeURIComponent(
                    reverse
                      .get(decoded)!
                      .replaceAll("~", "~0")
                      .replaceAll("/", "~1"),
                  )
                : token;
            })
            .join("/");
          node[key] = n.slice(0, at + 1) + fragment;
        }
        walk(n);
      }
    };
    for (const v of this.working.values()) walk(v);
    walk(output);
    this.masked = false;
  }
  normalizeReferences(dialect: Dialect, diagnostics: Diagnostic[]) {
    for (const source of this.sources.values()) {
      const value = this.working.get(source.uri);
      visitSyntax(
        value,
        (node, p, schema) => {
          if (typeof node.$ref !== "string") return;
          const pathItem =
            /^(?:\/paths|\/webhooks|\/components\/pathItems)\/[^/]+$/.test(p) ||
            /\/callbacks\/[^/]+\/[^/]+$/.test(p);
          if (
            (schema &&
              (dialect === "openapi3.1" || dialect === "openapi3.2")) ||
            pathItem
          )
            return;
          const allowed =
            dialect === "openapi3.1" || dialect === "openapi3.2"
              ? ["$ref", "summary", "description"]
              : ["$ref"];
          for (const key of Object.keys(node))
            if (!allowed.includes(key)) {
              delete node[key];
              diagnostics.push({
                code: "IGNORED_REFERENCE_SIBLING",
                severity: "warning",
                message: `Reference Object sibling ${key} is ignored by this OpenAPI dialect`,
                location: locate(source, childPointer(p, key)),
              });
            }
        },
        source.uri,
      );
    }
  }
  embedDynamicResources(root: Document, dialect: Dialect) {
    if (dialect !== "openapi3.1" && dialect !== "openapi3.2") return;
    const embedded = new Set<string>();
    for (const { node, base, kind } of this.refNodes)
      if (kind === "$dynamicRef") {
        const absolute = new URL(node.$dynamicRef as string, base);
        const target = this.target(absolute.href, base);
        if (!target || target.uri === this.rootUri) continue;
        const external = this.working.get(target.uri);
        if (!object(external) || external.openapi || external.swagger)
          fail(
            "DYNAMIC_RESOURCE_UNSUPPORTED",
            "External dynamic references require a standalone JSON Schema resource",
            { uri: target.uri, pointer: target.pointer },
          );
        node.$dynamicRef = absolute.href;
        if (embedded.has(target.uri)) continue;
        embedded.add(target.uri);
        const components = object(root.components)
          ? root.components
          : ((root.components = {}) as Document);
        const schemas = object(components.schemas)
          ? components.schemas
          : ((components.schemas = {}) as Document);
        let name = "OctriDynamicResource" + embedded.size;
        while (Object.hasOwn(schemas, name)) name += "_";
        const oldId =
          typeof external.$id === "string" ? external.$id : target.uri;
        external.$id = new URL(oldId, target.uri).href;
        schemas[name] = external;
      }
  }
  /** Preserve conjunction semantics instead of overwriting sibling constraints. */
  protectSchemaSiblings(value: unknown) {
    if (this.options.dereference?.schemaSiblings === "merge") return;
    for (const source of this.sources.values()) {
      const work = this.working.get(source.uri);
      visitSyntax(
        work,
        (node, _p, schema) => {
          if (
            !schema ||
            typeof node.$ref !== "string" ||
            Object.keys(node).length === 1
          )
            return;
          const ref = node.$ref;
          delete node.$ref;
          const previous = Array.isArray(node.allOf) ? node.allOf : [];
          node.allOf = [{ $ref: ref }, ...previous];
        },
        source.uri,
      );
    }
  }
  target(ref: string, base: string): Location | undefined {
    let absolute: string;
    try {
      absolute = new URL(ref, base).href;
    } catch {
      return;
    }
    const exact = this.resources.get(absolute);
    if (exact) return exact;
    const url = new URL(absolute);
    const fragment = url.hash;
    url.hash = "";
    const resource = this.resources.get(url.href);
    if (!resource) return;
    if (!fragment) return resource;
    if (fragment === "#") return resource;
    if (fragment.startsWith("#/")) {
      try {
        return {
          uri: resource.uri,
          pointer: resource.pointer + decodeURIComponent(fragment.slice(1)),
        };
      } catch {
        return;
      }
    }
  }
  references(refs: { exists(ref: string): boolean }): ReferenceEdge[] {
    const edges: ReferenceEdge[] = [];
    for (const source of this.sources.values()) {
      const standalone =
        object(source.document) &&
        !source.document.openapi &&
        !source.document.swagger;
      visitSyntax(
        source.document,
        (node, p, _schema, base) => {
          for (const kind of ["$ref", "$dynamicRef"] as const)
            if (typeof node[kind] === "string") {
              const target = this.target(node[kind], base);
              let resolved = false;
              try {
                resolved = refs.exists(
                  target ? refAddress(target) : new URL(node[kind], base).href,
                );
              } catch {
                /* invalid URI */
              }
              edges.push({
                from: locate(source, childPointer(p, kind)),
                ref: node[kind],
                kind,
                target: target
                  ? locate(this.sources.get(target.uri)!, target.pointer)
                  : undefined,
                resolved,
              });
            }
        },
        source.uri,
      );
    }
    return edges;
  }
}
