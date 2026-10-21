import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import P, { OpenAPIError } from "./dist/index.js";

const api = (schemas = {}, version = "3.1.2") => ({
  openapi: version,
  info: { title: "Pets", version: "1" },
  paths: {},
  components: { schemas },
});
const code = (expected) => (error) =>
  error instanceof OpenAPIError &&
  error.diagnostics.some((d) => d.code === expected);

for (const version of ["3.0.4", "3.1.2", "3.2.0"]) {
  test(`native binding validates ${version}`, async () =>
    assert.equal((await P.analyze(api({}, version))).valid, true));
}

test("3.2 custom methods retain case and metadata through Node-API", async () => {
  const operation = (id) => ({
    operationId: id,
    description: `Description for ${id}`,
    "x-interfacer-namespace": "events",
    responses: { 204: { description: "Copied" } },
  });
  const source = {
    ...api({}, "3.2.1"),
    paths: { "/events": { $ref: "events.json" } },
  };
  const result = await P.analyze(source, {
    files: {
      "events.json": {
        additionalOperations: {
          COPY: operation("upper"),
          copy: operation("lower"),
        },
      },
    },
    validate: { mode: "strict" },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.inspection.operations.map((operation) => operation.method),
    ["COPY", "copy"],
  );
  for (const operation of result.inspection.operations) {
    assert.equal(
      operation.description,
      `Description for ${operation.operationId}`,
    );
    assert.equal(operation.extensions["x-interfacer-namespace"], "events");
    assert.equal(operation.location.uri, "memory://octri/events.json");
  }
});

test("authored JSON BOM retains original bytes and precise token locations", async () => {
  const content =
    '\uFEFF{"openapi":"3.2.1","info":{"title":"BOM API","version":"1"},"paths":{}}';
  const parser = new P();
  await parser.parse({ uri: "https://api.example/openapi.json", content });
  assert.equal(parser.sources[0].text, content);
  assert.equal(
    parser.sources[0].locations["/info/title"].offset,
    Buffer.byteLength(content.slice(0, content.indexOf('"BOM API"'))),
  );
  assert.equal(parser.api.info.title, "BOM API");
});

test("retrieval aliases preserve final bases and registry anchor lookup", async () => {
  const parser = new P();
  const source = api({ Pet: { $ref: "https://old.example/pet.json#Pet" } });
  await parser.resolve(source, {
    uri: "https://api.example/openapi.json",
    retrievalAliases: {
      "https://old.example/pet.json": "https://cdn.example/v2/pet.json",
    },
    files: {
      "https://cdn.example/v2/pet.json": {
        $anchor: "Pet",
        type: "object",
        properties: { "a/b": { $ref: "child.json" } },
      },
      "https://cdn.example/v2/child.json": { type: "string" },
    },
  });
  assert.equal(
    parser.$refs.get("https://old.example/pet.json#Pet").type,
    "object",
  );
  assert.equal(
    parser.$refs.get("https://old.example/pet.json#/properties/a~1b").type,
    "string",
  );
  assert.equal(parser.$refs.exists("https://old.example/pet.json#Pet"), true);
  assert(
    parser.sources.some(
      (source) => source.uri === "https://cdn.example/v2/child.json",
    ),
  );
  assert(
    !parser.sources.some(
      (source) => source.uri === "https://old.example/pet.json",
    ),
  );
});

test("native root and external redirects use final URL for relative references", async () => {
  const visited = [];
  let origin;
  const server = createServer((request, response) => {
    visited.push(request.url);
    if (request.url === "/old/api.json") {
      response.writeHead(302, { Location: "/new/api.json" }).end();
    } else if (request.url === "/new/api.json") {
      response.end(JSON.stringify(api({ Pet: { $ref: "../old/pet.json" } })));
    } else if (request.url === "/old/pet.json") {
      response.writeHead(302, { Location: "/new/pet.json#ignored" }).end();
    } else if (request.url === "/new/pet.json") {
      response.end(
        JSON.stringify({
          type: "object",
          properties: { name: { $ref: "child.json" } },
        }),
      );
    } else if (request.url === "/new/child.json") {
      response.end(JSON.stringify({ type: "string" }));
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const parser = new P();
    const registry = await parser.resolve(origin + "/old/api.json", {
      resolve: { http: true, allowPrivate: true },
    });
    assert.equal(
      registry.get(origin + "/old/pet.json#/properties/name").type,
      "string",
    );
    assert.deepEqual(visited, [
      "/old/api.json",
      "/new/api.json",
      "/old/pet.json",
      "/new/pet.json",
      "/new/child.json",
    ]);
    assert(
      parser.sources.some((source) => source.uri === origin + "/new/api.json"),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dereference preserves identity, clone mode and caller input", async () => {
  const input = api({
    Pet: { type: "string" },
    A: { $ref: "#/components/schemas/Pet" },
    B: { $ref: "#/components/schemas/Pet" },
  });
  const before = structuredClone(input);
  const output = await P.dereference(input);
  assert.equal(output.components.schemas.A, output.components.schemas.B);
  const cloned = await P.dereference(input, {
    dereference: { cloneReferences: true },
  });
  assert.notEqual(cloned.components.schemas.A, cloned.components.schemas.B);
  assert.deepEqual(input, before);
});

test("circular graph is reconstructed across Node-API", async () => {
  const input = api({
    Tree: {
      type: "object",
      properties: { child: { $ref: "#/components/schemas/Tree" } },
    },
  });
  const output = await P.dereference(input);
  assert.equal(
    output.components.schemas.Tree.properties.child,
    output.components.schemas.Tree,
  );
  await assert.rejects(
    P.dereference(input, { dereference: { circular: false } }),
    code("CIRCULAR_REFERENCE"),
  );
  const ignored = await P.dereference(input, {
    dereference: { circular: "ignore" },
  });
  assert.equal(
    ignored.components.schemas.Tree.properties.child.$ref,
    "#/components/schemas/Tree",
  );
});

test("source locations survive external reference resolution", async () => {
  const parser = new P({
    files: {
      "pet.yaml": "type: object\nproperties:\n  name:\n    type: string\n",
    },
  });
  await parser.bundle(api({ Pet: { $ref: "pet.yaml" } }));
  assert.equal(parser.sources.length, 2);
  assert.equal(parser.references[0].target.uri, "memory://octri/pet.yaml");
  assert.equal(
    parser.sources.find((s) => s.uri.endsWith("/pet.yaml")).locations[
      "/properties/name"
    ].line,
    4,
  );
});

test("WASM-compatible virtual bundle resolves after moving retrieval URI", async () => {
  const bundled = await P.bundle(api({ A: { $ref: "pet.json#/$defs/Name" } }), {
    files: {
      "pet.json": { type: "object", $defs: { Name: { type: "string" } } },
    },
  });
  const moved = await P.dereference({
    uri: "memory://other/new.json",
    content: bundled,
  });
  assert.equal(moved.components.schemas.A.type, "string");
});

test("bad references produce structured diagnostics", async () => {
  const input = api({
    "a/b": { type: "string" },
    A: { $ref: "#/components/schemas/a%" },
  });
  for (const method of [
    "resolve",
    "bundle",
    "dereference",
    "validate",
    "inspect",
  ])
    await assert.rejects(P[method](input), code("INVALID_REFERENCE_URI"));
  assert.equal((await P.analyze(input)).valid, false);
});

test("object values are checked without invoking accessors", async () => {
  let called = false;
  const input = api();
  Object.defineProperty(input, "secret", {
    enumerable: true,
    get() {
      called = true;
      return "secret";
    },
  });
  await assert.rejects(P.parse(input), code("NON_JSON_VALUE"));
  assert.equal(called, false);
  for (const value of [undefined, NaN, new Date(), () => {}])
    await assert.rejects(
      P.parse({ ...api(), bad: value }),
      code("NON_JSON_VALUE"),
    );
});

test("arbitrary decimal and integer values survive parse, graph and serialization", async () => {
  const { LosslessNumber, parseJson } = await import("./dist/index.js");
  const input =
    '{"openapi":"3.1.2","info":{"title":"Exact","version":"1"},"paths":{},"x-decimal":0.100000000000000005,"x-integer":18446744073709551616,"x-overflow":1e400}';
  const parsed = await P.parse(input);
  assert.ok(parsed["x-decimal"] instanceof LosslessNumber);
  assert.equal(parsed["x-decimal"].token, "0.100000000000000005");
  assert.equal(parsed["x-integer"], 18446744073709551616n);
  const graph = await P.dereference(input);
  assert.equal(graph["x-decimal"].token, parsed["x-decimal"].token);
  const { serialize } = await import("./dist/index.js");
  const encoded = await serialize(parsed);
  assert.deepEqual(parseJson(encoded), parsed);
  const generated = await P.parse({
    ...api(),
    "x-integer": 18446744073709551616n,
    "x-decimal": new LosslessNumber("0.100000000000000005"),
  });
  assert.equal(generated["x-integer"], 18446744073709551616n);
  assert.equal(generated["x-decimal"].token, "0.100000000000000005");
});

test("instance concurrency errors; independent instances run concurrently", async () => {
  const parser = new P();
  const first = parser.parse(api());
  await assert.rejects(parser.parse(api()), code("CONCURRENT_OPERATION"));
  await first;
  await Promise.all(Array.from({ length: 8 }, () => P.validate(api())));
});

test("content file URI grants no filesystem permission; explicit root works", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octri-parser-"));
  try {
    const path = join(directory, "openapi.json");
    const input = api({ Pet: { $ref: "pet.json" } });
    await writeFile(
      join(directory, "pet.json"),
      JSON.stringify({ type: "string" }),
    );
    const contentInput = { uri: pathToFileURL(path).href, content: input };
    await assert.rejects(P.dereference(contentInput), code("RESOLVER_DENIED"));
    await assert.rejects(
      P.dereference(input, { uri: pathToFileURL(path).href }),
      code("RESOLVER_DENIED"),
    );
    assert.equal(
      (await P.dereference(contentInput, { resolve: { fileRoot: directory } }))
        .components.schemas.Pet.type,
      "string",
    );
    await writeFile(path, JSON.stringify(input));
    assert.equal(
      (await P.dereference(path)).components.schemas.Pet.type,
      "string",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file fence denies symlinks outside root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octri-parser-"));
  try {
    const root = join(directory, "root");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root);
    await writeFile(join(directory, "outside.json"), '{"type":"string"}');
    await symlink(join(directory, "outside.json"), join(root, "pet.json"));
    await writeFile(
      join(root, "openapi.json"),
      JSON.stringify(api({ Pet: { $ref: "pet.json" } })),
    );
    await assert.rejects(
      P.bundle(join(root, "openapi.json")),
      code("FILE_OUTSIDE_ROOT"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP is opt-in, private addresses denied, redirects rechecked, reads bounded", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/pet.json" });
      response.end();
    } else if (request.url === "/large") {
      response.end(" ".repeat(4096));
    } else response.end('{"type":"string"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const input = api({ Pet: { $ref: `${base}/redirect` } });
    await assert.rejects(P.bundle(input), code("RESOLVER_DENIED"));
    await assert.rejects(
      P.bundle(input, { resolve: { http: true } }),
      code("HTTP_PRIVATE_ADDRESS"),
    );
    assert.equal(requests, 0);
    const result = await P.dereference(input, {
      resolve: { http: true, allowPrivate: true, allowHosts: ["127.0.0.1"] },
    });
    assert.equal(result.components.schemas.Pet.type, "string");
    await assert.rejects(
      P.bundle(input, {
        resolve: { http: true, allowPrivate: true, maxRedirects: 0 },
      }),
      code("HTTP_REDIRECT_LIMIT"),
    );
    await assert.rejects(
      P.bundle(api({ Pet: { $ref: `${base}/large` } }), {
        resolve: { http: true, allowPrivate: true },
        limits: { maxDocumentBytes: 1024 },
      }),
      code("LIMIT_DOCUMENT_BYTES"),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invalid external targets are validated at their real source", async () => {
  const report = await P.analyze(
    {
      openapi: "3.1.2",
      info: { title: "Pets", version: "1" },
      paths: {
        "/pets": { get: { responses: { 200: { $ref: "response.yaml" } } } },
      },
    },
    {
      validate: { mode: "strict" },
      files: { "response.yaml": "description: 42\n" },
    },
  );
  assert.equal(report.valid, false);
  assert(
    report.diagnostics.some(
      (d) =>
        d.code === "OPENAPI_SCHEMA" &&
        d.location.uri.endsWith("/response.yaml"),
    ),
  );
});

test("object inputs have pointers without fabricated source lines", async () => {
  const report = await P.analyze({
    openapi: "3.1.2",
    info: { version: "1" },
    paths: {},
  });
  assert.equal(report.valid, false);
  assert.equal(report.sources[0].generated, true);
  assert.equal(report.sources[0].locations["/info"].line, undefined);
  assert(report.diagnostics.every((d) => d.location.line === undefined));
});

test("reference registry supports lookup, anchors and isolated mutation", async () => {
  const parser = new P();
  const registry = await parser.resolve(
    api({
      Pet: { $id: "https://example.test/pet", $anchor: "Pet", type: "string" },
      A: { $ref: "https://example.test/pet#Pet" },
    }),
  );
  assert.equal(registry.get("https://example.test/pet#Pet").type, "string");
  assert.equal(registry.get("#/components/schemas/A").type, "string");
  assert.equal(registry.exists("#/components/schemas/missing"), false);
  registry.set("#/components/schemas/Pet/type", "integer");
  assert.equal(registry.get("#/components/schemas/Pet/type"), "integer");
  assert.equal(
    parser.sources[0].document.components.schemas.Pet.type,
    "string",
  );
  assert.throws(() =>
    registry.set("#/components/schemas/__proto__/polluted", true),
  );
});

test("Rust serialization exports YAML and enforces byte and cycle policies", async () => {
  const { serialize } = await import("./dist/index.js");
  const document = api({
    Pet: { type: "string", enum: ["true", "null", "42"] },
  });
  const yaml = await serialize(document, "yaml");
  assert.deepEqual(
    await P.parse({ uri: "memory://project/moved.yaml", content: yaml }),
    document,
  );
  await assert.rejects(
    serialize(document, "json", { maxOutputBytes: 10 }),
    code("LIMIT_OUTPUT_BYTES"),
  );
  const cycle = {};
  cycle.self = cycle;
  await assert.rejects(serialize(cycle), code("CIRCULAR_SERIALIZATION"));
});

test("object preflight bounds shared expansion and rejects hidden toJSON execution", async () => {
  let called = false;
  const input = api();
  Object.defineProperty(input, "toJSON", {
    value() {
      called = true;
      return {};
    },
  });
  await assert.rejects(P.parse(input), code("NON_JSON_VALUE"));
  assert.equal(called, false);
  let shared = { value: "x" };
  for (let i = 0; i < 10; i++) shared = { a: shared, b: shared };
  await assert.rejects(
    P.parse({ ...api(), "x-data": shared }, { limits: { maxNodes: 100 } }),
    code("LIMIT_NODES"),
  );
  await assert.rejects(
    P.parse({ ...api(), "x-data": Array(2) }),
    code("NON_JSON_VALUE"),
  );
});

test("invalid options and failed reuse cannot leave a stale registry", async () => {
  await assert.rejects(
    P.parse(api(), { resolve: false }),
    code("INVALID_OPTIONS"),
  );
  await assert.rejects(
    P.parse(api(), () => {}),
    code("INVALID_OPTIONS"),
  );
  const parser = new P();
  await parser.resolve(api({ Pet: { type: "string" } }));
  assert.equal(parser.$refs.exists("#/components/schemas/Pet"), true);
  await assert.rejects(parser.parse({ openapi: "4.0.0" }));
  assert.equal(parser.$refs.exists("#/components/schemas/Pet"), false);
});

test("compact locations preserve public shape, lazy access and mutation isolation", async () => {
  const { restoreReport } = await import("./dist/shared/transport.js");
  const encoded = {
    wireVersion: 1,
    sources: [
      {
        uri: "memory://original/source.yaml",
        text: "original",
        document: { nested: { child: 1 } },
        locations: {
          "": [1, 1, 0],
          "/nested": [2, 3, 12],
          "/nested/child": null,
          "/unusual": {
            uri: "memory://other",
            pointer: "/elsewhere",
            column: 0,
          },
        },
        bytes: 8,
        generated: false,
      },
    ],
  };
  const report = restoreReport(encoded);
  assert.equal(Object.hasOwn(report, "wireVersion"), false);
  const source = report.sources[0];
  source.uri = "memory://changed";
  source.document.nested = null;
  const expected = {
    "": {
      uri: "memory://original/source.yaml",
      pointer: "",
      line: 1,
      column: 1,
      offset: 0,
    },
    "/nested": {
      uri: "memory://original/source.yaml",
      pointer: "/nested",
      line: 2,
      column: 3,
      offset: 12,
    },
    "/nested/child": {
      uri: "memory://original/source.yaml",
      pointer: "/nested/child",
    },
    "/unusual": { uri: "memory://other", pointer: "/elsewhere", column: 0 },
  };
  assert.deepEqual(source.locations, expected);
  assert.equal(source.locations, source.locations);
  assert.deepEqual(structuredClone(source).locations, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(source)).locations, expected);
  source.locations = {};
  assert.deepEqual(source.locations, {});
  assert.equal(restoreReport(report), report);
  const fresh = restoreReport({
    wireVersion: 1,
    sources: [{ locations: {}, uri: "memory://fresh" }],
  });
  fresh.sources[0].locations = expected;
  assert.equal(fresh.sources[0].locations, expected);
  assert.throws(
    () => restoreReport({ wireVersion: 99, sources: [] }),
    code("INVALID_TRANSPORT"),
  );
});

test("generated and text sources retain complete location inventories", async () => {
  const original = api({ "a/b~c": { type: "string", default: "😀" } });
  const parser = new P();
  const output = await parser.parse(original);
  const source = parser.sources[0];
  const descriptor = Object.getOwnPropertyDescriptor(source, "locations");
  assert.equal(typeof descriptor.get, "function");
  output.info.title = "Changed";
  source.document.info.title = "Changed source";
  const pointer = "/components/schemas/a~1b~0c/default";
  assert.deepEqual(source.locations[pointer], { uri: source.uri, pointer });
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(source, "locations").get,
    "undefined",
  );
  const textParser = new P();
  await textParser.parse(
    "openapi: 3.1.2\ninfo: {title: Pets, version: '1'}\npaths: {}\nx-data: &values [one, two]\nx-copy: *values\n",
  );
  const locations = textParser.sources[0].locations;
  assert.equal(locations["/info/title"].line, 2);
  assert.equal(locations["/x-copy"].line, 5);
  assert.equal(locations["/x-copy/0"], undefined);
  assert.ok(locations["/x-data/0"]);
});

test("input byte preflight matches JSON UTF-8 at exact budget boundaries", async () => {
  const { encodeInput } = await import("./dist/shared/json.js");
  const strings = [
    "plain ASCII",
    'a\\b"c',
    "\b\t\n\f\r\u0000\u001f\u007f",
    "éĀ😀",
    "\ud800",
    "\udfff",
    "\ud800x\udfff",
    "\ud800\ud800\udfff",
  ];
  for (const text of strings) {
    const value = { [text]: [text, -0, 1e-100, null, true] };
    const expected = JSON.stringify(value);
    const bytes = Buffer.byteLength(expected);
    assert.equal(encodeInput(value, { maxDocumentBytes: bytes }), expected);
    assert.throws(
      () => encodeInput(value, { maxDocumentBytes: bytes - 1 }),
      code("LIMIT_DOCUMENT_BYTES"),
    );
  }
});

test("lazy location maps survive freezing and sealing before first access", async () => {
  for (const freeze of [Object.freeze, Object.seal]) {
    const parser = new P();
    await parser.parse(api());
    const source = freeze(parser.sources[0]);
    const locations = source.locations;
    assert.equal(locations["/info/title"].pointer, "/info/title");
    assert.equal(source.locations, locations);
    assert.deepEqual(structuredClone(source).locations, locations);
    if (freeze === Object.freeze) {
      assert.throws(() => {
        source.locations = {};
      }, TypeError);
    } else {
      source.locations = {};
      assert.deepEqual(source.locations, {});
    }
  }
});

test("compatible defaults normalize working output and registry without mutating sources", async () => {
  const input = { openapi: "3.1.2", info: { title: "Pets" }, paths: {} };
  const before = structuredClone(input);
  const parser = new P();
  const output = await parser.validate(input);
  assert.equal(output.info.version, "0.1.0");
  assert.equal(parser.$refs.get("#/info/version"), "0.1.0");
  assert.deepEqual(input, before);
  assert.deepEqual(parser.document, before);
  assert.deepEqual(parser.sources[0].document, before);
  const strict = await P.analyze(input, { validate: { mode: "strict" } });
  assert.equal(strict.valid, false);
  const compatible = await P.analyze(input);
  assert.equal(compatible.valid, true);
  assert.equal(compatible.document.info.version, "0.1.0");
  assert.equal((await P.parse(input)).info.version, undefined);
  const invalidMode = await P.analyze(input, { validate: { mode: "unknown" } });
  assert.equal(invalidMode.valid, false);
  assert.ok(
    invalidMode.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVALID_REQUEST",
    ),
  );
});

test("static document projection matches instances, errors and subclass overrides", async () => {
  const input = api({
    Pet: { type: "string" },
    Alias: { $ref: "#/components/schemas/Pet" },
  });
  delete input.info.version;
  for (const method of ["parse", "bundle", "dereference", "validate"]) {
    const parser = new P();
    assert.deepEqual(await P[method](input), await parser[method](input));
    assert.equal(parser.sources.length, 1);
    assert.equal(parser.document.info.version, undefined);
    await assert.rejects(
      P[method](input, { limits: { maxOutputBytes: 1 } }),
      code("LIMIT_OUTPUT_BYTES"),
    );
  }
  await assert.rejects(
    P.validate(input, { validate: { mode: "strict" } }),
    code("OPENAPI_SCHEMA"),
  );
  class ExtendedParser extends P {
    async parse() {
      return { extension: true };
    }
  }
  assert.deepEqual(await ExtendedParser.parse(input), { extension: true });
  const text =
    '{"openapi":"3.1.2","info":{"title":"\\ud83d\\udc4d","version":"1"},"paths":{}}';
  const parser = new P();
  assert.equal(
    (await parser.parse({ uri: "memory://test/input.json", content: text }))
      .info.title,
    "👍",
  );
  assert.equal(parser.sources[0].text, text);
  assert.equal(
    parser.sources[0].locations["/info/title"].offset,
    text.indexOf('"\\ud83d'),
  );
});

test("inherited accessors cannot redirect inputs or parser options", async () => {
  let calls = 0;
  const keys = [
    "uri",
    "content",
    "files",
    "limits",
    "resolve",
    "validate",
    "dereference",
  ];
  const original = keys.map((key) =>
    Object.getOwnPropertyDescriptor(Object.prototype, key),
  );
  try {
    for (const key of keys)
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          calls++;
          return undefined;
        },
      });
    const input = api();
    assert.deepEqual(await P.parse(input, {}), input);
    const parser = new P({});
    assert.deepEqual(await parser.parse(input), input);
    assert.equal(
      (await P.parse({ uri: "memory://own/input.json", content: input })).info
        .title,
      "Pets",
    );
  } finally {
    keys.forEach((key, index) => {
      if (original[index])
        Object.defineProperty(Object.prototype, key, original[index]);
      else delete Object.prototype[key];
    });
  }
  assert.equal(calls, 0);
  const options = {};
  Object.defineProperty(options, "resolve", {
    get() {
      calls++;
      return {};
    },
  });
  await assert.rejects(P.parse(api(), options), code("INVALID_OPTIONS"));
  assert.equal(calls, 0);
  assert.deepEqual(
    await P.parse(api(), { limits: { maxNodes: undefined } }),
    api(),
  );
});

test("inherited serialization hooks are rejected without execution", async () => {
  for (const prototype of [Object.prototype, Array.prototype]) {
    let calls = 0;
    const original = Object.getOwnPropertyDescriptor(prototype, "toJSON");
    try {
      Object.defineProperty(prototype, "toJSON", {
        configurable: true,
        get() {
          calls++;
          return () => ({});
        },
      });
      const input = api();
      input["x-values"] = [1, 2];
      await assert.rejects(P.parse(input), code("NON_JSON_VALUE"));
    } finally {
      if (original) Object.defineProperty(prototype, "toJSON", original);
      else delete prototype.toJSON;
    }
    assert.equal(calls, 0);
  }
});
