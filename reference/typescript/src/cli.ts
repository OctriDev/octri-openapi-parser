#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { OpenAPIParser, OpenAPIError, serialize } from "./index.js";
import type { Input, ParserOptions } from "./types.js";
const help = `Octri OpenAPI Parser 1.0.0

Usage: octri-openapi <parse|validate|analyze|inspect|resolve|bundle|dereference> <file|url|-> [options]

  --format json|yaml       Output format (default json)
  --output PATH           Write output exclusively; stdout otherwise
  --force                 Permit overwriting an output file
  --base URI              Base URI for pasted/stdin content
  --allow-http            Enable public HTTP(S) loading
  --allow-host HOST       Restrict HTTP to these hosts (repeatable)
  --file-root PATH        Confine file references to this directory
  --no-files              Disable all filesystem input/resolution
  --circular true|false|ignore  Dereferencing cycle policy (default true)
  --max-bytes INTEGER     Maximum bytes per input document
  --timeout INTEGER       Total operation timeout in milliseconds
  --no-schema             Disable structural schema validation
  --no-spec               Disable additional semantic validation
  --help                  Show this help
  --version               Show version

Core library never silently converts dialects. JSON cannot represent cyclic
dereferenced graphs; use bundle or --circular ignore for serializable output.
`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: "string", default: "json" },
      output: { type: "string" },
      force: { type: "boolean" },
      base: { type: "string" },
      "allow-http": { type: "boolean" },
      "allow-host": { type: "string", multiple: true },
      "file-root": { type: "string" },
      "no-files": { type: "boolean" },
      circular: { type: "string", default: "true" },
      "max-bytes": { type: "string" },
      timeout: { type: "string" },
      "no-schema": { type: "boolean" },
      "no-spec": { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    process.stdout.write("1.0.0\n");
    return;
  }
  const [command, path, ...extra] = positionals;
  if (
    !command ||
    !path ||
    extra.length ||
    ![
      "parse",
      "validate",
      "analyze",
      "inspect",
      "resolve",
      "bundle",
      "dereference",
    ].includes(command)
  )
    throw new Error(help);
  if (!["json", "yaml"].includes(values.format))
    throw new Error("--format must be json or yaml");
  if (!["true", "false", "ignore"].includes(values.circular))
    throw new Error("--circular must be true, false or ignore");
  function integer(value: string | undefined) {
    if (value === undefined) return;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error("Limits must be positive integers");
    return n;
  }
  const bytes = integer(values["max-bytes"]),
    timeout = integer(values.timeout);
  const options: ParserOptions = {
    uri: values.base,
    resolve: {
      file: values["no-files"]
        ? false
        : values["file-root"]
          ? { root: values["file-root"] }
          : undefined,
      http: values["allow-http"] ? { allowHosts: values["allow-host"] } : false,
    },
    dereference: {
      circular:
        values.circular === "ignore" ? "ignore" : values.circular === "true",
    },
    validate: { schema: !values["no-schema"], spec: !values["no-spec"] },
    limits: {
      ...(bytes ? { maxDocumentBytes: bytes } : {}),
      ...(timeout ? { timeoutMs: timeout } : {}),
    },
  };
  let input: Input = path;
  if (path === "-") {
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const c of process.stdin) {
      count += c.length;
      if (count > (bytes ?? 5 * 1024 * 1024))
        throw new Error("stdin exceeds byte limit");
      chunks.push(c);
    }
    input = {
      uri: values.base ?? "memory://octri/stdin.yaml",
      content: Buffer.concat(chunks).toString("utf8"),
    };
  }
  const parser = new OpenAPIParser(options);
  let result: unknown;
  if (command === "validate") {
    const analysis = await parser.analyze(input);
    result = {
      valid: analysis.valid,
      dialect: analysis.dialect,
      diagnostics: analysis.diagnostics,
      statistics: analysis.inspection?.statistics,
    };
    if (!analysis.valid) process.exitCode = 1;
  } else if (command === "analyze") {
    const a = await parser.analyze(input);
    result = {
      ...a,
      sources: a.sources.map(({ uri, bytes }) => ({ uri, bytes })),
    };
    if (!a.valid) process.exitCode = 1;
  } else if (command === "resolve") {
    const refs = await parser.resolve(input);
    result = {
      documents: refs.paths(),
      references: parser.references,
      diagnostics: parser.diagnostics,
    };
  } else if (command === "inspect") result = await parser.inspect(input);
  else
    result = await parser[command as "parse" | "bundle" | "dereference"](input);
  const text = serialize(result, values.format as "json" | "yaml");
  if (values.output)
    await writeFile(values.output, text, { flag: values.force ? "w" : "wx" });
  else process.stdout.write(text);
}
main().catch((error) => {
  if (error instanceof OpenAPIError) {
    process.stderr.write(
      serialize({ valid: false, diagnostics: error.diagnostics }),
    );
    process.exitCode = error.diagnostics.some(
      (d) =>
        d.code.includes("SCHEMA") ||
        d.code.includes("PARAMETER") ||
        d.code === "DUPLICATE_OPERATION_ID",
    )
      ? 1
      : 2;
  } else {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
});
