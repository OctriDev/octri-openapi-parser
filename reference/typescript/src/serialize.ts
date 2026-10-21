import { stringify } from "yaml";
import { fail } from "./errors.js";
export function serialize(
  value: unknown,
  format: "json" | "yaml" = "json",
  options: { maxBytes?: number; indent?: number } = {},
): string {
  const active = new WeakSet<object>();
  let estimate = 0;
  let nodes = 0;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  function check(v: unknown, depth: number) {
    if (++nodes > 1_000_000)
      fail("LIMIT_OUTPUT_NODES", "Expanded output exceeds node limit", {
        uri: "memory://output/",
        pointer: "",
      });
    if (typeof v === "string")
      estimate += new TextEncoder().encode(JSON.stringify(v)).length;
    else if (v === null || v === undefined) estimate += 4;
    else if (typeof v !== "object") estimate += String(v).length;
    if (estimate > maxBytes)
      fail("LIMIT_OUTPUT_BYTES", "Expanded output exceeds byte limit", {
        uri: "memory://output/",
        pointer: "",
      });
    if (!v || typeof v !== "object") return;
    if (depth > 1000)
      fail("OUTPUT_DEPTH", "Output exceeds serialization nesting limit", {
        uri: "memory://output/",
        pointer: "",
      });
    if (active.has(v))
      fail(
        "CIRCULAR_OUTPUT",
        'Cyclic document cannot be serialized; use bundle() or dereference.circular: "ignore"',
        { uri: "memory://output/", pointer: "" },
      );
    active.add(v);
    estimate += 2;
    for (const [k, n] of Object.entries(v)) {
      if (!Array.isArray(v))
        estimate += new TextEncoder().encode(JSON.stringify(k)).length + 1;
      check(n, depth + 1);
    }
    active.delete(v);
  }
  check(value, 0);
  let text: string;
  try {
    text =
      format === "json"
        ? JSON.stringify(value, null, options.indent ?? 2) + "\n"
        : stringify(value, { aliasDuplicateObjects: false, lineWidth: 100 });
  } catch (e) {
    fail("SERIALIZATION_ERROR", (e as Error).message, {
      uri: "memory://output/",
      pointer: "",
    });
  }
  if (new TextEncoder().encode(text).length > maxBytes)
    fail("LIMIT_OUTPUT_BYTES", "Serialized output exceeds byte limit", {
      uri: "memory://output/",
      pointer: "",
    });
  return text;
}
