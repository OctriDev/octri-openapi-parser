import { describe, it, expect } from "vitest";
import P, { serialize } from "../src/index.js";
import { schemas } from "./helpers.js";
describe("schema resources and portable bundles", () => {
  it.each(["3.1.2", "3.2.0"])(
    "%s: adds portable IDs when crossing out of a nested resource",
    async (version) => {
      const input = schemas(
        {
          A: {
            $id: "https://example.test/A",
            properties: {
              b: { $ref: "memory://octri/openapi.yaml#/components/schemas/B" },
            },
          },
          B: { type: "string" },
        },
        version,
      );
      const bundle = await P.bundle(input);
      expect((bundle.components as any).schemas.B.$id).toMatch(
        /^urn:octri:bundle:/,
      );
      const output = await P.dereference({
        uri: "memory://moved/new.json",
        content: serialize(bundle),
      });
      expect((output.components as any).schemas.A.properties.b.type).toBe(
        "string",
      );
    },
  );
  it("preserves boolean targets when a portable schema resource wrapper is needed", async () => {
    const input = schemas({
      A: {
        $id: "https://example.test/A",
        properties: {
          b: { $ref: "memory://octri/openapi.yaml#/components/schemas/B" },
        },
      },
      B: false,
    });
    const bundle = await P.bundle(input);
    expect((bundle.components as any).schemas.B.allOf).toEqual([false]);
    expect(
      (
        await P.analyze({
          uri: "memory://moved/new.json",
          content: serialize(bundle),
        })
      ).valid,
    ).toBe(true);
  });
  it.each(["3.1.2", "3.2.0"])(
    "%s: resolves relative ids and embedded anchors",
    async (version) => {
      const p = new P();
      const d = await p.dereference(
        schemas(
          {
            A: {
              $id: "https://example.test/a.json",
              type: "object",
              properties: { b: { $ref: "b.json#B" } },
              $defs: { B: { $id: "b.json", $anchor: "B", type: "string" } },
            },
          },
          version,
        ),
      );
      expect((d.components as any).schemas.A.properties.b.type).toBe("string");
    },
  );
  it.each(["3.1.2", "3.2.0"])(
    "%s: bundled schema id references survive a new retrieval URI",
    async (version) => {
      const input = schemas(
        {
          A: {
            $id: "https://example.test/A",
            type: "object",
            properties: { b: { $ref: "https://example.test/B" } },
          },
          B: { $id: "https://example.test/B", type: "string" },
        },
        version,
      );
      const bundle = await P.bundle(input);
      const output = await P.dereference({
        uri: "memory://fresh/moved.yaml",
        content: serialize(bundle, "yaml"),
      });
      expect((output.components as any).schemas.A.properties.b.type).toBe(
        "string",
      );
    },
  );
  it.each(["3.1.2", "3.2.0"])(
    "%s: bundles an external resource containing static and dynamic refs",
    async (version) => {
      const parser = new P({
        files: {
          "tree.json": JSON.stringify({
            $id: "memory://octri/tree.json",
            $dynamicAnchor: "node",
            type: "object",
            properties: {
              children: { type: "array", items: { $dynamicRef: "#node" } },
              label: { $ref: "#/$defs/label" },
            },
            $defs: { label: { type: "string" } },
          }),
        },
      });
      const bundle = await parser.bundle(
        schemas({ Tree: { $dynamicRef: "tree.json#node" } }, version),
      );
      const consumer = new P();
      const info = await consumer.analyze({
        uri: "memory://fresh/moved.yaml",
        content: serialize(bundle, "yaml"),
      });
      expect(info.valid, JSON.stringify(info.diagnostics)).toBe(true);
      expect(consumer.sources).toHaveLength(1);
    },
  );
  it.each(["a#b", "a%b", "a%23b", "a/b", "a~b", "a b", "a?b", "a😀b"])(
    "restores schema key %s after bundling/dereferencing",
    async (key) => {
      const encoded = encodeURIComponent(
        key.replaceAll("~", "~0").replaceAll("/", "~1"),
      );
      const input = schemas({
        [key]: { type: "string" },
        A: { $ref: "#/components/schemas/" + encoded },
      });
      const bundle = await P.bundle(input);
      expect(Object.hasOwn((bundle.components as any).schemas, key)).toBe(true);
      const d = await P.dereference({
        uri: "memory://new/spec.json",
        content: serialize(bundle),
      });
      expect((d.components as any).schemas.A.type).toBe("string");
    },
  );
});
