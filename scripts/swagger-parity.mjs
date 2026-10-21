import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import P from "../packages/node/dist/index.js";

const require = createRequire(
  new URL("../reference/typescript/package.json", import.meta.url),
);
const SwaggerParser = require("@apidevtools/swagger-parser");
const version = require("@apidevtools/swagger-parser/package.json").version;
assert.equal(
  version,
  "13.1.0",
  "Review comparator changes before updating its pinned version",
);
const root = "memory://octri/openapi.yaml";
const fixtures = JSON.parse(readFileSync("fixtures/cases.json", "utf8"));
function swaggerOptions(files = {}) {
  const documents = new Map(
    Object.entries(files).map(([uri, text]) => [
      new URL(uri, root).href,
      typeof text === "string" ? text : JSON.stringify(text),
    ]),
  );
  return {
    resolve: {
      file: false,
      http: false,
      supplied: {
        order: 1,
        canRead: () => true,
        read: (file) => {
          if (!documents.has(file.url))
            throw new Error(`Unsupplied Swagger fixture: ${file.url}`);
          return documents.get(file.url);
        },
      },
    },
  };
}
const results = [];
for (const fixture of fixtures) {
  const files = {
    ...fixture.options?.files,
    [root]:
      typeof fixture.input === "string"
        ? fixture.input
        : JSON.stringify(fixture.input),
  };
  let swaggerValid = true;
  let swaggerError;
  try {
    await SwaggerParser.validate(root, swaggerOptions(files));
  } catch (error) {
    swaggerValid = false;
    swaggerError = error.message;
  }
  const options = fixture.options ?? {};
  const rust = await P.analyze(fixture.input, {
    ...options,
    validate: { ...options.validate, mode: "strict" },
  });
  const compatible = await P.analyze(fixture.input, options);
  assert.equal(rust.valid, fixture.valid, fixture.name);
  results.push({
    fixture: fixture.name,
    rustValid: rust.valid,
    compatibleValid: compatible.valid,
    swaggerValid,
    agreement: rust.valid === swaggerValid,
    swaggerError,
  });
}
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/swagger-parity.json",
  JSON.stringify(
    { validationMode: "strict", swaggerParserVersion: version, results },
    null,
    2,
  ) + "\n",
);
const differences = JSON.parse(
  readFileSync("fixtures/swagger-differences.json", "utf8"),
);
for (const row of results) {
  const expected = differences[row.fixture];
  if (expected) {
    assert.equal(row.rustValid, expected.rustValid, row.fixture);
    assert.equal(row.swaggerValid, expected.swaggerValid, row.fixture);
    assert.equal(
      row.agreement,
      false,
      `Review a previously recorded difference: ${row.fixture}`,
    );
  } else
    assert.equal(
      row.agreement,
      true,
      `Unexpected Swagger difference: ${JSON.stringify(row)}`,
    );
}
assert.equal(
  results.filter((row) => !row.agreement).length,
  Object.keys(differences).length,
);
console.log(
  `${results.filter((row) => row.agreement).length} validity agreements; ${Object.keys(differences).length} explicitly tested capability differences.`,
);
const compatibleDifferences = JSON.parse(
  readFileSync("fixtures/swagger-compatible-differences.json", "utf8"),
);
for (const row of results) {
  const expected = compatibleDifferences[row.fixture];
  if (expected) {
    assert.equal(row.compatibleValid, expected.rustValid, row.fixture);
    assert.equal(row.swaggerValid, expected.swaggerValid, row.fixture);
  } else
    assert.equal(
      row.compatibleValid,
      row.swaggerValid,
      `Unexpected compatible Swagger difference: ${row.fixture}`,
    );
}
assert.equal(
  results.filter((row) => row.compatibleValid !== row.swaggerValid).length,
  Object.keys(compatibleDifferences).length,
);
console.log(
  `${results.length - Object.keys(compatibleDifferences).length} compatible validity agreements; ${Object.keys(compatibleDifferences).length} asserted differences.`,
);
// Transformation contracts compare behavior, rather than bundle placement/order.
const document = {
  openapi: "3.0.4",
  info: { title: "Pets", version: "1" },
  paths: {},
  components: {
    schemas: {
      Pet: { type: "string" },
      A: { $ref: "#/components/schemas/Pet" },
      B: { $ref: "#/components/schemas/Pet" },
    },
  },
};
const rust = await P.dereference(document);
const swagger = await SwaggerParser.dereference(structuredClone(document));
assert.deepEqual(rust, swagger);
assert.equal(rust.components.schemas.A, rust.components.schemas.B);
assert.equal(swagger.components.schemas.A, swagger.components.schemas.B);
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
for (const parser of [P, SwaggerParser]) {
  const output = await parser.dereference(structuredClone(cycle));
  assert.equal(
    output.components.schemas.Tree.properties.child,
    output.components.schemas.Tree,
  );
  await assert.rejects(
    parser.dereference(structuredClone(cycle), {
      dereference: { circular: false },
    }),
  );
  const ignored = await parser.dereference(structuredClone(cycle), {
    dereference: { circular: "ignore" },
  });
  assert.equal(
    ignored.components.schemas.Tree.properties.child.$ref,
    "#/components/schemas/Tree",
  );
}
const external = {
  ...document,
  components: { schemas: { A: { $ref: "pet.json" }, B: { $ref: "pet.json" } } },
};
const files = {
  "pet.json": JSON.stringify({
    type: "object",
    properties: { name: { type: "string" } },
  }),
  [root]: JSON.stringify(external),
};
const rustBundle = await P.bundle(external, { files });
const swaggerBundle = await SwaggerParser.bundle(root, swaggerOptions(files));
const moved = "memory://fresh/moved.json";
const movedRust = await P.dereference({ uri: moved, content: rustBundle });
const movedSwagger = await SwaggerParser.dereference(
  moved,
  swaggerBundle,
  swaggerOptions(),
);
assert.deepEqual(
  movedRust.components.schemas.A,
  movedSwagger.components.schemas.A,
);
assert.deepEqual(
  movedRust.components.schemas.B,
  movedSwagger.components.schemas.B,
);
console.log(
  `${results.length} validity comparisons; shared identity, cycle policies, external bundling and fresh-URI reload contracts passed.`,
);
