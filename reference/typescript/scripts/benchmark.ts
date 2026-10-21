import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { readFile } from "node:fs/promises";
import Swagger from "@apidevtools/swagger-parser";
import Parser from "../src/index.js";
import type { Document } from "../src/types.js";
const paths: Document = {};
const models: Document = {};
for (let i = 0; i < 50; i++)
  models["Model" + i] = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 10 }, (_, j) => [
        "property" + j,
        {
          type: "string",
          description: "A documented property with a stable type.",
        },
      ]),
    ),
  };
for (let i = 0; i < 500; i++)
  paths["/resources/" + i] = {
    get: {
      operationId: "getResource" + i,
      summary: "Get resource " + i,
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Model" + (i % 50) },
            },
          },
        },
      },
    },
  };
const synthetic: Document = {
  openapi: "3.1.2",
  info: { title: "Benchmark", version: "1" },
  paths,
  components: { schemas: models },
};
const inputs: { name: string; input: Document | string; bytes: number }[] = [
  {
    name: "synthetic-500-operations-50-schemas",
    input: synthetic,
    bytes: JSON.stringify(synthetic).length,
  },
];
for (const path of process.argv.slice(2))
  inputs.push({
    name: path,
    input: path,
    bytes: (await readFile(path)).length,
  });
const report: unknown[] = [];
for (const entry of inputs)
  for (const method of ["parse", "bundle", "validate", "inspect"] as const) {
    for (const engine of ["octri", "swagger"] as const) {
      if (engine === "swagger" && method === "inspect") continue;
      const timings: number[] = [];
      let error: string | undefined;
      for (let n = 0; n < 6; n++) {
        const start = performance.now();
        try {
          if (engine === "octri") await Parser[method](entry.input);
          else
            await Swagger[method as "parse" | "bundle" | "validate"](
              structuredClone(entry.input) as never,
            );
        } catch (e) {
          error = (e as Error).message.slice(0, 300);
          break;
        }
        if (n) timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      report.push({
        input: entry.name,
        bytes: entry.bytes,
        engine,
        method,
        runs: timings.length,
        p50Ms: timings.length
          ? +timings[Math.floor(timings.length / 2)]!.toFixed(2)
          : undefined,
        p95Ms: timings.length ? +timings.at(-1)!.toFixed(2) : undefined,
        error,
      });
    }
  }
process.stdout.write(
  JSON.stringify(
    {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      date: new Date().toISOString(),
      notes:
        "One warmup plus five measured runs. p95 is maximum of five samples, not a statistically stable estimate. Octri performs extra source/provenance and semantic checks; workloads are not identical.",
      results: report,
    },
    null,
    2,
  ) + "\n",
);
