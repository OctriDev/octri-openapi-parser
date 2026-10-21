import { describe, it, expect } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import Octri from "../src/index.js";
import { api, schemas, response } from "./helpers.js";
import type { Document } from "../src/types.js";
const target = {
  type: "object",
  properties: { id: { type: "string" }, count: { type: "integer" } },
};
describe("Swagger Parser 13.1.0 comparison", () => {
  for (const version of ["2.0", "3.0.4", "3.1.2"]) {
    for (const method of [
      "parse",
      "validate",
      "bundle",
      "dereference",
    ] as const) {
      it(`${version} ${method}: standard specification parity`, async () => {
        const fixture =
          version === "2.0"
            ? {
                ...api(version),
                definitions: { Thing: target },
                paths: {
                  "/things": {
                    get: {
                      operationId: "listThings",
                      responses: {
                        200: {
                          description: "OK",
                          schema: { $ref: "#/definitions/Thing" },
                        },
                      },
                    },
                  },
                },
              }
            : {
                ...schemas({ Thing: target }, version),
                paths: {
                  "/things": {
                    get: {
                      operationId: "listThings",
                      responses: {
                        200: response({ $ref: "#/components/schemas/Thing" }),
                      },
                    },
                  },
                },
              };
        const expected = await SwaggerParser[method](
          structuredClone(fixture) as never,
        );
        const actual = await Octri[method](fixture);
        expect(actual).toEqual(expected);
      });
    }
    it(`${version}: both reject incomplete info`, async () => {
      const input = { ...api(version), info: { title: "No version" } };
      await expect(
        SwaggerParser.validate(structuredClone(input) as never),
      ).rejects.toThrow();
      await expect(Octri.validate(input)).rejects.toThrow();
    });
    it(`${version}: both resolve shared local reference identity`, async () => {
      const input: Document =
        version === "2.0"
          ? {
              ...api(version),
              definitions: {
                A: { $ref: "#/definitions/B" },
                C: { $ref: "#/definitions/B" },
                B: target,
              },
            }
          : schemas(
              {
                A: { $ref: "#/components/schemas/B" },
                C: { $ref: "#/components/schemas/B" },
                B: target,
              },
              version,
            );
      const a = (await SwaggerParser.dereference(
        structuredClone(input) as never,
      )) as any;
      const b = (await Octri.dereference(input)) as any;
      const x = version === "2.0" ? a.definitions : a.components.schemas;
      const y = version === "2.0" ? b.definitions : b.components.schemas;
      expect(x.A === x.C).toBe(true);
      expect(y.A === y.C).toBe(true);
      expect(y.A).toEqual(x.A);
    });
  }
  it("documents deliberate improvements over the comparator", async () => {
    expect((await Octri.analyze(api("3.2.0"))).valid).toBe(true);
    const input = schemas({
      A: { $ref: "#/components/schemas/B", maxLength: 5 },
      B: { type: "string", maxLength: 10 },
    });
    expect((await Octri.dereference(input)).components).toMatchObject({
      schemas: { A: { maxLength: 5, allOf: [{ maxLength: 10 }] } },
    });
  });
  function operation(
    parameters: unknown[] = [],
    responses: Document = { 200: { description: "OK" } },
    path = "/x",
  ): Document {
    return {
      ...api("2.0"),
      paths: { [path]: { post: { parameters, responses } } },
    };
  }
  const invalidCases: [string, Document][] = [
    [
      "multiple body parameters",
      operation([
        { name: "a", in: "body", schema: { type: "string" } },
        { name: "b", in: "body", schema: { type: "string" } },
      ]),
    ],
    [
      "body and formData conflict",
      operation([
        { name: "a", in: "body", schema: { type: "string" } },
        { name: "b", in: "formData", type: "string" },
      ]),
    ],
    [
      "file media type missing",
      operation([{ name: "file", in: "formData", type: "file" }]),
    ],
    ["invalid response status", operation([], { 700: { description: "Bad" } })],
    [
      "array response missing items",
      operation([], { 200: { description: "OK", schema: { type: "array" } } }),
    ],
    [
      "undeclared required property",
      {
        ...api("2.0"),
        definitions: {
          Thing: { type: "object", required: ["missing"], properties: {} },
        },
      },
    ],
    [
      "duplicate path placeholder",
      operation(
        [{ name: "id", in: "path", required: true, type: "string" }],
        undefined,
        "/x/{id}/{id}",
      ),
    ],
  ];
  for (const [name, input] of invalidCases)
    it(`Swagger 2 spec parity: ${name}`, async () => {
      await expect(
        SwaggerParser.validate(structuredClone(input) as never),
      ).rejects.toThrow();
      await expect(Octri.validate(input)).rejects.toThrow();
    });
});
