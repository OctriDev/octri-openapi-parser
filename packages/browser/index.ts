import init, {
  execute,
  execute_document,
  serialize_document,
} from "../pkg/octri_parser.js";
import {
  createParser,
  decodeResult,
  encodeDocument,
} from "../shared/parser.js";
export {
  OpenAPIError,
  ReferenceRegistry,
  LosslessNumber,
  parseJson,
} from "../shared/parser.js";
export type * from "../shared/types.js";

let initialization: Promise<unknown> | undefined;
/** Initialize once. Pass an explicit WASM module or response for custom hosting. */
export function initialize(input?: unknown): Promise<unknown> {
  return (initialization ??= init(input).catch((error) => {
    initialization = undefined;
    throw error;
  }));
}
export const OpenAPIParser = createParser(async (request, projection) => {
  await initialize();
  return projection === "document"
    ? execute_document(request)
    : execute(request);
}, false);
export default OpenAPIParser;

export async function serialize(
  document: unknown,
  format: "json" | "yaml" = "json",
  limits: import("../shared/types.js").Limits = {},
): Promise<string> {
  const text = encodeDocument(document, limits);
  await initialize();
  return decodeResult<string>(
    serialize_document(text, format, JSON.stringify(limits)),
  );
}
