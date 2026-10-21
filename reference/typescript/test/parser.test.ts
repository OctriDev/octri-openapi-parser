import { describe, it, expect } from "vitest";
import P, { OpenAPIError, serialize } from "../src/index.js";
import Browser from "../src/browser.js";
import { api, schemas, response } from "./helpers.js";
import type { Document } from "../src/types.js";

describe("input and dialects", () => {
  it.each(["2.0", "3.0.0", "3.0.4", "3.1.0", "3.1.2", "3.2.0"])(
    "validates %s",
    async (version) => {
      expect((await P.analyze(api(version))).valid).toBe(true);
    },
  );
  it.each(["1.2", "3.3.0", "4.0.0", "3.1", "3.1.0-beta"])(
    "rejects unknown version %s",
    async (version) => {
      await expect(P.parse(api(version))).rejects.toMatchObject({
        code: "UNSUPPORTED_VERSION",
      });
    },
  );
  it("never coerces numeric versions", async () => {
    await expect(P.parse({ ...api(), openapi: 3.1 })).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
    });
  });
  it("rejects ambiguous dialect", async () => {
    await expect(P.parse({ ...api(), swagger: "2.0" })).rejects.toMatchObject({
      code: "AMBIGUOUS_VERSION",
    });
  });
  it("parses YAML with locations and untouched references", async () => {
    const p = new P();
    const a = await p.parse(
      'openapi: 3.1.0\ninfo:\n  title: Hello\n  version: "1"\npaths: {}\ncomponents:\n  schemas:\n    A: { $ref: "#/components/schemas/B" }\n    B: {type: string}\n',
    );
    expect((a.components as any).schemas.A.$ref).toBe("#/components/schemas/B");
    expect(p.sources[0]?.locations.get("/info/title")).toMatchObject({
      line: 3,
      column: 10,
    });
  });
  it("does not mutate the caller document", async () => {
    const a = schemas({
      A: { $ref: "#/components/schemas/B" },
      B: { type: "string" },
    });
    const before = structuredClone(a);
    await P.dereference(a);
    expect(a).toEqual(before);
  });
  it("exposes original source after transformations", async () => {
    const p = new P();
    await p.dereference(
      schemas({ A: { $ref: "#/components/schemas/B" }, B: { type: "string" } }),
    );
    expect(
      (p.sources[0]!.document as any).components.schemas.A.$ref,
    ).toBeDefined();
    expect((p.document as any).components.schemas.A.$ref).toBeDefined();
  });
  it("rejects duplicate YAML and JSON keys", async () => {
    await expect(
      P.parse("openapi: 3.1.0\nopenapi: 3.0.0"),
    ).rejects.toMatchObject({ code: "SYNTAX_ERROR" });
    await expect(
      P.parse('{"openapi":"3.1.0","openapi":"3.0.0"}'),
    ).rejects.toMatchObject({ code: "SYNTAX_ERROR" });
  });
  it("rejects malformed JSON explicitly", async () => {
    await expect(
      P.parse({ uri: "memory://test/a.json", content: '{"openapi":"3.1.0",}' }),
    ).rejects.toMatchObject({ code: "SYNTAX_ERROR" });
  });
  it("rejects custom YAML executable tags", async () => {
    await expect(
      P.parse("openapi: 3.1.0\nx: !!js/function function(){}"),
    ).rejects.toMatchObject({ code: "SYNTAX_ERROR" });
  });
  it("accepts webhooks-only and components-only 3.1 documents", async () => {
    const a = api();
    delete a.paths;
    a.webhooks = {};
    expect((await P.analyze(a)).valid).toBe(true);
    delete a.webhooks;
    a.components = { schemas: {} };
    expect((await P.analyze(a)).valid).toBe(true);
  });
  it("requires info metadata without inserting defaults", async () => {
    const a = api();
    a.info = { title: "Missing version" };
    const r = await P.analyze(a);
    expect(r.valid).toBe(false);
    expect(a.info).toEqual({ title: "Missing version" });
  });
  it("supports callback and static/instance methods", async () => {
    await new Promise<void>((resolve, reject) => {
      P.parse(api(), (e, v) => {
        if (e) return reject(e);
        expect(v?.openapi).toBe("3.1.2");
        resolve();
      });
    });
  });
  it("clears previous result on failure", async () => {
    const p = new P();
    await p.parse(api());
    await expect(p.parse("[]")).rejects.toBeInstanceOf(OpenAPIError);
    expect(p.api).toBeNull();
  });
  it("is safe for concurrent calls across instances", async () => {
    expect(
      (await Promise.all(Array.from({ length: 10 }, () => P.validate(api()))))
        .length,
    ).toBe(10);
  });
});
describe("reference graphs", () => {
  it("dereferences with shared identity", async () => {
    const d = await P.dereference(
      schemas({
        A: { $ref: "#/components/schemas/C" },
        B: { $ref: "#/components/schemas/C" },
        C: { type: "object" },
      }),
    );
    const s = (d.components as any).schemas;
    expect(s.A).toBe(s.B);
    expect(s.A).toBe(s.C);
  });
  it("supports escaped and URI-encoded pointers", async () => {
    const d = await P.dereference(
      schemas({
        "a/b~ c": { type: "string" },
        A: { $ref: "#/components/schemas/a~1b~0%20c" },
      }),
    );
    expect((d.components as any).schemas.A.type).toBe("string");
  });
  it("resolves external virtual JSON/YAML transitively", async () => {
    const p = new P({
      files: {
        "a.yaml": 'type: object\nproperties:\n  b: {$ref: "b.json"}',
        "b.json": '{"type":"string"}',
      },
    });
    const d = await p.dereference(schemas({ A: { $ref: "a.yaml" } }));
    expect((d.components as any).schemas.A.properties.b.type).toBe("string");
    expect(p.$refs.paths()).toHaveLength(3);
    expect(p.references.every((e) => e.resolved)).toBe(true);
  });
  it("bundles repeated external references into a serializable document", async () => {
    const p = new P({
      files: {
        "model.yaml":
          'type: object\nproperties:\n  child: {$ref: "model.yaml"}',
      },
    });
    const d = await p.bundle(
      schemas({ A: { $ref: "model.yaml" }, B: { $ref: "model.yaml" } }),
    );
    expect(() => serialize(d)).not.toThrow();
    expect(JSON.stringify(d)).not.toContain("model.yaml");
    await expect(P.validate(d)).resolves.toBeTruthy();
  });
  it.each([true, false, "ignore"] as const)(
    "honors circular policy %s",
    async (circular) => {
      const p = new P({ dereference: { circular } });
      const input = schemas({
        Node: {
          type: "object",
          properties: { next: { $ref: "#/components/schemas/Node" } },
        },
      });
      if (circular === false)
        await expect(p.dereference(input)).rejects.toBeInstanceOf(OpenAPIError);
      else {
        const d = await p.dereference(input);
        expect(p.$refs.circular).toBe(true);
        if (circular === true) {
          expect((d.components as any).schemas.Node.properties.next).toBe(
            (d.components as any).schemas.Node,
          );
          expect(() => serialize(d)).toThrow(/Cyclic/);
        } else expect(() => serialize(d)).not.toThrow();
      }
    },
  );
  it("can clone distinct references", async () => {
    const d = await P.dereference(
      schemas({
        A: { $ref: "#/components/schemas/C" },
        B: { $ref: "#/components/schemas/C" },
        C: { type: "string" },
      }),
      { dereference: { cloneReferences: true } },
    );
    expect((d.components as any).schemas.A).not.toBe(
      (d.components as any).schemas.B,
    );
  });
  it("fails missing pointer with source location", async () => {
    const p = new P();
    const r = await p.analyze(schemas({ A: { $ref: "#/missing" } }));
    expect(r.valid).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({
      code: "UNRESOLVED_REFERENCE",
      location: { pointer: "/components/schemas/A/$ref" },
    });
  });
  it("reports missing external file", async () => {
    await expect(
      P.resolve(schemas({ A: { $ref: "missing.yaml" } })),
    ).rejects.toBeInstanceOf(OpenAPIError);
  });
  it("exposes get, exists, set, values and paths", async () => {
    const p = new P();
    const refs = await p.resolve(schemas({ A: { type: "string" } }));
    expect(refs).toBe(p.$refs);
    expect(refs.get("#/components/schemas/A")).toEqual({ type: "string" });
    expect(refs.exists("#/missing")).toBe(false);
    refs.set("#/components/schemas/B", { type: "number" });
    expect(refs.get("#/components/schemas/B")).toEqual({ type: "number" });
    expect(Object.keys(refs.values())).toHaveLength(1);
    expect(() => refs.set("#/__proto__/polluted", true)).toThrow();
  });
  it("does not resolve literal references in examples, defaults and extensions", async () => {
    const literal = { $ref: "file:///etc/passwd" };
    const d = schemas({
      A: {
        type: "object",
        examples: [literal],
        default: literal,
        enum: [literal],
      },
    });
    d["x-custom"] = literal;
    d.paths = {
      "/x": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { examples: { one: { value: literal } } },
              },
            },
          },
        },
      },
    };
    await expect(P.dereference(d)).resolves.toBeTruthy();
  });
  it("still resolves components whose name begins with x-", async () => {
    const d = await P.dereference(
      schemas({
        "x-Foo": { $ref: "#/components/schemas/A" },
        A: { type: "string" },
      }),
    );
    expect((d.components as any).schemas["x-Foo"]).toEqual({ type: "string" });
  });
  it("preserves JSON Schema sibling constraints as conjunctions", async () => {
    const d = await P.dereference(
      schemas({
        A: { $ref: "#/components/schemas/B", maxLength: 5 },
        B: { type: "string", maxLength: 10 },
      }),
    );
    expect((d.components as any).schemas.A).toMatchObject({
      maxLength: 5,
      allOf: [{ type: "string", maxLength: 10 }],
    });
  });
  it("resolves embedded $id and $anchor", async () => {
    const p = new P();
    const d = await p.dereference(
      schemas({
        A: {
          $id: "https://schemas.example.test/thing",
          $anchor: "thing",
          type: "string",
        },
        B: { $ref: "https://schemas.example.test/thing#thing" },
      }),
    );
    expect((d.components as any).schemas.B.type).toBe("string");
  });
  it("preserves local dynamic references", async () => {
    const p = new P();
    const d = await p.dereference(
      schemas({
        A: {
          $id: "https://schemas.example.test/tree",
          $dynamicAnchor: "node",
          type: "object",
          properties: {
            children: { type: "array", items: { $dynamicRef: "#node" } },
          },
        },
      }),
    );
    expect(
      (d.components as any).schemas.A.properties.children.items.$dynamicRef,
    ).toBe("#node");
    expect(
      p.diagnostics.some((d) => d.code === "DYNAMIC_REFERENCE_PRESERVED"),
    ).toBe(true);
  });
});
describe("validation and inspection", () => {
  it("rejects invalid schema keyword types in 3.1", async () => {
    expect(
      (await P.analyze(schemas({ A: { type: "string", minLength: "no" } })))
        .valid,
    ).toBe(false);
  });
  it("supports boolean schemas in 3.1 and rejects them in 3.0", async () => {
    expect((await P.analyze(schemas({ A: false }))).valid).toBe(true);
    expect((await P.analyze(schemas({ A: false }, "3.0.4"))).valid).toBe(false);
  });
  it("warns on custom vocabularies without claiming validation coverage", async () => {
    const r = await P.analyze({
      ...schemas({ A: { type: "string" } }),
      jsonSchemaDialect: "https://example.test/custom",
    });
    expect(r.diagnostics.some((d) => d.code === "CUSTOM_DIALECT")).toBe(true);
  });
  it("resolves inherited params, security overrides, servers and TRACE", async () => {
    const d = api();
    d.security = [{ bearer: [] }];
    d.servers = [{ url: "https://example.test" }];
    d.components = {
      parameters: {
        id: {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    };
    d.paths = {
      "/x/{id}": {
        parameters: [{ $ref: "#/components/parameters/id" }],
        trace: { security: [], responses: { "200": response() } },
        get: {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "Override",
              schema: { type: "string" },
            },
          ],
          responses: { "200": response() },
        },
      },
    };
    const p = new P();
    const info = await p.inspect(d);
    expect(info.operations).toHaveLength(2);
    expect(info.operations[0]).toMatchObject({
      method: "GET",
      parameters: [{ description: "Override" }],
      security: [{ bearer: [] }],
    });
    expect(info.operations[1]).toMatchObject({ method: "TRACE", security: [] });
    expect((await P.analyze(d)).valid).toBe(true);
  });
  it("handles QUERY and additionalOperations in 3.2", async () => {
    const d = api("3.2.0");
    d.paths = {
      "/x": {
        query: { responses: { "200": { description: "OK" } } },
        additionalOperations: {
          COPY: { responses: { "200": { description: "OK" } } },
        },
      },
    };
    const r = await P.inspect(d);
    expect(r.operations.map((o) => o.method)).toEqual(["QUERY", "COPY"]);
  });
  it("inspects webhook and callback operations", async () => {
    const d = api();
    d.webhooks = {
      event: { post: { responses: { "200": { description: "OK" } } } },
    };
    d.paths = {
      "/x": {
        post: {
          responses: { "200": { description: "OK" } },
          callbacks: {
            event: {
              "{$request.body#/url}": {
                post: { responses: { "200": { description: "OK" } } },
              },
            },
          },
        },
      },
    };
    const i = await P.inspect(d);
    expect(i.operations.map((o) => o.kind)).toEqual([
      "path",
      "callback",
      "webhook",
    ]);
  });
  it("detects path mismatches, duplicate IDs and undefined security", async () => {
    const d = api();
    d.paths = {
      "/a/{id}": {
        get: {
          operationId: "same",
          security: [{ missing: [] }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/b": {
        get: {
          operationId: "same",
          responses: { "200": { description: "OK" } },
        },
      },
    };
    const r = await P.analyze(d);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        "MISSING_PATH_PARAMETER",
        "DUPLICATE_OPERATION_ID",
        "UNDEFINED_SECURITY_SCHEME",
      ]),
    );
  });
  it("exposes schema usage", async () => {
    const d = schemas({ A: { type: "string" } });
    d.paths = {
      "/x": {
        get: {
          responses: { "200": response({ $ref: "#/components/schemas/A" }) },
        },
      },
    };
    const i = await P.inspect(d);
    expect(i.schemas[0]!.usedBy).toHaveLength(1);
  });
  it("browser and node results agree", async () => {
    const d = schemas({
      A: { $ref: "#/components/schemas/B" },
      B: { type: "string" },
    });
    expect(await Browser.bundle(d)).toEqual(await P.bundle(d));
    expect((await Browser.analyze(d)).valid).toBe((await P.analyze(d)).valid);
  });
});
describe("bounded processing", () => {
  it("does not reject compact output below its byte budget", () => {
    expect(serialize({ x: 1 }, "json", { maxBytes: 8, indent: 0 })).toBe(
      '{"x":1}\n',
    );
  });
  it("supports typed custom parser plugins", async () => {
    const result = await P.parse(
      { uri: "memory://custom/definition.txt", content: "CUSTOM" },
      {
        parse: {
          plugins: [
            {
              name: "custom",
              canParse: (_uri, text) => text === "CUSTOM",
              parse: () => api(),
            },
          ],
        },
      },
    );
    expect(result.openapi).toBe("3.1.2");
  });
  it("rejects malformed JSON Schema dialect declarations", async () => {
    expect(
      (await P.analyze(schemas({ A: { $schema: 42, type: "string" } }))).valid,
    ).toBe(false);
  });
  it("limits input bytes", async () => {
    await expect(
      P.parse(api(), { limits: { maxDocumentBytes: 1 } }),
    ).rejects.toMatchObject({ code: "LIMIT_BYTES" });
  });
  it("limits nesting and node counts", async () => {
    await expect(
      P.parse(api(), { limits: { maxDepth: 1 } }),
    ).rejects.toMatchObject({ code: "LIMIT_DEPTH" });
    await expect(
      P.parse(api(), { limits: { maxNodes: 2 } }),
    ).rejects.toMatchObject({ code: "LIMIT_NODES" });
  });
  it("limits total bytes and documents", async () => {
    const input = schemas({ A: { $ref: "a.json" }, B: { $ref: "b.json" } });
    const files = {
      "a.json": '{"type":"string"}',
      "b.json": '{"type":"number"}',
    };
    await expect(
      P.resolve(input, { files, limits: { maxDocuments: 1 } }),
    ).rejects.toBeInstanceOf(OpenAPIError);
    await expect(
      P.resolve(input, { files, limits: { maxTotalBytes: 1 } }),
    ).rejects.toMatchObject({ code: "LIMIT_TOTAL_BYTES" });
  });
  it("honors pre-aborted signals", async () => {
    await expect(
      P.parse(api(), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
  it("times out a stalled custom resolver", async () => {
    await expect(
      P.resolve(schemas({ A: { $ref: "custom://host/schema" } }), {
        resolve: {
          plugins: [
            {
              name: "stalled",
              canRead: () => true,
              read: () => new Promise(() => {}),
            },
          ],
        },
        limits: { timeoutMs: 20 },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
  it("prevents concurrent mutable operations on one instance", async () => {
    const p = new P();
    const first = p.parse(api());
    await expect(p.parse(api())).rejects.toMatchObject({
      code: "CONCURRENT_OPERATION",
    });
    await first;
  });
  it("validates limits and JSON-compatible input", async () => {
    await expect(
      P.parse(api(), { limits: { maxDepth: 0 } }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(P.parse({ ...api(), bad: NaN })).rejects.toMatchObject({
      code: "NON_JSON_VALUE",
    });
  });
  it("bounds serialized output", () => {
    expect(() =>
      serialize({ x: "a".repeat(100) }, "json", { maxBytes: 10 }),
    ).toThrow();
  });
  it("collects independent missing references", async () => {
    const report = await P.analyze(
      schemas({ A: { $ref: "missing-a.yaml" }, B: { $ref: "missing-b.yaml" } }),
    );
    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some(
        (d) =>
          d.message.includes("missing-a") || d.location.pointer.includes("/A/"),
      ),
    ).toBe(true);
    expect(
      report.diagnostics.some(
        (d) =>
          d.message.includes("missing-b") || d.location.pointer.includes("/B/"),
      ),
    ).toBe(true);
  });
  it("rejects duplicate anchors", async () => {
    await expect(
      P.resolve(
        schemas({
          A: { $anchor: "same", type: "string" },
          B: { $anchor: "same", type: "number" },
        }),
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_ANCHOR" });
  });
  it("reports external Path Item source locations", async () => {
    const p = new P({
      files: {
        "path.yaml": 'get:\n  responses:\n    "200":\n      description: OK\n',
      },
    });
    const d = api();
    d.paths = { "/x": { $ref: "path.yaml" } };
    const result = await p.inspect(d);
    expect(result.operations[0]?.location).toMatchObject({
      uri: "memory://octri/path.yaml",
      pointer: "/get",
      line: 2,
    });
  });
  it("rejects duplicate referenced parameters", async () => {
    const d = api();
    d.components = {
      parameters: { Q: { name: "q", in: "query", schema: { type: "string" } } },
    };
    d.paths = {
      "/x": {
        get: {
          parameters: [
            { $ref: "#/components/parameters/Q" },
            { $ref: "#/components/parameters/Q" },
          ],
          responses: { 200: { description: "OK" } },
        },
      },
    };
    const r = await P.analyze(d);
    expect(r.diagnostics.some((d) => d.code === "DUPLICATE_PARAMETER")).toBe(
      true,
    );
  });
});
