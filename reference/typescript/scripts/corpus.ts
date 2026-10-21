import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import Swagger from "@apidevtools/swagger-parser";
import Parser from "../src/index.js";
import { lintFromString, createConfig } from "@redocly/openapi-core";
const config = await createConfig({
  rules: { struct: "error", "no-unresolved-refs": "error" },
});
const results = [];
for (const file of process.argv.slice(2)) {
  const size = (await readFile(file)).byteLength;
  const start = performance.now();
  const parser = new Parser({
    limits: {
      maxDocumentBytes: 20 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      maxNodes: 2_000_000,
      maxOutputBytes: 100 * 1024 * 1024,
      timeoutMs: 120_000,
    },
  });
  const analysis = await parser.analyze(file);
  let swaggerValid = true;
  let swaggerError: string | undefined;
  try {
    await Swagger.validate(file);
  } catch (e) {
    swaggerValid = false;
    swaggerError = (e as Error).message.slice(0, 500);
  }
  // Independent validator gets the original source; no external network is needed by this local corpus.
  let independent: unknown;
  try {
    const errors = await lintFromString({
      source: await readFile(file, "utf8"),
      absoluteRef: new URL("file://" + file).href,
      config,
    });
    independent = {
      valid: !errors.some((e) => e.severity === "error"),
      errors: errors
        .slice(0, 10)
        .map((e) => ({ code: e.ruleId, message: e.message })),
    };
  } catch (e) {
    independent = { error: (e as Error).message };
  }
  results.push({
    file,
    bytes: size,
    octri: {
      valid: analysis.valid,
      dialect: analysis.dialect,
      diagnostics: analysis.diagnostics.slice(0, 20),
      statistics: analysis.inspection?.statistics,
    },
    swagger: { valid: swaggerValid, error: swaggerError },
    independent,
    durationMs: +(performance.now() - start).toFixed(1),
  });
}
const output = {
  node: process.version,
  date: new Date().toISOString(),
  limits:
    "Explicit large-corpus profile: 20 MiB/document, 50 MiB total, 2M nodes, 100 MiB output, 120s timeout. Does not change library defaults.",
  results,
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
