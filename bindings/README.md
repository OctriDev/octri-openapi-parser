# Native language bindings

[Live demo](https://octri.dev/openapi-parser) · Free to try in your browser, no account required.

The language set is TypeScript/JavaScript, Python, Go, Java, Kotlin, PHP, Ruby,
Swift, Dart and Rust. Node and browser WASM keep their existing adapters.
Rust uses `octri-parser-sdk` directly. Eight additional languages call a small
versioned C ABI; Java and Kotlin share one byte-array JNI bridge. No adapter
reimplements parsing, validation, reference resolution or retrieval policy.

## Build and check

Required native toolchains: Rust 1.95, Node 22.19+, Python 3.8+, Go 1.23+ with
cgo, JDK 11+, Maven, Kotlin 2.3.21, PHP 8.1+ with FFI, Ruby 3.1+ with Fiddle,
Swift 6+ and Dart 3.4+. Current build/check evidence pins specific toolchains;
minimum-version declarations are not a claim that every version was exercised.
Set `JAVA_HOME` to a supported JDK. macOS tooling can discover Homebrew JDK 21.
Compatibility floors retain Octri's language standards. Deploy on maintained
runtime versions; compatibility with an older runtime does not extend its
vendor's security support.

```sh
node scripts/build-bindings.mjs
node scripts/test-bindings.mjs
```

`Dockerfile.bindings` builds and runs the same native consumers on Linux. Base
images use immutable digests and the Kotlin compiler download uses SHA-256.
Pass `--build-arg OCTRI_TARGET_ARCH=amd64` or `arm64`; the build checks its
actual architecture before compiling. Use BuildKit for cross-platform builds.
OS development packages come from the image distribution's package repositories.
No runtime packages are published by these commands.

Linux Swift consumers should pass `-Xlinker -z -Xlinker separate-code` when
linking. The tested Swift/GNU linker combination otherwise merges code and data
into a writable executable segment. Our build and installed-consumer gates apply
this flag and reject writable executable segments or executable stacks in native
artifacts. The Swift package itself remains usable as a normal dependency without
injecting SwiftPM unsafe flags into downstream packages.

`Dockerfile.bindings-baselines` repeats the build, matrix and installed-package
checks on Python 3.8, Java/Kotlin JVM 11 and PHP 8.1. Build the primary image as
`octri-parser-bindings:ci` first, then build the baseline image with the same
`OCTRI_TARGET_ARCH` argument. Both builds are required by language-bindings CI.

## Shared API contract

The C entry point accepts a versioned envelope, for example:

```json
{
  "abiVersion": 1,
  "action": "report",
  "request": {
    "operation": "analyze",
    "input": {
      "uri": "memory://project/api.yaml",
      "content": "...",
      "generated": false
    },
    "options": { "validate": { "mode": "strict" } }
  }
}
```

Responses contain `Ok` with a full report/document result, or `Err` with
`message`/`diagnostics`. The `document` action uses the same request shape;
`serialize` takes encoded JSON in `document`, `format` and optional `limits`.
The public header specifies allocator ownership. Lengths are UTF-8 byte counts,
never character counts; buffers are not NUL terminated. Check the ABI version
before calling. Existing version-1 envelopes retain their behavior; incompatible
symbol or envelope changes require a new ABI version.

Every adapter offers Parse, Resolve, Bundle, Dereference, Validate, Inspect and
Analyze. Source factories distinguish text, JSON objects and native paths.
Options use the Rust/Node camelCase JSON schema documented in [README options](../README.md#options-and-validation).
Typed Rust/Go request types and JSON tree types in dynamic/JVM/Swift languages
retain the same complete reports. Options are validated by Rust, including
unknown fields. Sources supplied as objects are serialized without mutating them.

These native facades return full reports from ordinary operation methods, matching
Rust's contract. This differs from Node's static document-returning methods.
The explicit `document` projection supports Parse/Bundle/Dereference/Validate;
Parse/Bundle return `document`, Dereference/Validate return `graph`. Full reports
include original source text/values/locations, references, registry, inventory and
graph origins. The default C report retains ordinary Rust serialization. Python,
JVM and Swift facades request the optional `compact: true` report transport and
restore exactly the same public locations. Compact results include
`wireVersion: 1`; source location entries use `[line, column, offset]`, or `null`
for generated locations. Nonstandard location entries retain their full object.
Non-ASCII characters use standard JSON escapes in this transport. Use matching
library and facade builds; raw `call` methods keep the envelope requested by callers.

Graphs are arenas with stable `root`/`nodes` IDs. Sharing and cycles are preserved
explicitly; adapters do not silently duplicate, flatten or truncate them. Inspect
`nodes[id]`, whose kind is `object`, `array` or `scalar`. The ordinary report's
JSON document is absent for cyclic output. Use a portable bundle, `circular:
"ignore"`, or Rust's bounded graph exporter when a tree is required.

Compatible validation is the default. Select `validate.mode: "strict"` for
auditing. Failed Analyze returns a report with `valid: false`; other invalid
operations raise the language's `ParserError`/`ParserException` or return Go/Rust
errors with complete diagnostic arrays. Host encoding and loading errors remain
ordinary host-language exceptions/errors.

`serialize` uses the Rust bounded writer for JSON/YAML. Rust directly reexports
`serialize`/`serialize_yaml`. Input/output policies remain unchanged: no implicit
HTTP, content grants no file permission, explicit file roots are fenced, and
virtual files take precedence. Native path sources grant the containing directory.

## Installation

Every package carries the native library for Linux x64 and arm64 (glibc 2.36 or
later) and macOS arm64, and its no-argument constructor loads that copy. Pass a
library path instead to use a library you built, or on another platform.

| Language | Install |
| --- | --- |
| Python | `pip install octri-openapi-parser` |
| Ruby | `gem install octri-openapi-parser` |
| PHP | `composer require octri/openapi-parser` |
| Go | `go get github.com/octridev/octri-openapi-parser-go` |
| Java | `dev.octri:openapi-parser` on Maven Central |
| Kotlin | `dev.octri:openapi-parser-kotlin` on Maven Central |
| Swift | `https://github.com/octridev/octri-openapi-parser-swift` |
| Dart | `dart pub add octri_openapi_parser` |
| Rust | `cargo add octri-parser-sdk` |
| C | Header and libraries on each GitHub release |

Go, PHP and Swift install from git, so their packages live in the
`octri-openapi-parser-go`, `-php` and `-swift` mirror repositories, which the
release workflow updates. Their sources are maintained here.

## Examples

Python:

```python
from octri_parser import Parser, Source

parser = Parser()  # or Parser("/absolute/path/liboctri_parser_ffi.dylib")
report = parser.analyze(Source.text(spec_text), {"validate": {"mode": "strict"}})
print(report["valid"], report["diagnostics"])
```

Go:

```go
p := parser.Parser{}
report, err := p.Analyze(parser.Text(specText, "memory://project/api.yaml"), nil)
```

Build Go with `CGO_ENABLED=1` and a C compiler. The released module links its
bundled static library, so binaries need nothing installed beside them. From a
source checkout, or on another platform, add
`CGO_LDFLAGS="-L/absolute/native/directory -Wl,-rpath,/absolute/native/directory"`.
It links the native library instead of starting a subprocess; cross-compilation
needs the matching C toolchain and library.

Java:

```java
var parser = new dev.octri.parser.Parser(); // or (nativeLibraryPath, jniBridgePath)
var report = parser.analyze(Source.text(specText), null);
```

Kotlin:

```kotlin
val parser = dev.octri.parser.kotlin.Parser() // or (nativeLibraryPath, jniBridgePath)
val report = parser.analyze(dev.octri.parser.Source.text(specText))
```

JVM packages use Jackson `JsonNode` and JDK 11 bytecode. Keep the native C ABI and
JNI bridge together. The Java jar carries both for each platform and extracts
them to a temporary directory on first use. One library pair is loaded per JVM
class loader. The Java artifact depends on pinned Jackson; Kotlin additionally
depends on Java and the Kotlin standard library. Release sets include
those jars. Do not enable Jackson polymorphic class loading for untrusted data.

Ruby:

```ruby
require 'octri_parser'
parser = OctriParser::Parser.new # or .new('/absolute/path/liboctri_parser_ffi.so')
report = parser.analyze(OctriParser::Source.text(spec_text))
```

Ruby `inspect(source, options)` returns parser inventory; zero-argument `inspect`
keeps Ruby's ordinary debugging representation.

PHP:

```php
$parser = new \Octri\OpenAPI\Parser(); // or ('/absolute/path/liboctri_parser_ffi.so')
$report = $parser->analyze(\Octri\OpenAPI\Source::text($specText));
```

PHP JSON objects remain `stdClass`, preserving `{}` versus `[]`. Use `stdClass`
for options and object sources. Enable the FFI extension and allow FFI calls for
the intended SAPI; CLI and web/FPM policy differ. The adapter does not change PHP
configuration or execute fallback subprocesses.

Swift:

```swift
let parser = try Parser()  // or Parser(library: "/absolute/path/liboctri_parser_ffi.dylib")
let report = try parser.analyze(.text(specText))
```

The Swift package loads the library at runtime with `dlopen`; released packages
carry it as a resource, so there is nothing to link. macOS consumers must declare
macOS 13 or later in their Package.swift. `JSONValue` preserves JSON
object/array/null distinctions and signed/unsigned 64-bit integers. `JSONKey`
compares original UTF-8 bytes because Swift String dictionaries otherwise merge
distinct NFC/NFD names. Use `JSONValue.decode`/`encoded` for this transport;
ordinary Foundation dictionaries do not preserve that distinction on Linux.
Desktop macOS
and Linux qualification does not imply iOS support.

Dart:

```dart
final parser = Parser(); // or Parser('/absolute/path/liboctri_parser_ffi.so')
final report = parser.analyze(Source.text(specText));
```

Dart uses `dart:ffi` on the native VM, not Dart web. Flutter mobile binaries and
mobile network policy need their own deployment work. Large calls belong in an
isolate; load a Parser inside that isolate. `Parser()` finds the bundled library
through the package configuration, which `dart compile exe` binaries lack; ship
the library beside such a binary and pass its path.

Rust:

```rust
let parser = octri_parser_sdk::Parser::default();
let report = parser.analyze(octri_parser_sdk::text(spec, "memory://project/api.yaml"))?;
```

Use the core crate with an explicit Resolver for applications that need custom
retrieval or no host I/O. The native facade is synchronous and clones options
per call; it holds no shared mutable report state.

## Runtime and memory contract

Calls block the current thread/isolate and can run concurrently when the host
supports threads. No async API claims to cancel synchronous native execution.
Use worker/process deadlines and memory caps for public untrusted workloads.
HTTP retrieval deadlines are separate from CPU deadlines. JSON host encoders may
allocate before the native 128 MiB envelope check; no host-memory sandbox is
claimed. Report/source allocation and graph expansion retain the core budgets.

Buffers never cross allocators: Rust lends input during one call, returns an
owned output, and adapters copy it before a guaranteed `finally`/`defer` release.
FFI unsafe Rust is isolated to `octri-parser-ffi`; core/resolver code still forbids
unsafe Rust. Pointer misuse by custom C callers is outside a safe-language wrapper's
contract. The library stays loaded while functions/buffers can be used.

Host number models differ. Go reports preserve `json.RawMessage`; JVM uses exact
integer/decimal nodes; Python/Ruby support large integers; Swift has signed and
unsigned 64-bit numbers. Dart/PHP numeric limits still apply beyond their signed
integer ranges. Original source text remains available for exact artifacts.
PHP/Dart `callJson(envelope)` returns lossless native JSON before host decoding;
use it when unsigned 64-bit values must stay exact. Their decoded `call`/operation
methods follow the host number model. Conformance checks raw native JSON for
those two adapters, and separately verifies their decoded numeric limits.
Use Rust or a lossless JSON consumer for exact round trips outside host ranges.

## Release artifacts

Local release candidates, for inspection before a release:

```sh
python3 -m venv artifacts/bindings/tools
artifacts/bindings/tools/bin/pip install build
node scripts/pack-bindings.mjs
```

That set holds this platform's native libraries and the language packages
without them, plus notices and a SHA-256 manifest. Registry packages come from
the `Release language packages` workflow instead:

1. `scripts/release-native.mjs` builds the shared library, static library and JNI
   bridge on each platform.
2. `scripts/release-assemble.mjs` builds platform wheels and gems, a Java jar and
   Dart package carrying every platform, the Go, PHP and Swift mirror trees and
   the C archives.
3. `scripts/release-verify.mjs` installs each package on each platform with its
   package manager and parses a spec without naming a library path.
4. A `v<version>` tag publishes to crates.io, PyPI, RubyGems, pub.dev and Maven
   Central, pushes and tags the mirrors and attaches the C archives to the
   GitHub release. Every binding carries the workspace version; the script
   refuses to assemble when a manifest disagrees.

Read the root validation record for actual platform/runtime results. Windows
remains experimental. Additional libc variants and mobile/browser targets require
their own compiled libraries and executable qualification.
