# Changelog

## 0.1.2

- Published the language bindings: PyPI, RubyGems, Maven Central, pub.dev and
  crates.io packages, Go, PHP and Swift mirror repositories, and C archives on
  the GitHub release. Each package carries the native library for Linux x64 and
  arm64 (glibc 2.36+) and macOS arm64, and its no-argument constructor loads it.
- The Swift binding loads the library with `dlopen` instead of linking a system
  library, and the Go module path is `github.com/octridev/octri-openapi-parser-go`.
- The Ruby gem declares `bigdecimal` and `fiddle`, which leave Ruby's default
  gems in 3.4 and 4.0.

## 0.1.0

- Introduced Rust core, native resolver and CLI, Node-API and browser WASM adapters.
- Preserved TypeScript implementation as a hash-verified parity reference.
- Added source-aware validation, reference graphs, portable bundles and inventories.
- Added cross-runtime fixtures, security regressions and development checks.
- Indexed reference lookup and schema usage, captured resource metadata during
  traversal, and added a bounded JSON reader for object inputs to reduce overhead.
- Added phase profiling and alternating-engine benchmark sampling.
- Reduced binding payloads with lossless location tables and lazy source map
  restoration; retained cloning, freezing, source positions and graph identity.
- Reduced pointer and bundle-index allocations while preserving escaped keys,
  source provenance and output semantics.

- Added compatible default validation and explicit strict auditing. Compatible
  Validate/Analyze defaults `info.version` in an isolated working document;
  original sources and caller inputs remain unchanged.
- Expanded validation contracts to 33 fixtures, retaining reference
  semantics, input limits and strict regressions.
- Indexed reference-bearing nodes, borrowed graph/bundle children, avoided unused
  copies and redundant output checks; added native-only core and CLI benchmarks.
- Added document-only core execution for static bindings, preserving checks and
  diagnostics while avoiding unused report/position output and graph tree copies.
- Shared immutable resource scope and limited graph identity caches to reference
  targets, with overlapping-target and projection equivalence regressions.
- Fixed valid JSON surrogate-pair loading and preserved original token positions.
- Hardened own-property input envelopes, nested options and inherited serialization
  hooks without executing accessors.
- Added pinned provider corpus, scaling/RSS, concurrency, three-engine CSP/Worker,
  Linux containment and platform package qualification. Windows remains
  experimental; public publication and licensing remain blocked.

Octri source is licensed under Apache-2.0. Release artifacts require matching
platform qualification and checksum verification.

- Added a versioned C ABI and native Python, Go, Java, Kotlin, PHP, Ruby, Swift
  and Dart bindings, plus an ergonomic direct Rust facade. Parser semantics and
  I/O policy remain shared. Graphs retain explicit IDs, cycles and origins.
- Added cross-language full-report/document/error comparisons, concurrency and
  isolated package consumers. Swift preserves distinct Unicode-normalization
  keys; PHP/Dart expose lossless native JSON alongside host-decoded values.
