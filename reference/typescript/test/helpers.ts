import type { Document } from "../src/types.js";
export const api = (version = "3.1.2"): Document => ({
  ...(version.startsWith("2") ? { swagger: version } : { openapi: version }),
  info: { title: "Fixture", version: "1.0.0" },
  paths: {},
});
export const schemas = (items: Document, version = "3.1.2"): Document => ({
  ...api(version),
  components: { schemas: items },
});
export const response = (schema: unknown = { type: "string" }) => ({
  description: "Success",
  content: { "application/json": { schema } },
});
