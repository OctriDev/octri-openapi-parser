import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import Parser from "../packages/node/dist/index.js";
const rootUri = "memory://benchmark/openapi.json";
import {
  specification,
  externalSpecification,
  summarize,
} from "./workloads.mjs";

const config = JSON.parse(process.argv[2]);
const require = createRequire(
  new URL("../reference/typescript/package.json", import.meta.url),
);
const Swagger = require("@apidevtools/swagger-parser");
const workload =
  config.shape === "external"
    ? externalSpecification(config.operations)
    : { input: specification(config.operations, config.shape), files: {} };
const text = JSON.stringify(workload.input);
const source = config.inputKind === "json-text" ? text : workload.input;
const baseline = process.memoryUsage().rss;
const files = new Map(
  Object.entries(workload.files).map(([name, content]) => [
    new URL(name, rootUri).href,
    content,
  ]),
);
files.set(rootUri, text);

async function execute(input) {
  if (config.engine === "rust-node")
    return Parser[config.operation](input, {
      files: workload.files,
      validate: { mode: config.mode ?? "compatible" },
    });
  return Swagger[config.operation](rootUri, {
    resolve: {
      file: false,
      http: false,
      supplied: {
        order: 1,
        canRead: (file) => files.has(file.url),
        read: (file) => (file.url === rootUri ? input : files.get(file.url)),
      },
    },
  });
}

const samples = [];
let last;
for (let index = 0; index < config.warmups + config.runs; index++) {
  const started = performance.now();
  last = await execute(structuredClone(source));
  const elapsed = performance.now() - started;
  assert.equal(Object.keys(last.paths).length, config.operations);
  if (index >= config.warmups) samples.push(elapsed);
  last = undefined;
  // Keep high-water memory from being dominated by an arbitrary V8 collection
  // threshold across a batch of otherwise independent requests. GC is untimed.
  globalThis.gc?.();
}
last = undefined;
globalThis.gc?.();
console.log(
  JSON.stringify({
    ...config,
    bytes: Buffer.byteLength(text),
    ...summarize(samples),
    baselineRssBytes: baseline,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    retainedRssBytes: process.memoryUsage().rss,
  }),
);
