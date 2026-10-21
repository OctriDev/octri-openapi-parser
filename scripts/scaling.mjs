import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
const run = promisify(execFile);
const rows = [];
const quick = process.argv.includes("--quick");
const sizes = quick ? [50, 500] : [50, 500, 5000];
const cases = sizes.flatMap((operations) =>
  ["inline", "shared", "unique"].map((shape) => ({ operations, shape })),
);
cases.push({ operations: 32, shape: "external" });
for (const config of cases) {
  for (const operation of ["bundle", "dereference", "validate"]) {
    for (const engine of ["rust-node", "swagger-parser"]) {
      const request = {
        ...config,
        operation,
        engine,
        inputKind: "object",
        warmups: 3,
        runs: quick ? 5 : 11,
      };
      const { stdout } = await run(
        process.execPath,
        ["--expose-gc", "scripts/scale-case.mjs", JSON.stringify(request)],
        { timeout: 120000, maxBuffer: 1024 * 1024 },
      );
      const row = JSON.parse(stdout);
      rows.push(row);
      console.log(
        `${engine} ${config.shape}/${config.operations} ${operation}: ${row.medianMs.toFixed(2)} ms; peak ${(row.peakRssBytes / 1048576).toFixed(1)} MiB`,
      );
    }
  }
}
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/scaling.json",
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      notes:
        "Each row runs in a fresh process; warm repeated calls include input cloning. Outputs are released and GC runs between calls, outside timing. Peak RSS is process high-water memory, including Node, imported comparator, fixtures, allocator retention and warmups; not per-call allocation. Retained RSS follows GC with outputs released. Supplied virtual files only, no host retrieval. Synthetic observations; not equal-work or general superiority claims.",
      results: rows,
    },
    null,
    2,
  ) + "\n",
);
