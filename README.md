# Octri OpenAPI Parser — Rust

[Live demo](https://octri.dev/openapi-parser) · Free to try in your browser, no account required.

A standalone OpenAPI parser with a Rust core, native command-line tool, Node-API
bindings and browser WebAssembly. Parsing, references, source locations and
OpenAPI semantics share one Rust implementation.

Maintained by [OctriDev](https://github.com/octridev). Build from source or use platform-matched release artifacts. Licensed under [Apache-2.0](LICENSE); third-party components retain their own licenses.

## Npm packages

```sh
npm install @octri/openapi-parser-wasm
```

Use `@octri/openapi-parser-native` for Node.js with platform-matched native addons.
Native packages select a pinned optional binary dependency for macOS ARM64 or
Linux x64/ARM64 with glibc; other platforms can use WASM or build from source.
Keep optional dependencies enabled. Node.js requires version 22.19 or later.

Package READMEs contain installation examples and hosting requirements. Npm
wrapper patch versions can differ from the engine version recorded in results.
Other language registries are separate distribution targets; source-build
instructions remain below.

## Capabilities

- Swagger 2.0 and OpenAPI 3.0, 3.1 and 3.2; strict JSON and YAML 1.2 loading.
- Compatible validation by default; strict auditing adds external-target,
  JSON Schema 2020-12 keyword, operation, parameter and security checks.
- Local, external and virtual references; JSON Pointer escaping, encoded keys,
  schema resource IDs, anchors and dynamic-reference preservation.
- Portable bundling, shared-reference graphs and explicit circular policies.
  Rust uses stable arena node IDs; Node and browsers reconstruct object identity.
- Source text, source pointers, line/column locations, dependency edges and
  effective operation/schema/security inventories.
- Separate file/HTTP resolver policy, bounded input/output and no ambient I/O
  in the core or browser. Node operations run on native worker threads.
- JSON/YAML CLI output, stdin, structured errors and protected output files.

Official OpenAPI Initiative validation schemas are pinned by source URL and hash
in [schema resources](crates/octri-parser/schemas/README.md) and compiled offline.
JSON Schema dynamic references are preserved for a payload evaluator; the parser
does not execute APIs or validate application payload instances.

## Build and test

Install Rust 1.95 with `rustup`, Node 22.19+ and the matching wasm-bindgen CLI:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
npm run build:node
npm run build:wasm
node scripts/cargo.mjs test --workspace
npm run test:node
npx playwright install chromium
npm run test:browser
```

`node scripts/cargo.mjs` uses standard rustup or an optional isolated Rust
toolchain cache without modifying shell profiles.
The lockfiles and `rust-toolchain.toml` pin reproducible development inputs.

## Native CLI

```sh
node scripts/cargo.mjs build --release -p octri-parser-cli
./target/release/octri-openapi analyze fixtures/pets.yaml
./target/release/octri-openapi bundle fixtures/pets.yaml --format yaml
./target/release/octri-openapi dereference fixtures/pets.yaml --circular ignore
cat fixtures/pets.yaml | ./target/release/octri-openapi validate -
./target/release/octri-openapi analyze fixtures/pets.yaml --strict
```

Commands: `parse`, `resolve`, `bundle`, `dereference`, `validate`, `inspect`,
`analyze`. `--report` emits source/reference metadata. Exit status is 0 for
success, 1 for invalid input or an operation failure, and 2 for invalid CLI usage.
Use `--help` for resolver and output options. HTTP reads require `--allow-http`.

## Node

After building, workspace imports use the native binding:

```ts
import OpenAPIParser from "@octri/openapi-parser-native";

const result = await OpenAPIParser.analyze({
  openapi: "3.1.2",
  info: { title: "Pets", version: "1.0.0" },
  paths: {},
});

for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.code, diagnostic.location, diagnostic.message);
}
```

`parse`, `bundle`, `dereference` and `validate` return documents; `resolve`
returns a reference registry; `inspect` returns an effective inventory;
`analyze` returns a report even when input is invalid. Instance properties retain
sources, references, diagnostics and the original document.

## Browser WASM

Serve the browser package's `dist/` and `pkg/` directories together. The WASM
binary is loaded relative to its generated module; serve it as
`application/wasm` and allow WebAssembly in your Content Security Policy.

```ts
import OpenAPIParser from "@octri/openapi-parser-wasm";

const bundle = await OpenAPIParser.bundle(sourceText, {
  uri: "memory://project/openapi.yaml",
  files: { "models/pet.yaml": petSchemaText },
});
```

Browser initialization happens once. Supplied virtual files resolve entirely
locally. Fetch dependencies explicitly in your application when required; the
parser never enables browser fetch because a document contains a URL. Run large
parses in a Web Worker.

When your host fetch follows a redirect, retain both retrieval URLs. Supply the
downloaded bytes under the final URL in `files`, and map the requested URL to
that final URL in `retrievalAliases`:

```ts
const report = await OpenAPIParser.analyze(sourceText, {
  uri: "https://api.example/openapi.json",
  files: { "https://cdn.example/v2/pet.json": downloadedSchemaText },
  retrievalAliases: {
    "https://api.example/pet.json": "https://cdn.example/v2/pet.json",
  },
});
```

Relative references and relative schema `$id` values then use the final retrieval
URL. Original source bytes and authored identifiers remain unchanged. Source
locations use final retrieval URLs; the reference registry accepts requested
URLs as aliases, including pointer and anchor lookups. Alias cycles, fragments,
conflicting resources and files keyed by an alias are rejected. Aliases are
bounded by `maxDocuments` and grant no I/O authority. Relative option keys and
alias values resolve against the supplied input URI; absolute URLs are preferred
for host-fetched files.

Native HTTP retrieval reports the final checked URL automatically. Custom Rust
resolvers can override `Resolver::read_with_identity` and return `ResolvedSource`;
existing resolvers implementing only `read` keep their original behavior. Rust
callers constructing `Options` or `ReferenceIndex` with struct literals must add
the new `retrieval_aliases` field or use `..Default::default()`. JSON requests
that omit it retain their prior behavior.

## Rust

```rust
use octri_parser::{execute, Input, NoIo, Operation, Options, Request};

let report = execute(Request {
    operation: Operation::Analyze,
    input: Input {
        uri: "memory://project/api.yaml".into(),
        content: Some(source_text),
        generated: false,
    },
    options: Options::default(),
}, &mut NoIo)?;
```

Use `octri_parser_native::execute` for explicit native filesystem/HTTP capabilities.
Custom resolvers implement `Resolver`; supplied virtual files take precedence.

## Options and validation

`parse` loads syntax; `resolve` indexes references; `bundle` creates a portable
reference-bearing document; `dereference` restores shared identity; `validate`
validates and dereferences; `inspect` inventories operations; `analyze` returns
sources, diagnostics, indexes and inventory even when `valid` is false.

```js
const options = {
  uri: "memory://project/api.yaml",
  files: { "models/pet.yaml": petSchemaText },
  validate: { mode: "strict", schema: true, spec: true },
  dereference: { circular: "ignore", cloneReferences: false },
  limits: { maxDocumentBytes: 16 * 1024 * 1024 },
};
```

Compatible validation defaults missing or non-string `info.version` to `"0.1.0"`
in an isolated working document. Source bytes and caller inputs remain unchanged.
Strict mode adds semantic and JSON Schema checks. Unknown options fail explicitly.

Circular policies are `preserve` (shared/cyclic graph identity), `ignore` (retain
cycle-closing `$ref` objects for JSON export), and `error` (`CIRCULAR_REFERENCE`).
Graphs expose stable node IDs and source origins. Serialization enforces output
limits and rejects unbounded cyclic expansion.

Defaults: 16 MiB per document, 64 MiB total source, 128 documents, 1,000,000 nodes,
depth 128, 64 aliases and 64 MiB serialized output. Native HTTP is opt-in, bounded
by a 15-second retrieval deadline and five redirects. See [security](SECURITY.md)
for filesystem and address restrictions.

## Language bindings

TypeScript/JavaScript, Python, Go, Java, Kotlin, PHP, Ruby, Swift, Dart and Rust
use the same Rust semantics. C ABI ownership, build requirements and language
examples are in [bindings/README.md](bindings/README.md). Native libraries must
match the host OS and architecture. Windows remains experimental.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities. Core behavior lives in
`crates/octri-parser`; native capability controls in `crates/octri-parser-native`;
CLI, Node-API and WASM adapters live in their corresponding crates.
