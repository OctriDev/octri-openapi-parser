import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const rootUri = "memory://public-corpus/openapi.json";

const [engine, filename] = process.argv.slice(2);
const text = readFileSync(filename, "utf8");
let result;
try {
  if (engine === "node") {
    const { default: Parser } = await import("../packages/node/dist/index.js");
    const document = await Parser.validate(text, {
      uri: rootUri,
      limits: {
        maxDocumentBytes: 33554432,
        maxTotalBytes: 134217728,
        maxNodes: 4000000,
        maxOutputBytes: 134217728,
      },
    });
    result = {
      valid: true,
      paths: Object.keys(document.paths ?? {}).length,
      errors: [],
    };
  } else {
    const require = createRequire(
      new URL("../reference/typescript/package.json", import.meta.url),
    );
    const Swagger = require("@apidevtools/swagger-parser");
    const uri = rootUri;
    await Swagger.validate(uri, {
      resolve: {
        file: false,
        http: false,
        supplied: {
          order: 1,
          canRead: (file) => file.url === uri,
          read: () => text,
        },
      },
    });
    result = { valid: true, errors: [] };
  }
} catch (error) {
  result = {
    valid: false,
    errors: error.diagnostics?.slice(0, 3) ?? [{ message: error.message }],
  };
}
console.log(
  JSON.stringify({
    ...result,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
