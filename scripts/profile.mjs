import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  makeRequest,
  materialize,
} from "../packages/node/dist/shared/parser.js";
import { restoreReport } from "../packages/node/dist/shared/transport.js";
import { ReferenceRegistry } from "../packages/node/dist/shared/registry.js";
const require = createRequire(import.meta.url);
const binding = require("../packages/node/octri-parser.node");
const document = {
  openapi: "3.0.4",
  info: { title: "Benchmark", version: "1" },
  paths: {},
  components: {
    schemas: {
      Pet: { type: "object", properties: { id: { type: "string" } } },
    },
  },
};
for (let i = 0; i < 500; i++)
  document.paths[`/pets/${i}`] = {
    get: {
      operationId: `getPet${i}`,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
      },
    },
  };
const results = [];
for (const operation of ["parse", "bundle", "validate"]) {
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const timings = { operation };
    let start = performance.now();
    const request = makeRequest(operation, document, {}, true);
    timings.preflightMs = performance.now() - start;
    start = performance.now();
    const text = JSON.stringify(request);
    timings.requestEncodeMs = performance.now() - start;
    start = performance.now();
    const response = await binding.execute(text);
    timings.rustAndResponseEncodeMs = performance.now() - start;
    start = performance.now();
    const { Ok: encoded } = JSON.parse(response);
    const report = restoreReport(encoded);
    timings.responseDecodeMs = performance.now() - start;
    start = performance.now();
    const registry = new ReferenceRegistry(report);
    if (report.graph) materialize(report.graph);
    timings.facadeMs = performance.now() - start;
    timings.responseBytes = Buffer.byteLength(response);
    start = performance.now();
    timings.sourceNodes = report.sources.reduce(
      (count, source) => count + Object.keys(source.locations).length,
      0,
    );
    timings.sourceLocationsMs = performance.now() - start;
    if (i >= 3) samples.push(timings);
  }
  const row = { operation };
  for (const key of Object.keys(samples[0]).filter(
    (key) => key !== "operation",
  ))
    row[key] = Number(
      samples
        .map((row) => row[key])
        .sort((a, b) => a - b)[2]
        .toFixed(3),
    );
  results.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/profile.json",
  JSON.stringify(
    { node: process.version, warmups: 3, runs: 5, results },
    null,
    2,
  ) + "\n",
);
