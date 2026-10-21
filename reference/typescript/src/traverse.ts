import { childPointer, object, fail } from "./errors.js";
type Kind = "api" | "map" | "schema" | "schemaMap" | "schemaArray" | "literal";
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaSingles = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]);
const apiMaps = new Set([
  "paths",
  "webhooks",
  "callbacks",
  "responses",
  "content",
  "examples",
  "parameters",
  "headers",
  "requestBodies",
  "links",
  "securitySchemes",
  "pathItems",
]);
/** Traverse actual API/schema syntax, never interpreting examples or extensions as references. */
export function visitSyntax(
  value: unknown,
  visitor: (
    value: Record<string, unknown>,
    pointer: string,
    schema: boolean,
    base: string,
  ) => void,
  uri: string,
  opaque?: WeakSet<object>,
  startKind: Kind = "api",
): void {
  const active = new WeakSet<object>();
  let visits = 0;
  function walk(v: unknown, p: string, kind: Kind, base: string) {
    if (++visits > 500_000)
      fail("LIMIT_NODES", "Syntax traversal exceeds occurrence limit", {
        uri,
        pointer: p,
      });
    if (!v || typeof v !== "object") return;
    if (kind === "literal") {
      opaque?.add(v);
      return;
    }
    if (active.has(v)) return;
    active.add(v);
    if (
      kind === "api" &&
      object(v) &&
      !("openapi" in v) &&
      !("swagger" in v) &&
      !("in" in v) &&
      ([
        "$id",
        "$schema",
        "$defs",
        "properties",
        "allOf",
        "anyOf",
        "oneOf",
      ].some((k) => k in v) ||
        Array.isArray(v.type) ||
        [
          "object",
          "string",
          "number",
          "integer",
          "boolean",
          "null",
          "array",
        ].includes(String(v.type)))
    )
      kind = "schema";
    if (Array.isArray(v)) {
      v.forEach((n, i) =>
        walk(
          n,
          childPointer(p, i),
          kind === "schemaArray" ? "schema" : kind,
          base,
        ),
      );
    } else {
      if (
        kind === "schema" &&
        typeof (v as Record<string, unknown>).$id === "string"
      ) {
        try {
          base = new URL((v as Record<string, string>).$id!, base).href;
        } catch {
          /* validation reports invalid identifiers */
        }
      }
      const obj = v as Record<string, unknown>;
      if (kind !== "map" && kind !== "schemaMap")
        visitor(obj, p, kind === "schema", base);
      for (const [k, n] of Object.entries(obj)) {
        let next: Kind;
        if (kind === "schemaMap" || kind === "schemaArray") next = "schema";
        else if (kind === "map") next = "api";
        else if (kind === "schema")
          next = schemaMaps.has(k)
            ? "schemaMap"
            : schemaArrays.has(k)
              ? "schemaArray"
              : schemaSingles.has(k)
                ? "schema"
                : "literal";
        else if (k === "schemas" || k === "definitions") next = "schemaMap";
        else if (k === "schema") next = "schema";
        else if (
          k.startsWith("x-") ||
          ["example", "value", "default", "enum", "const"].includes(k)
        )
          next = "literal";
        else if (apiMaps.has(k) && object(n)) next = "map";
        else next = "api";
        walk(n, childPointer(p, k), next, base);
      }
    }
    active.delete(v);
  }
  walk(value, "", startKind, uri);
}
