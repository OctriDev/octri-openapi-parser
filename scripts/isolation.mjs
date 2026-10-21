import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { specification } from "./workloads.mjs";
import { performance } from "node:perf_hooks";

const image = process.env.OCTRI_CHECK_IMAGE ?? "octri-parser-check:local";
const results = [];
function container(
  name,
  input,
  args,
  timeout = 15000,
  entrypoint = "/parser/target/release/octri-openapi",
) {
  const id = `octri-parser-check-${randomUUID()}`;
  let result;
  let elapsedMs;
  let oomKilled = false;
  try {
    const created = spawnSync(
      "docker",
      [
        "create",
        "--name",
        id,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "65534:65534",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "-i",
        "--entrypoint",
        entrypoint,
        image,
        ...args,
      ],
      { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" },
    );
    if (created.error) throw created.error;
    assert.equal(created.status, 0, created.stderr);
    const started = performance.now();
    result = spawnSync("docker", ["start", "--attach", "--interactive", id], {
      input,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    elapsedMs = performance.now() - started;
    if (entrypoint === "node")
      oomKilled =
        spawnSync(
          "docker",
          ["inspect", "--format", "{{.State.OOMKilled}}", id],
          { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" },
        ).stdout?.trim() === "true";
  } finally {
    // Killing the Docker client alone does not kill its container. Always remove
    // the named workload, including timeout/error paths, before accepting another.
    const removed = spawnSync("docker", ["rm", "--force", id], {
      stdio: "ignore",
      timeout: 15000,
      killSignal: "SIGKILL",
    });
    assert.equal(removed.status, 0, `${name}: workload cleanup failed`);
  }
  if (entrypoint === "sleep") {
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert(
      elapsedMs < timeout + 5000,
      "Supervisor deadline did not return promptly",
    );
    results.push({ name, supervisorDeadlineEnforced: true, elapsedMs });
    return;
  }
  if (result.error) throw result.error;
  if (entrypoint === "node") {
    assert.equal(result.status, 137);
    assert.equal(oomKilled, true);
    results.push({ name, memoryLimitEnforced: true });
    return;
  }
  assert.notEqual(result.status, 137, `${name}: container hit memory limit`);
  const text = result.stdout || result.stderr;
  assert(text, `${name}: no structured output`);
  const report = JSON.parse(text);
  results.push({
    name,
    status: result.status,
    valid: report.valid,
    codes: report.diagnostics?.map((diagnostic) => diagnostic.code) ?? [],
  });
}

container("healthy", JSON.stringify(specification(50)), [
  "analyze",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
  "--strict",
]);
assert.equal(results.at(-1).valid, true);
container("deep-json", "[".repeat(129) + "0" + "]".repeat(129), [
  "analyze",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
]);
assert(results.at(-1).codes.includes("LIMIT_DEPTH"));
container("deep-transport", "[".repeat(512) + "0" + "]".repeat(512), [
  "analyze",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
]);
assert(results.at(-1).codes.includes("LIMIT_TRANSPORT_STRUCTURE"));
container("duplicate-json", '{"openapi":"3.1.2","openapi":"3.1.2"}', [
  "analyze",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
]);
assert(results.at(-1).codes.includes("DUPLICATE_KEY"));
const fileProbe = specification(1);
fileProbe.components.schemas.Pet = { $ref: "file:///etc/passwd" };
container("file-denied", JSON.stringify(fileProbe), [
  "analyze",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
]);
assert.equal(results.at(-1).valid, false);
assert(results.at(-1).codes.includes("RESOLVER_DENIED"));
const expanded = specification(0);
expanded.components.schemas.S0 = { type: "string" };
for (let index = 1; index < 20; index++)
  expanded.components.schemas[`S${index}`] = {
    type: "object",
    properties: {
      left: { $ref: `#/components/schemas/S${index - 1}` },
      right: { $ref: `#/components/schemas/S${index - 1}` },
    },
  };
container("shared-expansion", JSON.stringify(expanded), [
  "dereference",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
  "--max-nodes",
  "1000",
  "--max-output-bytes",
  "1000000",
]);
assert(results.at(-1).codes.includes("LIMIT_OUTPUT_NODES"));
container("supervisor-deadline", "", ["60"], 500, "sleep");
container(
  "supervisor-memory",
  "",
  [
    "-e",
    "const chunks = []; for (;;) chunks.push(Buffer.alloc(16 * 1024 * 1024, 1));",
  ],
  15000,
  "node",
);
container("healthy-after-failures", JSON.stringify(specification(50)), [
  "analyze",
  "-",
  "--base-uri",
  "memory://isolated/input.json",
]);
assert.equal(results.at(-1).valid, true);
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/isolation.json",
  JSON.stringify(
    {
      image,
      limits: {
        memoryMiB: 128,
        cpus: 1,
        pids: 64,
        network: "none",
        readOnly: true,
        user: "65534:65534",
      },
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Restricted Linux containers: bounded failures, denied retrieval, deadline cleanup and recovery passed.",
);
