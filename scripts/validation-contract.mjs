import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Parser from "../packages/node/dist/index.js";

const fixtures = [
  ...JSON.parse(readFileSync("fixtures/cases.json", "utf8")),
  ...JSON.parse(readFileSync("fixtures/validation-cases.json", "utf8")),
];
const results = [];
for (const fixture of fixtures) {
  const compatible = await Parser.analyze(
    structuredClone(fixture.input),
    fixture.options ?? {},
  );
  const strict = await Parser.analyze(structuredClone(fixture.input), {
    ...fixture.options,
    validate: { ...fixture.options?.validate, mode: "strict" },
  });
  assert.equal(strict.valid, fixture.valid, `${fixture.name}: strict`);
  results.push({
    fixture: fixture.name,
    compatibleValid: compatible.valid,
    strictValid: strict.valid,
  });
}

const document = {
  openapi: "3.1.2",
  info: { title: "Pets", version: "1" },
  paths: {},
  components: {
    schemas: {
      Pet: { type: "object", properties: { name: { type: "string" } } },
      A: { $ref: "#/components/schemas/Pet" },
      B: { $ref: "#/components/schemas/Pet" },
    },
  },
};
const original = structuredClone(document);
const dereferenced = await Parser.dereference(document);
assert.deepEqual(document, original);
assert.equal(
  dereferenced.components.schemas.A,
  dereferenced.components.schemas.B,
  "shared references retain object identity",
);

const cycle = {
  ...document,
  components: {
    schemas: {
      Tree: {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Tree" } },
      },
    },
  },
};
const tree = (await Parser.dereference(cycle)).components.schemas.Tree;
assert.equal(tree.properties.child, tree, "cycles retain root identity");

const siblings = {
  ...document,
  components: {
    schemas: {
      A: { type: "string", maxLength: 2 },
      B: { $ref: "#/components/schemas/A", maxLength: 10 },
    },
  },
};
const sibling = (await Parser.dereference(siblings)).components.schemas.B;
assert.equal(sibling.allOf[0].maxLength, 2);
assert.equal(sibling.maxLength, 10);

const literalReference = fixtures.find(
  (fixture) => fixture.name === "literal-reference",
);
const literalDocument = await Parser.dereference(literalReference.input);
assert.deepEqual(
  literalDocument.components.schemas.Pet.example,
  literalReference.input.components.schemas.Pet.example,
);
assert.deepEqual(
  literalDocument.components.schemas.Pet.default,
  literalReference.input.components.schemas.Pet.default,
);
assert.deepEqual(
  literalDocument.components.schemas.Pet["x-extra"],
  literalReference.input.components.schemas.Pet["x-extra"],
);

const missingVersion = structuredClone(
  fixtures.find((fixture) => fixture.name === "missing-info-version").input,
);
const repaired = await Parser.validate(missingVersion);
assert.equal(repaired.info.version, "0.1.0");
assert.equal(missingVersion.info.version, undefined, "input remains unchanged");

const external = {
  ...document,
  components: { schemas: { A: { $ref: "pet.json" }, B: { $ref: "pet.json" } } },
};
const files = {
  "pet.json": { type: "object", properties: { name: { type: "string" } } },
};
const bundled = await Parser.bundle(external, { files });
const relocated = "memory://fresh/moved.json";
const moved = await Parser.dereference({ uri: relocated, content: bundled });
const { $id: resourceId, ...shape } = moved.components.schemas.A;
assert.equal(typeof resourceId, "string");
assert.deepEqual(moved.components.schemas.B, moved.components.schemas.A);
assert.deepEqual(
  (await Parser.dereference({ uri: relocated, content: bundled })).components
    .schemas.A,
  moved.components.schemas.A,
);

const transformations = {
  sharedIdentity: true,
  circularTopology: true,
  siblingConstraints: sibling,
  defaultInfoVersion: repaired.info.version,
  importedResourceId: resourceId,
  importedResourceShape: shape,
  externalBundlePortable: true,
};
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/validation-contract.json",
  JSON.stringify({ results, transformations }, null, 2) + "\n",
);
console.log(
  `${results.length} fixture contracts; graph, defaults, and external bundle contracts passed.`,
);
