import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const run = promisify(execFile);
const manifest = JSON.parse(
  await readFile("fixtures/public-corpus.json", "utf8"),
);
const directory = resolve("artifacts/corpus-cache");
await mkdir(directory, { recursive: true });
const results = [];
const failures = [];
for (const entry of manifest.entries) {
  assert.match(entry.filename, /^[a-z]+\.(json|yaml)$/);
  const filename = resolve(directory, entry.filename);
  let bytes;
  try {
    bytes = await readFile(filename);
  } catch {
    assert.match(entry.url, /^https:\/\/raw\.githubusercontent\.com\//);
    const response = await fetch(entry.url, {
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(response.ok, true, `${entry.name}: download failed`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      bytes.length,
      entry.bytes,
      `${entry.name}: changed source size`,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
    );
    await writeFile(filename, bytes);
  }
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    entry.sha256,
    `${entry.name}: changed snapshot`,
  );
  const row = { name: entry.name, bytes: bytes.length, sha256: entry.sha256 };
  for (const mode of ["compatible", "strict"]) {
    const args = [
      "analyze",
      filename,
      "--max-document-bytes",
      "33554432",
      "--max-total-bytes",
      "134217728",
      "--max-nodes",
      "4000000",
      "--max-output-bytes",
      "134217728",
    ];
    if (mode === "strict") args.push("--strict");
    try {
      const { stdout } = await run("target/release/octri-openapi", args, {
        timeout: 90000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const report = JSON.parse(stdout);
      row[mode] = {
        valid: report.valid,
        errors: report.diagnostics.slice(0, 3),
        statistics: report.statistics,
      };
    } catch (error) {
      // analyze uses exit 1 for invalid reports; process failures remain errors.
      if (error.code !== 1 || !error.stdout) throw error;
      const report = JSON.parse(error.stdout);
      row[mode] = {
        valid: report.valid,
        errors: report.diagnostics.slice(0, 3),
        statistics: report.statistics,
      };
    }
  }
  for (const engine of ["node", "swagger"]) {
    const { stdout } = await run(
      process.execPath,
      [
        "--max-old-space-size=2048",
        "scripts/public-corpus-case.mjs",
        engine,
        filename,
      ],
      { timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
    );
    row[engine] = JSON.parse(stdout);
  }
  results.push(row);
  console.log(
    `${entry.name}: compatible=${row.compatible.valid} strict=${row.strict.valid} Node=${row.node.valid} Swagger=${row.swagger.valid}`,
  );
  if (entry.expected) {
    for (const engine of ["compatible", "strict", "node", "swagger"])
      if (row[engine].valid !== entry.expected[engine])
        failures.push(`${entry.name}: changed ${engine} validity`);
  } else if (!process.argv.includes("--record"))
    failures.push(`${entry.name}: unreviewed corpus expectation`);
}
await writeFile(
  "artifacts/public-corpus.json",
  JSON.stringify({ results, failures }, null, 2) + "\n",
);
assert.deepEqual(failures, []);
