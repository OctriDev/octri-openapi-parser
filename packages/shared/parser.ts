import { OpenAPIError, bindingError } from "./errors.js";
import { encodeInput } from "./json.js";
import { parseJson } from "./numbers.mjs";
export { LosslessNumber, parseJson } from "./numbers.mjs";
export { OpenAPIError, bindingError } from "./errors.js";
export { encodeDocument } from "./json.js";
import { ReferenceRegistry } from "./registry.js";
import { restoreReport } from "./transport.js";
export { ReferenceRegistry } from "./registry.js";
import type {
  Diagnostic,
  Document,
  Graph,
  Input,
  Inspection,
  Operation,
  Options,
  Report,
  Transport,
  TransportRequest,
} from "./types.js";
export type * from "./types.js";

/** Reconstruct identity from Rust's arena. This is transport logic, not ref resolution. */
export function materialize(graph: Pick<Graph, "root" | "nodes">): Document {
  const objects: unknown[] = graph.nodes.map((node) =>
    node.kind === "object"
      ? { ...node.value }
      : node.kind === "array"
        ? []
        : node.value,
  );
  graph.nodes.forEach((node, index) => {
    if (node.kind === "object") {
      const object = objects[index] as Document;
      // Spread created own writable data properties. Linking them cannot invoke
      // an inherited setter, including one named __proto__.
      for (const [key, id] of Object.entries(node.value)) {
        object[key] = objects[id];
      }
    } else if (node.kind === "array") {
      const array = objects[index] as unknown[];
      for (const id of node.value) array.push(objects[id]);
    }
  });
  return objects[graph.root] as Document;
}

export function decodeResult<T>(text: string): T {
  const result = parseJson(text) as {
    Ok?: T;
    Err?: { message: string; diagnostics: Diagnostic[] };
  };
  if (result.Err)
    throw new OpenAPIError(result.Err.diagnostics, result.Err.message);
  if (!("Ok" in result))
    throw bindingError(
      "INVALID_TRANSPORT",
      "Rust binding returned an invalid result envelope",
    );
  return result.Ok as T;
}

export function mergeOptions(defaults: Options, supplied: Options): Options {
  const base = normalizeOptions(defaults);
  const override = normalizeOptions(supplied);
  const merged = Object.assign(Object.create(null), base, override);
  for (const key of optionSections)
    merged[key] = Object.assign(Object.create(null), base[key], override[key]);
  // Options are caller-owned too. Validate nested values and serialization hooks
  // before JSON.stringify can invoke them at the transport boundary.
  const metadata = Object.assign(Object.create(null), merged);
  // Virtual file contents have their own document limits and are checked while
  // makeRequest encodes each file, without adding option-envelope depth.
  delete metadata.files;
  encodeInput(metadata, { maxDocumentBytes: 128 * 1024 * 1024 });
  return merged as Options;
}

const optionSections = [
  "files",
  "retrievalAliases",
  "limits",
  "resolve",
  "validate",
  "dereference",
] as const;

function normalizeOptions(value: Options): Record<string, unknown> {
  const options = optionRecord(value);
  for (const key of optionSections) {
    const section = options[key];
    if (section !== undefined) options[key] = optionRecord(section);
  }
  return options;
}

function optionRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw bindingError(
      "INVALID_OPTIONS",
      "Parser option sections must be objects",
    );
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor))
      throw bindingError(
        "INVALID_OPTIONS",
        "Parser options cannot contain accessors or symbol keys",
      );
    if (descriptor.enumerable && descriptor.value !== undefined)
      record[key] = descriptor.value;
  }
  return record;
}

export function makeRequest(
  operation: Operation,
  input: Input,
  options: Options,
  native: boolean,
): TransportRequest {
  const {
    uri = "memory://octri/openapi.yaml",
    files,
    dereference,
    ...rest
  } = options;
  let source: TransportRequest["input"];
  if (typeof input === "string") {
    const text = input.trimStart();
    const isContent =
      input.includes("\n") ||
      text.startsWith("{") ||
      text.startsWith("[") ||
      /^(openapi|swagger)\s*:/.test(text);
    source = isContent
      ? { uri, content: input, generated: false }
      : {
          uri: native ? input : new URL(input, uri).href,
          content: null,
          generated: false,
        };
  } else {
    const uriValue =
      input !== null && typeof input === "object"
        ? Object.getOwnPropertyDescriptor(input, "uri")?.value
        : undefined;
    const content =
      input !== null && typeof input === "object"
        ? Object.getOwnPropertyDescriptor(input, "content")
        : undefined;
    const sourceEnvelope =
      typeof uriValue === "string" && content && "value" in content;
    const encoded = encodeInput(
      input,
      sourceEnvelope
        ? { ...options.limits, maxDocumentBytes: 128 * 1024 * 1024 }
        : options.limits,
    );
    if (sourceEnvelope) {
      source = {
        uri: uriValue,
        content:
          typeof content.value === "string"
            ? content.value
            : encodeInput(content.value, options.limits),
        generated: typeof content.value !== "string",
      };
    } else {
      source = { uri, content: encoded, generated: true };
    }
  }

  const circular =
    dereference?.circular === true
      ? "preserve"
      : dereference?.circular === false
        ? "error"
        : dereference?.circular;
  return {
    operation,
    input: source,
    options: {
      ...rest,
      files:
        files &&
        Object.fromEntries(
          Object.entries(files).map(([path, value]) => [
            path,
            typeof value === "string"
              ? value
              : encodeInput(value, options.limits),
          ]),
        ),
      dereference: dereference && { ...dereference, circular },
    },
  };
}

export function createParser(transport: Transport, native: boolean) {
  async function document(
    operation: Operation,
    input: Input,
    options: Options = {},
  ): Promise<Document> {
    const request = makeRequest(
      operation,
      input,
      mergeOptions({}, options),
      native,
    );
    const result = decodeResult<{
      document: Document | null;
      graph?: Pick<Graph, "root" | "nodes">;
    }>(await transport(JSON.stringify(request), "document"));
    return result.graph ? materialize(result.graph) : result.document!;
  }
  return class OpenAPIParser {
    api: Document | null = null;
    document: Document | null = null;
    diagnostics: Diagnostic[] = [];
    sources: Report["sources"] = [];
    references: Report["references"] = [];
    inspection?: Inspection;
    dialect: Report["dialect"] = null;
    $refs = new ReferenceRegistry();
    #busy = false;
    constructor(readonly defaults: Options = {}) {}

    async #run(
      operation: Operation,
      input: Input,
      supplied: Options,
    ): Promise<Report> {
      if (this.#busy)
        throw bindingError(
          "CONCURRENT_OPERATION",
          "Use separate parser instances concurrently",
        );
      this.#busy = true;
      this.api = null;
      this.$refs = new ReferenceRegistry();
      this.document = null;
      this.diagnostics = [];
      this.sources = [];
      this.references = [];
      this.inspection = undefined;
      this.dialect = null;
      try {
        const request = makeRequest(
          operation,
          input,
          mergeOptions(this.defaults, supplied),
          native,
        );
        const envelope = parseJson(
          await transport(JSON.stringify(request)),
        ) as {
          Ok?: Report;
          Err?: { message: string; diagnostics: Diagnostic[] };
        };
        if (envelope.Err) {
          this.diagnostics = envelope.Err.diagnostics;
          throw new OpenAPIError(
            envelope.Err.diagnostics,
            envelope.Err.message,
          );
        }
        const result = envelope.Ok && restoreReport(envelope.Ok);
        if (!result)
          throw bindingError(
            "INVALID_TRANSPORT",
            "Rust binding returned an invalid result envelope",
          );
        this.document =
          (result.sources.find(
            (source) => source.uri === result.registry.rootUri,
          )?.document as Document) ?? null;
        this.$refs = new ReferenceRegistry(result);
        this.api = result.graph ? materialize(result.graph) : result.document;
        this.diagnostics = result.diagnostics;
        this.sources = result.sources;
        this.references = result.references;
        this.inspection = result.inspection;
        this.dialect = result.dialect;
        return result;
      } finally {
        this.#busy = false;
      }
    }
    async parse(input: Input, options: Options = {}): Promise<Document> {
      await this.#run("parse", input, options);
      return this.api!;
    }
    async resolve(
      input: Input,
      options: Options = {},
    ): Promise<ReferenceRegistry> {
      await this.#run("resolve", input, options);
      return this.$refs;
    }
    async bundle(input: Input, options: Options = {}): Promise<Document> {
      await this.#run("bundle", input, options);
      return this.api!;
    }
    async dereference(input: Input, options: Options = {}): Promise<Document> {
      await this.#run("dereference", input, options);
      return this.api!;
    }
    async validate(input: Input, options: Options = {}): Promise<Document> {
      await this.#run("validate", input, options);
      return this.api!;
    }
    async inspect(input: Input, options: Options = {}): Promise<Inspection> {
      return (await this.#run("inspect", input, options)).inspection!;
    }
    async analyze(input: Input, options: Options = {}): Promise<Report> {
      try {
        return await this.#run("analyze", input, options);
      } catch (error) {
        if (!(error instanceof OpenAPIError)) throw error;
        return {
          valid: false,
          dialect: this.dialect,
          document: this.document,
          diagnostics: error.diagnostics,
          sources: this.sources,
          references: this.references,
          registry: { rootUri: "", resources: {}, anchors: {} },
        };
      }
    }
    static parse(input: Input, options?: Options) {
      return this === OpenAPIParser
        ? document("parse", input, options)
        : new this().parse(input, options);
    }
    static resolve(input: Input, options?: Options) {
      return new this().resolve(input, options);
    }
    static bundle(input: Input, options?: Options) {
      return this === OpenAPIParser
        ? document("bundle", input, options)
        : new this().bundle(input, options);
    }
    static dereference(input: Input, options?: Options) {
      return this === OpenAPIParser
        ? document("dereference", input, options)
        : new this().dereference(input, options);
    }
    static validate(input: Input, options?: Options) {
      return this === OpenAPIParser
        ? document("validate", input, options)
        : new this().validate(input, options);
    }
    static inspect(input: Input, options?: Options) {
      return new this().inspect(input, options);
    }
    static analyze(input: Input, options?: Options) {
      return new this().analyze(input, options);
    }
  };
}
