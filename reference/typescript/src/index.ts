import { CoreParser } from "./parser.js";
import { nodeRuntime } from "./node-runtime.js";
import type { ParserOptions } from "./types.js";
export class OpenAPIParser extends CoreParser {
  constructor(options: ParserOptions = {}) {
    super(options, nodeRuntime);
  }
}
export { OpenAPIParser as default };
export { ReferenceRegistry } from "./parser.js";
export { OpenAPIError } from "./errors.js";
export { serialize } from "./serialize.js";
export { isPublicAddress } from "./node-runtime.js";
export type * from "./types.js";
