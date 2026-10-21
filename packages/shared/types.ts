export type Document = Record<string, unknown>;
export type Input =
  string | Document | { uri: string; content: string | Document };
export type Operation =
  | "parse"
  | "resolve"
  | "bundle"
  | "dereference"
  | "validate"
  | "inspect"
  | "analyze";
export interface Address {
  uri: string;
  pointer: string;
}
export interface Location extends Address {
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
export interface Limits {
  maxDocumentBytes?: number;
  maxTotalBytes?: number;
  maxDocuments?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxAliases?: number;
  maxOutputBytes?: number;
  maxDiagnostics?: number;
}
export interface Options {
  rootFormat?: "auto" | "json" | "yaml";
  uri?: string;
  files?: Record<string, string | Document>;
  /** Checked retrieval redirects. Virtual files must use final URI keys. */
  retrievalAliases?: Record<string, string>;
  limits?: Limits;
  resolve?: {
    external?: boolean;
    fileRoot?: string;
    http?: boolean;
    allowHosts?: string[];
    allowPrivate?: boolean;
    timeoutMs?: number;
    maxRedirects?: number;
  };
  validate?: {
    mode?: "compatible" | "strict";
    schema?: boolean;
    spec?: boolean;
  };
  dereference?: {
    circular?: "preserve" | "ignore" | "error" | boolean;
    cloneReferences?: boolean;
  };
}
export interface SourceDocument {
  uri: string;
  text: string;
  document: unknown;
  locations: Record<string, Location>;
  bytes: number;
  generated: boolean;
}
export interface ReferenceEdge {
  from: Location;
  ref: string;
  kind: "$ref" | "$dynamicRef";
  target?: Location;
  resolved: boolean;
}
export interface ApiOperation {
  /** Fixed fields use uppercase; additionalOperations keys retain exact case. */
  method: string;
  path: string;
  kind: "path" | "webhook" | "callback";
  operationId?: string;
  summary?: string;
  description?: string;
  extensions?: Record<string, unknown>;
  tags: string[];
  deprecated: boolean;
  location: Location;
  parameters: Document[];
  security: unknown[];
  servers: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}
export interface Inspection {
  dialect: "swagger2" | "openapi3.0" | "openapi3.1" | "openapi3.2";
  version: string;
  info: Document;
  operations: ApiOperation[];
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
export type GraphNode =
  | { kind: "object"; value: Record<string, number> }
  | { kind: "array"; value: number[] }
  | { kind: "scalar"; value: unknown };
export interface Graph {
  root: number;
  nodes: GraphNode[];
  origins: Address[];
  circular: boolean;
}
export interface Report {
  valid: boolean;
  dialect: Inspection["dialect"] | null;
  document: Document | null;
  diagnostics: Diagnostic[];
  sources: SourceDocument[];
  references: ReferenceEdge[];
  registry: {
    rootUri: string;
    rootDocument?: Document;
    resources: Record<string, Address>;
    anchors: Record<string, Address>;
    retrievalAliases?: Record<string, string>;
  };
  inspection?: Inspection;
  graph?: Graph;
}
export interface TransportRequest {
  operation: Operation;
  input: { uri: string; content: string | null; generated: boolean };
  options: Record<string, unknown>;
}
export type Transport = (
  request: string,
  projection?: "document",
) => Promise<string>;
