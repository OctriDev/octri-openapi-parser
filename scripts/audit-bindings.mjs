import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter } from "node:path";

const build = JSON.parse(readFileSync("artifacts/bindings/build.json", "utf8"));
const packages = build.dependencies.split(delimiter).map((path) => {
  const name = basename(path);
  const match = name.match(
    /^(jackson-(?:databind|core|annotations))-(.+)\.jar$/,
  );
  assert(match, `Review unexpected JVM runtime dependency: ${name}`);
  return {
    package: {
      ecosystem: "Maven",
      name: `com.fasterxml.jackson.core:${match[1]}`,
    },
    version: match[2],
  };
});
packages.push({
  package: { ecosystem: "Maven", name: "org.jetbrains.kotlin:kotlin-stdlib" },
  version: "2.3.21",
});
const response = await fetch("https://api.osv.dev/v1/querybatch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ queries: packages }),
  signal: AbortSignal.timeout(30000),
});
assert(response.ok, `Advisory lookup failed: ${response.status}`);
const result = await response.json();
assert.equal(result.results?.length, packages.length);
writeFileSync(
  "artifacts/bindings/jvm-advisories.json",
  JSON.stringify(
    { checkedAt: new Date().toISOString(), packages, response: result },
    null,
    2,
  ) + "\n",
);
for (const [index, entry] of result.results.entries())
  assert.equal(
    entry.vulns?.length ?? 0,
    0,
    `${packages[index].package.name}: unresolved advisories ${JSON.stringify(entry.vulns)}`,
  );
console.log(
  `${packages.length} JVM runtime dependencies: no known OSV advisories`,
);
