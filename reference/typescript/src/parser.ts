import { $RefParser } from "@apidevtools/json-schema-ref-parser";
import type { ParserOptions as RefOptions } from "@apidevtools/json-schema-ref-parser";
import type {
  Analysis,
  Callback,
  Diagnostic,
  Dialect,
  Document,
  Input,
  Inspection,
  ParserOptions,
  ReferenceEdge,
  Runtime,
  SourceDocument,
} from "./types.js";
import { Session } from "./session.js";
import { detectDialect, locate } from "./source.js";
import {
  errorDiagnostics,
  fail,
  object,
  OpenAPIError,
  refAddress,
} from "./errors.js";
import { inspectDocument } from "./inspect.js";
import { validateDocument } from "./validate.js";
import { visitSyntax } from "./traverse.js";
import { portableBundle } from "./bundle.js";

const browserRuntime: Runtime = {
  normalizeUri: (value) => new URL(value, "memory://octri/").href,
  read: async (uri) =>
    fail(
      "RESOLVER_DENIED",
      "Browser entry requires supplied files or an explicit resolver plugin",
      { uri, pointer: "" },
    ),
};
type OptionsOrCallback<T> = ParserOptions | Callback<T>;
function deliver<T>(promise: Promise<T>, callback?: Callback<T>): Promise<T> {
  if (callback)
    promise.then(
      (value) => callback(null, value),
      (error) =>
        callback(error instanceof Error ? error : new Error(String(error))),
    );
  return promise;
}
function merge(a: ParserOptions, b: ParserOptions): ParserOptions {
  return {
    ...a,
    ...b,
    resolve: { ...a.resolve, ...b.resolve },
    parse: { ...a.parse, ...b.parse },
    validate: { ...a.validate, ...b.validate },
    dereference: { ...a.dereference, ...b.dereference },
    limits: { ...a.limits, ...b.limits },
  };
}
export class ReferenceRegistry {
  constructor(
    private engine: $RefParser<Document>,
    private root: () => string,
    private canonical: (ref: string) => string = (ref) => ref,
    private session?: Session,
  ) {}
  get circular() {
    return this.engine.$refs.circular;
  }
  paths(...types: string[]) {
    return [
      ...new Set([
        ...this.engine.$refs.paths(),
        ...(this.session?.sources.keys() ?? []),
      ]),
    ].filter(
      (p) =>
        !types.length ||
        types.some((t) =>
          t === "file"
            ? p.startsWith("file:")
            : t === "http"
              ? /^https?:/.test(p)
              : p.startsWith(t + ":"),
        ),
    );
  }
  values(...types: string[]) {
    const all = {
      ...Object.fromEntries(this.session?.working ?? []),
      ...this.engine.$refs.values(),
    };
    return Object.fromEntries(this.paths(...types).map((p) => [p, all[p]]));
  }
  exists(ref: string) {
    try {
      this.get(ref);
      return true;
    } catch {
      return false;
    }
  }
  get(ref: string) {
    const absolute = this.canonical(new URL(ref, this.root()).href);
    try {
      return this.engine.$refs.get(absolute);
    } catch (error) {
      const u = new URL(absolute);
      const pointer = decodeURIComponent(u.hash.slice(1));
      u.hash = "";
      if (!this.session?.working.has(u.href)) throw error;
      let value = this.session.working.get(u.href);
      if (pointer && !pointer.startsWith("/")) throw error;
      for (const t of pointer
        .split("/")
        .slice(1)
        .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (
          value === null ||
          typeof value !== "object" ||
          !Object.hasOwn(value, t)
        )
          throw error;
        value = (value as Document)[t];
      }
      return value;
    }
  }
  set(ref: string, value: unknown) {
    const u = new URL(ref, this.root());
    const tokens = decodeURIComponent(u.hash.slice(1))
      .split("/")
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (
      tokens.some((t) => ["__proto__", "prototype", "constructor"].includes(t))
    )
      fail("UNSAFE_POINTER", "Unsafe reference mutation path", {
        uri: u.href,
        pointer: "",
      });
    this.engine.$refs.set(
      u.href,
      value as Parameters<typeof this.engine.$refs.set>[1],
    );
    return this;
  }
}
/** Source-aware parser. One operation per instance; use separate instances concurrently. */
export class CoreParser {
  api: Document | null = null;
  document: Document | null = null;
  dialect?: Dialect;
  diagnostics: Diagnostic[] = [];
  sources: SourceDocument[] = [];
  references: ReferenceEdge[] = [];
  inspection?: Inspection;
  $refs: ReferenceRegistry;
  private engine = new $RefParser<Document>();
  private rootUri = "memory://octri/openapi.yaml";
  private busy = false;
  constructor(
    readonly defaults: ParserOptions = {},
    private runtime: Runtime = browserRuntime,
  ) {
    this.$refs = new ReferenceRegistry(this.engine, () => this.rootUri);
  }
  parse(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ): Promise<Document> {
    return deliver(
      this.run(
        "parse",
        input,
        typeof options === "function" ? {} : options,
      ) as Promise<Document>,
      typeof options === "function" ? options : callback,
    );
  }
  resolve(
    input: Input,
    options: OptionsOrCallback<ReferenceRegistry> = {},
    callback?: Callback<ReferenceRegistry>,
  ): Promise<ReferenceRegistry> {
    return deliver(
      this.run(
        "resolve",
        input,
        typeof options === "function" ? {} : options,
      ) as Promise<ReferenceRegistry>,
      typeof options === "function" ? options : callback,
    );
  }
  bundle(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ): Promise<Document> {
    return deliver(
      this.run(
        "bundle",
        input,
        typeof options === "function" ? {} : options,
      ) as Promise<Document>,
      typeof options === "function" ? options : callback,
    );
  }
  dereference(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ): Promise<Document> {
    return deliver(
      this.run(
        "dereference",
        input,
        typeof options === "function" ? {} : options,
      ) as Promise<Document>,
      typeof options === "function" ? options : callback,
    );
  }
  validate(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ): Promise<Document> {
    return deliver(
      this.run(
        "validate",
        input,
        typeof options === "function" ? {} : options,
      ) as Promise<Document>,
      typeof options === "function" ? options : callback,
    );
  }
  async inspect(
    input: Input,
    options: ParserOptions = {},
  ): Promise<Inspection> {
    await this.run("inspect", input, options);
    return this.inspection!;
  }
  async analyze(input: Input, options: ParserOptions = {}): Promise<Analysis> {
    try {
      await this.run("validate", input, { ...options, continueOnError: true });
    } catch (error) {
      if (!(error instanceof OpenAPIError)) throw error;
    }
    return {
      valid: !this.diagnostics.some((d) => d.severity === "error"),
      dialect: this.dialect,
      document: this.document ?? undefined,
      diagnostics: [...this.diagnostics],
      sources: [...this.sources],
      inspection: this.inspection,
    };
  }
  static parse(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ) {
    return new this().parse(input, options, callback);
  }
  static resolve(
    input: Input,
    options: OptionsOrCallback<ReferenceRegistry> = {},
    callback?: Callback<ReferenceRegistry>,
  ) {
    return new this().resolve(input, options, callback);
  }
  static bundle(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ) {
    return new this().bundle(input, options, callback);
  }
  static dereference(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ) {
    return new this().dereference(input, options, callback);
  }
  static validate(
    input: Input,
    options: OptionsOrCallback<Document> = {},
    callback?: Callback<Document>,
  ) {
    return new this().validate(input, options, callback);
  }
  static inspect(input: Input, options: ParserOptions = {}) {
    return new this().inspect(input, options);
  }
  static analyze(input: Input, options: ParserOptions = {}) {
    return new this().analyze(input, options);
  }
  private async run(
    method:
      "parse" | "resolve" | "bundle" | "dereference" | "validate" | "inspect",
    input: Input,
    perCall: ParserOptions,
  ): Promise<Document | ReferenceRegistry> {
    if (this.busy)
      fail(
        "CONCURRENT_OPERATION",
        "Use a separate parser instance for concurrent operations",
        { uri: this.rootUri, pointer: "" },
      );
    this.busy = true;
    this.api = null;
    this.document = null;
    this.dialect = undefined;
    this.diagnostics = [];
    this.sources = [];
    this.references = [];
    this.inspection = undefined;
    this.engine = new $RefParser<Document>();
    this.$refs = new ReferenceRegistry(this.engine, () => this.rootUri);
    const options = merge(this.defaults, perCall);
    let session: Session | undefined;
    let syntheticDialect = false;
    try {
      session = new Session(options, this.runtime);
      const root = await session.initialize(input);
      this.rootUri = session.rootUri;
      this.dialect = detectDialect(root, this.rootUri);
      this.document = structuredClone(root);
      this.api = root;
      const s = session;
      this.$refs = new ReferenceRegistry(
        this.engine,
        () => this.rootUri,
        (ref) => {
          const target = s.target(ref, this.rootUri);
          return target ? s.engineAddress(target) : ref;
        },
        s,
      );
      const excluded = (_p: string, value?: unknown) =>
        !!value && typeof value === "object" && s.opaque.has(value);
      const refOptions: RefOptions<Document> = {
        mutateInputSchema: true,
        continueOnError: options.continueOnError ?? false,
        timeoutMs: s.limits.timeoutMs,
        parse: {
          json: false,
          yaml: false,
          text: false,
          binary: false,
          octri: {
            order: 1,
            canParse: () => true,
            parse: (file) => s.add(file.url, file.data),
          },
        },
        resolve: {
          file: false,
          http: false,
          external: options.resolve?.external !== false,
          octri: {
            order: 1,
            canRead: () => true,
            read: (file) => s.read(file.url),
          },
        },
        resolveExcludedPathMatcher: excluded,
        bundle: { excludedPathMatcher: excluded, optimizeInternalRefs: false },
        dereference: {
          excludedPathMatcher: excluded,
          circular: options.dereference?.circular ?? true,
          cloneReferences: options.dereference?.cloneReferences ?? false,
          maxDepth: s.limits.maxDepth,
          mergeKeys: true,
        },
      };
      if (method === "parse") {
        await this.engine.parse(this.rootUri, root, refOptions);
        return root;
      }
      this.diagnostics.push(...(await s.preload()));
      s.normalizeReferences(this.dialect, this.diagnostics);
      if (
        method === "bundle" ||
        method === "dereference" ||
        method === "validate"
      )
        s.embedDynamicResources(root, this.dialect);
      s.maskSpecialKeys();
      if (this.dialect === "openapi3.2" && root.$schema === undefined) {
        root.$schema = "https://json-schema.org/draft/2020-12/schema";
        syntheticDialect = true;
      }
      try {
        await s.abortable(this.engine.resolve(this.rootUri, root, refOptions));
      } catch (error) {
        if (!options.continueOnError || s.controller.signal.aborted)
          throw error;
        this.diagnostics.push(...errorDiagnostics(error, this.rootUri));
      }
      this.references = s.references(this.$refs);
      for (const edge of this.references)
        if (!edge.resolved)
          this.diagnostics.push({
            code:
              edge.kind === "$dynamicRef"
                ? "UNRESOLVED_DYNAMIC_REFERENCE"
                : "UNRESOLVED_REFERENCE",
            severity: "error",
            message: `Cannot resolve ${edge.ref}`,
            location: edge.from,
          });
      if (method === "inspect" || method === "validate")
        this.inspection = inspectDocument(
          this.document,
          this.dialect,
          this.rootUri,
          this.$refs,
          this.references,
          (u, p) =>
            s.sources.has(u)
              ? locate(s.sources.get(u)!, p)
              : { uri: u, pointer: p },
          s.sources.size,
        );
      if (this.diagnostics.some((d) => d.severity === "error"))
        throw new OpenAPIError(this.diagnostics);
      if (method === "resolve" || method === "inspect")
        return method === "resolve" ? this.$refs : root;
      if (
        method === "dereference" &&
        (this.dialect === "openapi3.1" || this.dialect === "openapi3.2")
      )
        s.protectSchemaSiblings(root);
      if (method === "bundle" || method === "validate") {
        this.api = (await s.abortable(
          this.engine.bundle(this.rootUri, root, refOptions),
        )) as Document;
        if (this.dialect === "openapi3.1" || this.dialect === "openapi3.2")
          portableBundle(this.api, this.rootUri);
        if (syntheticDialect) delete root.$schema;
        if (method === "bundle") return this.api;
        this.diagnostics.push(
          ...validateDocument(
            this.api,
            this.dialect,
            this.inspection!,
            options,
            (p) => {
              const source = s.sources.get(this.rootUri)!;
              if (source.locations.has(p)) return locate(source, p);
              const edge = this.references
                .filter(
                  (e) =>
                    e.from.uri === this.rootUri &&
                    e.target &&
                    p.startsWith(e.from.pointer.replace(/\/\$ref$/, "") + "/"),
                )
                .sort(
                  (a, b) => b.from.pointer.length - a.from.pointer.length,
                )[0];
              if (edge?.target) {
                const at = edge.from.pointer.replace(/\/\$ref$/, "");
                return locate(
                  s.sources.get(edge.target.uri)!,
                  edge.target.pointer + p.slice(at.length),
                );
              }
              return locate(source, p);
            },
            (value) => {
              if (object(value) && typeof value.$ref === "string") {
                try {
                  return this.$refs.get(value.$ref);
                } catch {
                  return value;
                }
              }
              return value;
            },
          ),
        );
        if (this.diagnostics.some((d) => d.severity === "error"))
          throw new OpenAPIError(this.diagnostics);
        if (this.dialect === "openapi3.1" || this.dialect === "openapi3.2")
          s.protectSchemaSiblings(root);
        if (syntheticDialect)
          root.$schema = "https://json-schema.org/draft/2020-12/schema";
      }
      this.api = (await s.abortable(
        this.engine.dereference(this.rootUri, root, refOptions),
      )) as Document;
      if (this.references.some((e) => e.kind === "$dynamicRef"))
        this.diagnostics.push({
          code: "DYNAMIC_REFERENCE_PRESERVED",
          severity: "info",
          message:
            "Dynamic references are preserved for a JSON Schema evaluator; they are not replaced with a static target.",
          location: { uri: this.rootUri, pointer: "" },
        });
      return this.api;
    } catch (error) {
      const diagnostics = errorDiagnostics(
        error,
        session?.rootUri ?? this.rootUri,
      );
      for (const d of diagnostics)
        if (!this.diagnostics.includes(d)) this.diagnostics.push(d);
      throw error instanceof OpenAPIError
        ? error
        : new OpenAPIError(this.diagnostics, { cause: error });
    } finally {
      if (session) {
        if (syntheticDialect && this.api) delete this.api.$schema;
        session.restoreSpecialKeys(this.api);
        this.sources = [...session.sources.values()];
        session.dispose();
      }
      this.busy = false;
    }
  }
}
