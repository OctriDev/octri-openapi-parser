import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import P from "../packages/node/dist/index.js";

const manifest = JSON.parse(readFileSync("reference/manifest.json", "utf8"));
for (const [path, expected] of Object.entries(manifest)) {
  const actual = createHash("sha256")
    .update(readFileSync(`reference/typescript/${path}`))
    .digest("hex");
  assert.equal(actual, expected, `TypeScript reference changed: ${path}`);
}
const { default: Reference } =
  await import("../reference/typescript/dist/index.js");
const fixtures = JSON.parse(readFileSync("fixtures/cases.json", "utf8"));
const rows = [];
for (const fixture of fixtures) {
  const options = fixture.options ?? {};
  const [native, reference] = await Promise.all([
    P.analyze(fixture.input, {
      ...options,
      validate: { ...options.validate, mode: "strict" },
    }),
    Reference.analyze(fixture.input, options),
  ]);
  assert.equal(
    native.valid,
    fixture.valid,
    `${fixture.name}: Rust diagnostics: ${JSON.stringify(native.diagnostics)}`,
  );
  assert.equal(
    native.valid,
    reference.valid,
    `${fixture.name}: TS=${JSON.stringify(reference.diagnostics)}, Rust=${JSON.stringify(native.diagnostics)}`,
  );
  if (native.inspection && reference.inspection) {
    assert.deepEqual(
      native.inspection.operations
        .map((o) => [o.method, o.path, o.kind, o.operationId])
        .sort(),
      reference.inspection.operations
        .map((o) => [o.method, o.path, o.kind, o.operationId])
        .sort(),
      fixture.name,
    );
  }
  rows.push({
    fixture: fixture.name,
    valid: native.valid,
    operationCount: native.inspection?.statistics.operations ?? 0,
    nativeDiagnostics: native.diagnostics.map((d) => d.code),
    referenceDiagnostics: reference.diagnostics.map((d) => d.code),
  });
}
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/parity.json",
  JSON.stringify(
    {
      validationMode: "strict",
      referenceFilesVerified: Object.keys(manifest).length,
      fixtures: rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `${rows.length} parity fixtures passed; ${Object.keys(manifest).length} reference files unchanged.`,
);
