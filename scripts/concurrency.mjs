import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import Parser from "../packages/node/dist/index.js";
import { specification, summarize } from "./workloads.mjs";

const results = [];
const batches = Number(process.env.OCTRI_SOAK_BATCHES ?? 32);
assert(
  Number.isSafeInteger(batches) && batches >= 16,
  "Soak requires at least 16 batches",
);
for (const concurrency of [1, 4, 8]) {
  const timings = [];
  const retainedRssBytes = [];
  for (let batch = 0; batch < batches; batch++) {
    const inputs = Array.from({ length: concurrency }, (_, index) => {
      const input = specification(500);
      input.info.title = `request-${batch}-${index}`;
      return input;
    });
    const started = performance.now();
    const parsers = inputs.map(() => new Parser());
    const reports = await Promise.all(
      inputs.map((input, index) =>
        parsers[index].analyze(input, {
          uri: `memory://request-${index}/openapi.json`,
        }),
      ),
    );
    timings.push(performance.now() - started);
    reports.forEach((report, index) => {
      assert.equal(report.valid, true);
      assert.equal(report.inspection.statistics.operations, 500);
      assert.equal(report.document.info.title, inputs[index].info.title);
      assert.equal(
        parsers[index].$refs.get("#/info/title"),
        inputs[index].info.title,
      );
      assert.equal(
        report.sources[0].uri,
        `memory://request-${index}/openapi.json`,
      );
    });
    reports.length = 0;
    parsers.length = 0;
    globalThis.gc?.();
    retainedRssBytes.push(process.memoryUsage().rss);
  }
  const earlier = Math.max(...retainedRssBytes.slice(-16, -8));
  const later = Math.max(...retainedRssBytes.slice(-8));
  assert(
    later <= earlier * 1.25 + 32 * 1024 * 1024,
    `${concurrency}: retained RSS did not stabilize within the regression budget`,
  );
  results.push({
    concurrency,
    batches: summarize(timings.slice(2)),
    retainedRssBytes,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  });
}

const shared = new Parser();
const first = shared.parse(specification(1000));
await assert.rejects(shared.parse(specification(1)), (error) =>
  error.diagnostics.some(
    (diagnostic) => diagnostic.code === "CONCURRENT_OPERATION",
  ),
);
await first;
assert.equal((await shared.analyze(specification(1))).valid, true);
await assert.rejects(shared.validate({ openapi: "4.0.0" }));
assert.equal((await shared.analyze(specification(1))).valid, true);

await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/concurrency.json",
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      sharedInstanceRejected: true,
      recoveredAfterFailure: true,
      notes:
        "Independent parser instances, unique roots/titles, 500 operations each; full reports returned. RSS is process memory including native allocator and GC retention, not live allocations. Final eight-batch RSS must stay within 25% plus 32 MiB of preceding eight batches; this is a bounded-growth regression check, not a general leak proof. First two batches excluded from latency summaries. Default libuv pool; concurrency is queued work, not guaranteed simultaneous native execution.",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Concurrent instances, source/registry isolation, busy rejection and recovery passed.",
);
