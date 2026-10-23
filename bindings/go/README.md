# Octri OpenAPI Parser for Go

[Live demo](https://octri.dev/openapi-parser) · Validate, parse, bundle and dereference Swagger 2.0
and OpenAPI 3.0, 3.1 and 3.2 documents with Octri's Rust parser.

```sh
go get github.com/octridev/octri-openapi-parser-go
```

```go
import parser "github.com/octridev/octri-openapi-parser-go"

report, err := parser.Parser{}.Analyze(parser.Text(specText, "memory://project/api.yaml"), nil)
```

The module bundles a static library.
Supported platforms: Linux x64 and arm64 (glibc 2.36 or later) and macOS arm64. On other platforms, build
`liboctri_parser_ffi` from [the repository](https://github.com/octridev/octri-openapi-parser) and add its
directory to `CGO_LDFLAGS` with `-L`.

Build with `CGO_ENABLED=1` and a C compiler. The library links statically, so binaries need nothing installed beside them.

Options, report shapes and the runtime contract are documented in the
[bindings guide](https://github.com/octridev/octri-openapi-parser/blob/main/bindings/README.md). Licensed under Apache-2.0; the bundled library's
third-party notices ship with the package.
