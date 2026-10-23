# Octri OpenAPI Parser for Ruby

[Live demo](https://octri.dev/openapi-parser) · Validate, parse, bundle and dereference Swagger 2.0
and OpenAPI 3.0, 3.1 and 3.2 documents with Octri's Rust parser.

```sh
gem install octri-openapi-parser
```

```ruby
require 'octri_parser'

report = OctriParser::Parser.new.analyze(OctriParser::Source.text(spec_text))
```

Each platform gem bundles the native library.
Supported platforms: Linux x64 and arm64 (glibc 2.36 or later) and macOS arm64. On other platforms, build
`liboctri_parser_ffi` from [the repository](https://github.com/octridev/octri-openapi-parser) and pass its path
to the constructor.

Options, report shapes and the runtime contract are documented in the
[bindings guide](https://github.com/octridev/octri-openapi-parser/blob/main/bindings/README.md). Licensed under Apache-2.0; the bundled library's
third-party notices ship with the package.
