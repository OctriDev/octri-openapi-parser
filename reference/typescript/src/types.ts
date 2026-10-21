export type Document = Record<string, unknown>;
export type Dialect = "swagger2" | "openapi3.0" | "openapi3.1" | "openapi3.2";
export type Input =
  string | Document | { uri: string; content: string | Document };
export interface Location {
  uri: string;
  pointer: string;
  line?: number;
  column?: number;
  offset?: number;
}
export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  location: Location;
  related?: Location[];
}
export interface SourceDocument {
  uri: string;
  text?: string;
  document: unknown;
  locations: Map<string, Location>;
  bytes: number;
}
export interface Limits {
  maxDocumentBytes: number;
  maxTotalBytes: number;
  maxDocuments: number;
  maxNodes: number;
  maxDepth: number;
  maxAliases: number;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface HttpOptions {
  allowHosts?: string[];
  allowPrivate?: boolean;
  headers?: Record<string, string>;
  maxRedirects?: number;
  timeoutMs?: number;
}
export interface ReadContext {
  signal: AbortSignal;
  maxBytes: number;
  rootUri: string;
  options: ParserOptions;
}
export interface ResolverPlugin {
  name: string;
  canRead(uri: string): boolean;
  read(uri: string, context: ReadContext): Promise<string>;
}
export interface ParserPlugin {
  name: string;
  canParse(uri: string, text: string): boolean;
  parse(text: string, uri: string): unknown;
}
export interface ParserOptions {
  uri?: string;
  files?: Record<string, string | Document>;
  resolve?: {
    external?: boolean;
    file?: boolean | { root: string };
    http?: boolean | HttpOptions;
    plugins?: ResolverPlugin[];
  };
  parse?: { plugins?: ParserPlugin[] };
  validate?: { schema?: boolean; spec?: boolean };
  dereference?: {
    circular?: boolean | "ignore";
    cloneReferences?: boolean;
    schemaSiblings?: "preserve" | "merge";
  };
  limits?: Partial<Limits>;
  continueOnError?: boolean;
  signal?: AbortSignal;
}
export interface Runtime {
  normalizeUri(value: string): string;
  read(uri: string, context: ReadContext): Promise<string>;
}
export interface ReferenceEdge {
  from: Location;
  ref: string;
  kind: "$ref" | "$dynamicRef";
  target?: Location;
  resolved: boolean;
}
export interface Operation {
  method: string;
  path: string;
  kind: "path" | "webhook" | "callback";
  operationId?: string;
  summary?: string;
  tags: string[];
  deprecated: boolean;
  location: Location;
  parameters: Document[];
  security: unknown[];
  servers: unknown[];
  requestBody?: unknown;
  responses: Document;
}
export interface Inspection {
  dialect: Dialect;
  version: string;
  info: Document;
  operations: Operation[];
  schemas: {
    name: string;
    location: Location;
    schema: unknown;
    usedBy: Location[];
  }[];
  securitySchemes: Document;
  references: ReferenceEdge[];
  statistics: {
    operations: number;
    paths: number;
    schemas: number;
    documents: number;
    references: number;
    unresolved: number;
  };
}
export interface Analysis {
  valid: boolean;
  dialect?: Dialect;
  document?: Document;
  diagnostics: Diagnostic[];
  sources: SourceDocument[];
  inspection?: Inspection;
}
export type Callback<T> = (error: Error | null, value?: T) => void;
