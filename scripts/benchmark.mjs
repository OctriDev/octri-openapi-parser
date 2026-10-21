import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import P from "../packages/node/dist/index.js";
const require = createRequire(
  new URL("../reference/typescript/package.json", import.meta.url),
);
const Swagger = require("@apidevtools/swagger-parser");
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
// Swagger treats a raw string as a path. Feed text through its resolver API so
// parsing stays inside the measured call, with no filesystem/network access.
const swaggerBenchmark = Object.fromEntries(
  ["parse", "bundle", "dereference", "validate"].map((operation) => [
    operation,
    (input) => {
      if (typeof input !== "string")
        return Swagger[operation](input, {
          resolve: { file: false, http: false },
        });
      const uri = "memory://benchmark/openapi.json";
      return Swagger[operation](uri, {
        resolve: {
          file: false,
          http: false,
          supplied: {
            order: 1,
            canRead: (file) => file.url === uri,
            read: () => input,
          },
        },
      });
    },
  ]),
);
const rows = [];
const warmups = 5;
const runs = 21;
const engines = [
  ["rust-node", P],
  ["swagger-parser", swaggerBenchmark],
];
for (const [inputKind, input] of [
  ["object", document],
  ["json-text", JSON.stringify(document)],
]) {
  for (const operation of ["parse", "bundle", "dereference", "validate"]) {
    const samples = new Map(engines.map(([name]) => [name, []]));
    // Rotate all engines through each position to reduce ordering/warmup bias.
    for (let iteration = -warmups; iteration < runs; iteration++) {
      const offset = (iteration + warmups) % engines.length;
      const order = [...engines.slice(offset), ...engines.slice(0, offset)];
      for (const [name, parser] of order) {
        const start = performance.now();
        await parser[operation](structuredClone(input));
        const elapsed = performance.now() - start;
        if (iteration >= 0) samples.get(name).push(elapsed);
      }
    }
    for (const [name] of engines) {
      const values = samples.get(name).sort((a, b) => a - b);
      rows.push({
        engine: name,
        operation,
        inputKind,
        medianMs: Number(values[Math.floor(runs / 2)].toFixed(2)),
        p10Ms: Number(values[Math.floor(runs * 0.1)].toFixed(2)),
        p90Ms: Number(values[Math.floor(runs * 0.9)].toFixed(2)),
        runs,
      });
    }
  }
}

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/benchmark.json",
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      operations: 500,
      warmups,
      order: "rotating engines per sample",
      octriValidationMode: "compatible",
      versions: {
        swaggerParser: require("@apidevtools/swagger-parser/package.json")
          .version,
      },
      bytes: Buffer.byteLength(JSON.stringify(document)),
      notes:
        "Includes fresh object clone for every call. Octri static methods use document-only Rust execution: no full source/inventory transport or successful source-position-map allocation; identical checks and limits, with text positions restored on failure. Input preflight, reference indexing, JSON bridge and identity graph reconstruction remain timed. Swagger text uses an isolated in-memory resolver. No cross-request caches. Synthetic workload; not a general speed claim.",
      results: rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(rows, null, 2));
