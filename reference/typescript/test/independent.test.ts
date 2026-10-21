import { describe, it, expect } from "vitest";
import { createConfig, lintFromString } from "@redocly/openapi-core";
import Parser, { serialize } from "../src/index.js";
import { schemas, api, response } from "./helpers.js";
describe("independent Redocly structural validation", () => {
  it.each(["2.0", "3.0.4", "3.1.2", "3.2.0"])(
    "%s output is accepted independently",
    async (version) => {
      const input =
        version === "2.0"
          ? api(version)
          : {
              ...schemas({ A: { type: "string" } }, version),
              paths: {
                "/x": {
                  get: {
                    responses: {
                      "200": response({ $ref: "#/components/schemas/A" }),
                    },
                  },
                },
              },
            };
      const output = await Parser.bundle(input);
      const config = await createConfig({
        rules: { struct: "error", "no-unresolved-refs": "error" },
      });
      expect(
        await lintFromString({ source: serialize(output, "yaml"), config }),
      ).toEqual([]);
    },
  );
});
