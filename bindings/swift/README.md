# Octri OpenAPI Parser for Swift

[Live demo](https://octri.dev/openapi-parser) · Validate, parse, bundle and dereference Swagger 2.0
and OpenAPI 3.0, 3.1 and 3.2 documents with Octri's Rust parser.

```sh
# Package.swift
.package(url: "https://github.com/octridev/octri-openapi-parser-swift", from: "0.1.2")
```

```swift
import OctriOpenAPIParser

let report = try Parser().analyze(.text(specText))
```

The package bundles the native library as a resource.
Supported platforms: Linux x64 and arm64 (glibc 2.36 or later) and macOS arm64. On other platforms, build
`liboctri_parser_ffi` from [the repository](https://github.com/octridev/octri-openapi-parser) and pass its path
to `Parser(library:)`.

macOS consumers declare macOS 13 or later. Linux executables should link with lld and separate code segments:
`-Xswiftc -use-ld=lld -Xlinker -z -Xlinker separate-code`.

Options, report shapes and the runtime contract are documented in the
[bindings guide](https://github.com/octridev/octri-openapi-parser/blob/main/bindings/README.md). Licensed under Apache-2.0; the bundled library's
third-party notices ship with the package.
