# Security model

This parser accepts untrusted documents, not instructions or executable code.
Use GitHub private vulnerability reporting from this repository's Security tab.
If private reporting is unavailable, open an issue requesting a private contact
without including vulnerability details. Never put credentials, confidential
specifications or exploit payloads in a public issue.

## Retrieval authority

Core and browser WASM have no ambient I/O. Virtual files are supplied explicitly.
A native file-path input grants access only to its containing directory. A
content input never gains filesystem authority from a `file:` base URI; callers
must set `resolve.fileRoot` explicitly. Real paths must remain inside that root.
An open `cap-std` directory capability also prevents a later symlink swap from
escaping the root during open. Only regular UTF-8 files are read.

Native HTTP is disabled by default. When enabled, all DNS answers are checked,
then pinned to the connection. Proxies and automatic redirects are disabled.
Each redirect is rechecked for scheme, credentials, hostname and address policy.
Responses require successful status, identity encoding and bounded UTF-8 bodies.
Allowlisting hostnames does not implicitly permit private addresses.

Public address classification is conservative. Private, loopback, link-local,
multicast, documentation, reserved and transition ranges are denied, including
IPv4-mapped addresses, local-use NAT64, dummy IPv6, SRv6 and newer documentation
allocations. Classification follows the [IANA IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
and [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/).
`allowPrivate` explicitly changes this policy and should be restricted to trusted
applications. Host resolvers implemented by callers are trusted capabilities.

## Input and output controls

Depth, node, alias, source-byte, document-count and output-byte limits bound
parser allocations. Duplicate keys, recursive YAML aliases, custom executable
tags, merge keys, non-JSON values and reserved `__proto__` keys fail explicitly.
References are discovered only in API/schema syntax; examples, defaults and
extension payloads remain data. Encoded URI fragments are validated before
lookup. Graph serialization detects cycles and excessive shared expansion.

JavaScript adapters inspect input and option property descriptors before encoding.
Accessors, own serialization hooks and inherited `toJSON` hooks fail without
execution. Source envelopes use only own data properties. This boundary accepts
plain JSON data; caller-supplied JavaScript objects and proxies are not a sandbox.

The OpenAPI schemas are vendored, and the JSON Schema engine is built without
its file/HTTP resolver features. Validation never fetches a custom metaschema.
Custom vocabularies are preserved and disclosed with warnings.

## Operational boundaries

This library is not an OS sandbox. DNS uses the system resolver and its own
platform timeout behavior. HTTP request/body deadlines do not provide a hard
kill for synchronous parsing or DNS. Use a worker/process with memory and wall
clock limits when running a public multi-tenant service. Native Node requests
run off the JS thread but still consume the process's native worker pool.
Browser callers should use Workers and terminate the Worker when a hard abort
is required. Credentials in user-supplied URLs are rejected by native HTTP.

Additional native bindings use an explicitly loaded versioned C ABI. Only the
FFI crate permits unsafe Rust, confined to documented pointer ownership. Inputs
are borrowed for one call; outputs are copied and released through the allocating
library. Invalid custom C pointers, double frees and concurrent buffer mutation
are caller contract violations, not document capabilities. Native calls block
their caller; cancellation requires host worker/process containment. PHP/Dart
offer lossless `callJson` output for values beyond their decoded integer ranges.

Dependency lockfiles, Rust Clippy checks, npm audits and executable security
regressions accompany this project. A separate security assessment is still
required before exposing arbitrary public network resolution in a hosted service.
