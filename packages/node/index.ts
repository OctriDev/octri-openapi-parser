import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const binding = require("../load-native.cjs")() as {
  execute(request: string): Promise<string>;
  executeDocument(request: string): Promise<string>;
  serializeDocument(
    document: string,
    format: string,
    limits: string,
  ): Promise<string>;
};
export const OpenAPIParser = createParser(
  (request, projection) =>
    projection === "document"
      ? binding.executeDocument(request)
      : binding.execute(request),
  true,
);
export default OpenAPIParser;

/** Serialize through the Rust writer, with cycle and expansion limits. */
export async function serialize(
  document: unknown,
  format: "json" | "yaml" = "json",
  limits: import("../shared/types.js").Limits = {},
): Promise<string> {
  return decodeResult<string>(
    await binding.serializeDocument(
      encodeDocument(document, limits),
      format,
      JSON.stringify(limits),
    ),
  );
}
