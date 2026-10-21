/** Bounded exact JSON transport; source semantics remain in Rust. */
import { OpenAPIError, bindingError } from "./errors.js";
import type { Limits } from "./types.js";
import { encodeInput as encodeExact } from "./transport_json.mjs";

export function encodeInput(value: unknown, limits: Limits = {}): string {
  try {
    return encodeExact(value, limits);
  } catch (error) {
    if (
      error instanceof TypeError &&
      "code" in error &&
      typeof error.code === "string"
    )
      throw bindingError(error.code, error.message);
    throw error;
  }
}

export function encodeDocument(value: unknown, limits: Limits = {}): string {
  try {
    return encodeInput(value, {
      ...limits,
      maxDocumentBytes: limits.maxOutputBytes ?? 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof OpenAPIError) {
      if (error.diagnostics.some((d) => d.code === "CIRCULAR_INPUT"))
        throw bindingError(
          "CIRCULAR_SERIALIZATION",
          "Circular object cannot be serialized; bundle it or use circular: 'ignore'",
        );
      if (error.diagnostics.some((d) => d.code === "LIMIT_DOCUMENT_BYTES"))
        throw bindingError(
          "LIMIT_OUTPUT_BYTES",
          "Serialized object exceeds byte limit",
        );
    }
    throw error;
  }
}
