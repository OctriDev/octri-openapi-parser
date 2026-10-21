# Octri OpenAPI Parser — Browser WASM

[Live demo](https://octri.dev/openapi-parser) · Free to try in your browser, no account required.

Parse, validate, inspect, bundle and dereference OpenAPI documents while preserving source locations, reference identity and exact numbers.

Part of [octri-openapi-parser](https://github.com/octridev/octri-openapi-parser), maintained by [OctriDev](https://github.com/octridev). Licensed under Apache-2.0. Bundled dependencies retain their own licenses and notices.

## Install

```sh
npm install @octri/openapi-parser-wasm
```

## Example

```js
import { OpenAPIParser } from "@octri/openapi-parser-wasm";

const report = await OpenAPIParser.analyze({
  openapi: "3.1.2",
  info: { title: "Example API", version: "1.0.0" },
  paths: {},
});
console.log(report.valid, report.diagnostics);
```

## Runtime and support

Use a browser/bundler that supports ES modules and WebAssembly. WASM initializes on the first call; `initialize` accepts an explicit module/response for custom hosting. Keep work off the main thread for untrusted or large specifications. Core and WASM have no ambient filesystem or network access: provide referenced documents explicitly.

See the [project README](https://github.com/octridev/octri-openapi-parser#readme) for supported versions, capabilities, limits and complete API examples.

Browser and package wrappers may receive packaging-only patch releases while the embedded engine version stays unchanged. Inspect result/asset manifests for the engine version.

Issues and contributions: [octri-openapi-parser](https://github.com/octridev/octri-openapi-parser). Report security issues using [GitHub private vulnerability reporting](https://github.com/octridev/octri-openapi-parser/security/advisories/new).
