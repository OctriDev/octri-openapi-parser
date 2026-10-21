import type { Diagnostic, Location } from "./types.js";
export class OpenAPIError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[], options?: ErrorOptions) {
    super(
      diagnostics
        .map((d) => `${d.location.uri}${d.location.pointer}: ${d.message}`)
        .join("\n"),
      options,
    );
    this.name = "OpenAPIError";
    this.diagnostics = diagnostics;
  }
  get code(): string {
    return this.diagnostics[0]?.code ?? "UNKNOWN";
  }
}
export function fail(
  code: string,
  message: string,
  location: Location,
  cause?: unknown,
): never {
  throw new OpenAPIError([{ code, message, severity: "error", location }], {
    cause,
  });
}
export function errorDiagnostics(error: unknown, uri: string): Diagnostic[] {
  if (error instanceof OpenAPIError) return error.diagnostics;
  const e = error as {
    errors?: unknown[];
    message?: string;
    source?: string;
    path?: string[];
    code?: string;
  };
  if (e.errors?.length)
    return e.errors.flatMap((x) => errorDiagnostics(x, uri));
  return [
    {
      code: e.code ?? "REFERENCE_ERROR",
      severity: "error",
      message: e.message ?? String(error),
      location: {
        uri: e.source ?? uri,
        pointer: e.path ? "/" + e.path.map(escapePointer).join("/") : "",
      },
    },
  ];
}
export const escapePointer = (s: string) =>
  s.replaceAll("~", "~0").replaceAll("/", "~1");
export const childPointer = (p: string, k: string | number) =>
  p + "/" + escapePointer(String(k));
export const refAddress = (l: Location) =>
  l.uri + "#" + l.pointer.split("/").map(encodeURIComponent).join("/");
export const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
