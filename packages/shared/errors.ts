import type { Diagnostic } from "./types.js";

export class OpenAPIError extends Error {
  constructor(
    readonly diagnostics: Diagnostic[],
    message = diagnostics[0]?.message ?? "Parser operation failed",
  ) {
    super(message);
    this.name = "OpenAPIError";
  }
}

export function bindingError(code: string, message: string): OpenAPIError {
  return new OpenAPIError([
    {
      code,
      severity: "error",
      message,
      location: { uri: "memory://octri/binding", pointer: "" },
    },
  ]);
}
