/** Verify the exact standards resources compiled into the offline Rust engine. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../crates/octri-parser/schemas/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("sources.json", root), "utf8"),
);
assert.equal(manifest.publisher, "OpenAPI Initiative");
assert.equal(manifest.license, "Apache-2.0");
assert.deepEqual(manifest.files.map(({ file }) => file).sort(), [
  "openapi-2.0.json",
  "openapi-3.0.json",
  "openapi-3.1.json",
  "openapi-3.2.json",
]);
for (const entry of manifest.files) {
  const source = new URL(entry.url);
  assert.equal(source.origin, "https://spec.openapis.org");
  assert.match(source.pathname, /^\/oas\/\d\.\d\/schema\/\d{4}-\d{2}-\d{2}$/);
  const bytes = readFileSync(new URL(entry.file, root));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    entry.sha256,
    entry.file,
  );
  const schema = JSON.parse(bytes);
  assert.equal(schema.$id ?? schema.id, entry.id, entry.file);
}
assert.match(
  readFileSync(new URL("OAI-LICENSE", root), "utf8"),
  /Apache License/,
);
console.log(
  "Four pinned OpenAPI Initiative schemas and upstream license verified offline.",
);
