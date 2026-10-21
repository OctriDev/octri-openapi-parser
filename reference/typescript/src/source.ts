import {
  parseDocument,
  LineCounter,
  isMap,
  isSeq,
  isAlias,
  stringify,
} from "yaml";
import type { Node } from "yaml";
import type {
  Dialect,
  Limits,
  Location,
  ParserOptions,
  SourceDocument,
} from "./types.js";
import { fail, childPointer, object } from "./errors.js";
export const DEFAULT_LIMITS: Limits = {
  maxDocumentBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxDocuments: 100,
  maxNodes: 500_000,
  maxDepth: 200,
  maxAliases: 100,
  timeoutMs: 30_000,
  maxOutputBytes: 50 * 1024 * 1024,
};
export function assertTree(value: unknown, uri: string, limits: Limits): void {
  const seen = new WeakSet<object>();
  let count = 0;
  const stack: [unknown, string, number][] = [[value, "", 0]];
  while (stack.length) {
    const [v, p, depth] = stack.pop()!;
    if (++count > limits.maxNodes)
      fail("LIMIT_NODES", "Document exceeds node limit", { uri, pointer: p });
    if (depth > limits.maxDepth)
      fail("LIMIT_DEPTH", "Document exceeds nesting limit", {
        uri,
        pointer: p,
      });
    if (
      (typeof v === "number" && !Number.isFinite(v)) ||
      typeof v === "bigint" ||
      typeof v === "function" ||
      typeof v === "symbol" ||
      v === undefined
    )
      fail(
        "NON_JSON_VALUE",
        "OpenAPI input must contain JSON-compatible values",
        { uri, pointer: p },
      );
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    const proto = Object.getPrototypeOf(v);
    if (
      !Array.isArray(v) &&
      proto !== null &&
      (Object.prototype.toString.call(v) !== "[object Object]" ||
        Object.getPrototypeOf(proto) !== null)
    )
      fail("NON_JSON_VALUE", "Unsupported object prototype", {
        uri,
        pointer: p,
      });
    seen.add(v);
    for (const [k, n] of Object.entries(v)) {
      if (k === "__proto__")
        fail("UNSAFE_KEY", "The __proto__ key is not permitted", {
          uri,
          pointer: childPointer(p, k),
        });
      stack.push([n, childPointer(p, k), depth + 1]);
    }
  }
}
export function parseSource(
  uri: string,
  input: unknown,
  options: ParserOptions,
  limits: Limits,
): SourceDocument {
  const locations = new Map<string, Location>();
  let value: unknown = input;
  const text = typeof input === "string" ? input : undefined;
  if (text === undefined) assertTree(input, uri, limits);
  const bytes = new TextEncoder().encode(
    text ?? stringify(input, { aliasDuplicateObjects: true }),
  ).length;
  if (bytes > limits.maxDocumentBytes)
    fail("LIMIT_BYTES", "Document exceeds byte limit", { uri, pointer: "" });
  if (text !== undefined) {
    const plugin = options.parse?.plugins?.find((p) => p.canParse(uri, text));
    if (plugin) value = plugin.parse(text, uri);
    else {
      const lc = new LineCounter();
      const doc = parseDocument(text, {
        lineCounter: lc,
        uniqueKeys: true,
        version: "1.2",
        strict: true,
        merge: false,
      });
      const problem = doc.errors[0] ?? doc.warnings[0];
      if (problem) {
        const at = problem.pos[0];
        const pos = lc.linePos(at);
        fail("SYNTAX_ERROR", problem.message, {
          uri,
          pointer: "",
          offset: at,
          line: pos.line,
          column: pos.col,
        });
      }
      if (new URL(uri).pathname.endsWith(".json")) {
        try {
          JSON.parse(text);
        } catch (e) {
          fail("SYNTAX_ERROR", `Invalid JSON: ${(e as Error).message}`, {
            uri,
            pointer: "",
          });
        }
      }
      const pending: [Node | null, string, number][] = [
        [doc.contents as Node | null, "", 0],
      ];
      let seenNodes = 0;
      while (pending.length) {
        const [node, pointer, depth] = pending.pop()!;
        if (!node) continue;
        if (depth > limits.maxDepth)
          fail("LIMIT_DEPTH", "Document exceeds nesting limit", {
            uri,
            pointer,
          });
        if (++seenNodes > limits.maxNodes)
          fail("LIMIT_NODES", "Document exceeds node limit", { uri, pointer });
        const off = node.range?.[0];
        const pos = off === undefined ? undefined : lc.linePos(off);
        locations.set(pointer, {
          uri,
          pointer,
          ...(pos ? { line: pos.line, column: pos.col, offset: off } : {}),
        });
        if (isMap(node))
          for (const pair of node.items)
            pending.push([
              pair.value as Node | null,
              childPointer(pointer, String(pair.key)),
              depth + 1,
            ]);
        else if (isSeq(node))
          node.items.forEach((n, i) =>
            pending.push([
              n as Node | null,
              childPointer(pointer, i),
              depth + 1,
            ]),
          );
        else if (isAlias(node)) continue;
      }
      try {
        value = doc.toJS({ maxAliasCount: limits.maxAliases, mapAsMap: false });
      } catch (e) {
        fail("YAML_ALIAS_LIMIT", (e as Error).message, { uri, pointer: "" });
      }
    }
  } else value = structuredClone(input);
  assertTree(value, uri, limits);
  return { uri, text, document: value, locations, bytes };
}
export function detectDialect(value: unknown, uri: string): Dialect {
  if (!object(value))
    fail("INVALID_OPENAPI", "OpenAPI root must be an object", {
      uri,
      pointer: "",
    });
  if (value.swagger !== undefined && value.openapi !== undefined)
    fail("AMBIGUOUS_VERSION", "Declare swagger or openapi, not both", {
      uri,
      pointer: "",
    });
  if (value.swagger === "2.0") return "swagger2";
  if (typeof value.openapi === "string") {
    const m = /^3\.(0|1|2)\.\d+$/.exec(value.openapi);
    if (m) return `openapi3.${m[1]}` as Dialect;
  }
  fail(
    "UNSUPPORTED_VERSION",
    "Expected Swagger 2.0 or OpenAPI 3.0.x, 3.1.x, or 3.2.x (string version)",
    { uri, pointer: value.swagger !== undefined ? "/swagger" : "/openapi" },
  );
}
export function locate(source: SourceDocument, pointer: string): Location {
  return source.locations.get(pointer) ?? { uri: source.uri, pointer };
}
