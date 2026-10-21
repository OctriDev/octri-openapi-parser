# Octri OpenAPI Parser — Node.js

[Live demo](https://octri.dev/openapi-parser) · Free to try in your browser, no account required.

Parse, validate, inspect, bundle and dereference OpenAPI documents while preserving source locations, reference identity and exact numbers.

Part of [octri-openapi-parser](https://github.com/octridev/octri-openapi-parser), maintained by [OctriDev](https://github.com/octridev). Licensed under Apache-2.0. Bundled dependencies retain their own licenses and notices.

## Install

```sh
npm install @octri/openapi-parser-native
```

## Example

```js
import { OpenAPIParser } from "@octri/openapi-parser-native";

const report = await OpenAPIParser.analyze({
  openapi: "3.1.2",
  info: { title: "Example API", version: "1.0.0" },
  paths: {},
});
console.log(report.valid, report.diagnostics);
```

## Runtime and support

Requires Node.js 22.19 or later and a native addon matching your operating system and architecture. Published binaries cover macOS ARM64 and Linux x64/ARM64 with glibc 2.36 or later (Debian 12, Ubuntu 22.10 or newer). Alpine/musl and older glibc systems must use WASM or build from source. Native binaries and platform availability are separate from the portable WASM package. Apply process deadlines and memory limits when serving untrusted documents.

See the [project README](https://github.com/octridev/octri-openapi-parser#readme) for supported versions, capabilities, limits and complete API examples.

Browser and package wrappers may receive packaging-only patch releases while the embedded engine version stays unchanged. Inspect result/asset manifests for the engine version.

Issues and contributions: [octri-openapi-parser](https://github.com/octridev/octri-openapi-parser). Report security issues using [GitHub private vulnerability reporting](https://github.com/octridev/octri-openapi-parser/security/advisories/new).
