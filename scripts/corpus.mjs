import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(
  new URL("../reference/typescript/package.json", import.meta.url),
);
const Swagger = require("@apidevtools/swagger-parser");
const { default: Reference } =
  await import("../reference/typescript/dist/index.js");
const paths = process.argv.slice(2);
if (!paths.length)
  throw new Error("Usage: node scripts/corpus.mjs path/to/spec [more paths]");
const rows = [];
for (const file of paths) {
  const path = resolve(file);
  const start = performance.now();
  const processResult = spawnSync(
    "target/release/octri-openapi",
    [
      "analyze",
      path,
      "--max-document-bytes",
      "20971520",
      "--max-total-bytes",
      "67108864",
      "--max-nodes",
      "2000000",
      "--max-output-bytes",
      "104857600",
    ],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 120000 },
  );
  if (processResult.error) throw processResult.error;
  let native;
  try {
    native = JSON.parse(processResult.stdout);
  } catch {
    throw new Error(`${path}: CLI failed: ${processResult.stderr}`);
  }
  const nativeMs = performance.now() - start;
  const reference = await Reference.analyze(path, {
    limits: {
      maxDocumentBytes: 20971520,
      maxTotalBytes: 67108864,
      maxNodes: 2000000,
      maxOutputBytes: 104857600,
      timeoutMs: 120000,
    },
  });
  let swaggerValid = true;
  let swaggerError;
  try {
    await Swagger.validate(path, { resolve: { http: false } });
  } catch (error) {
    swaggerValid = false;
    swaggerError = error.message;
  }
  const row = {
    file: path,
    bytes: statSync(path).size,
    nativeValid: native.valid,
    referenceValid: reference.valid,
    swaggerValid,
    nativeMs: Number(nativeMs.toFixed(2)),
    statistics: native.statistics,
    diagnostics: native.diagnostics.map((d) => ({
      code: d.code,
      location: d.location,
      message: d.message,
    })),
    swaggerError,
  };
  rows.push(row);
  console.log(
    JSON.stringify({ ...row, diagnostics: row.diagnostics.slice(0, 3) }),
  );
  assert.equal(native.valid, reference.valid, `${path}: Rust and TS disagree`);
  assert.equal(native.valid, true, `${path}: selected valid corpus must pass`);
  if (native.dialect !== "openapi3.2")
    assert.equal(swaggerValid, true, `${path}: Swagger parity corpus failed`);
  globalThis.gc?.();
}
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/corpus.json",
  JSON.stringify(
    {
      limits: {
        maxDocumentBytes: 20971520,
        maxNodes: 2000000,
        maxOutputBytes: 104857600,
      },
      results: rows,
    },
    null,
    2,
  ) + "\n",
);
