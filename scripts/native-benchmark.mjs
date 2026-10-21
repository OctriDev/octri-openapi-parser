import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { rustEnvironment } from "./toolchain.mjs";

const env = rustEnvironment();
execFileSync(
  "cargo",
  ["build", "--release", "--locked", "-p", "octri-parser-cli"],
  { env, stdio: "inherit" },
);
const output = execFileSync(
  "cargo",
  [
    "run",
    "--release",
    "--locked",
    "-p",
    "octri-parser",
    "--example",
    "benchmark",
    "--",
    process.argv[2] ?? "latest",
  ],
  {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 4 * 1024 * 1024,
  },
);
const report = JSON.parse(output);
report.rustc = execFileSync(env.RUSTC ?? "rustc", ["--version"], {
  env,
  encoding: "utf8",
}).trim();
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/native-benchmark.json",
  JSON.stringify(report, null, 2) + "\n",
);
for (const row of report.coreResults)
  console.log(
    `${row.mode} ${row.inputKind} ${row.operation}: core ${row.core.medianMs.toFixed(3)} ms; full report JSON ${row.fullReportEncoding.medianMs.toFixed(3)} ms`,
  );
for (const row of report.cliResults)
  console.log(
    `${row.mode} fresh CLI ${row.operation}: ${row.freshProcess.medianMs.toFixed(3)} ms`,
  );
for (const row of report.documentResults ?? [])
  console.log(
    `${row.mode} ${row.inputKind} ${row.operation}: document core ${row.core.medianMs.toFixed(3)} ms`,
  );
