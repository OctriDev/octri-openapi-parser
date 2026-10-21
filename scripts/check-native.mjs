import { execFileSync } from "node:child_process";

function node(...args) {
  execFileSync(process.execPath, args, { stdio: "inherit" });
}
function npm(...args) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("Run with npm run check:native");
  node(cli, ...args);
}
node("scripts/verify-schemas.mjs");
node("scripts/cargo.mjs", "fmt", "--all", "--", "--check");
node(
  "scripts/cargo.mjs",
  "clippy",
  "--workspace",
  "--all-targets",
  "--locked",
  "--",
  "-D",
  "warnings",
);
node("scripts/cargo.mjs", "test", "--workspace", "--locked");
npm("run", "build:node");
npm("run", "test:node");
npm("run", "build", "--prefix", "reference/typescript");
for (const check of [
  "test:parity",
  "test:swagger",
  "test:validation-contract",
  "test:concurrency",
  "format:check",
])
  npm("run", check);
