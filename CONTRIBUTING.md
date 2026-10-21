# Contributing

Contributions are welcome. Read the project license, preserve third-party
notices and describe behavior changes with reproducible examples.

## Working style

Prefer descriptive names, short functions with one responsibility and comments
that explain invariants or tradeoffs. Keep parser behavior in Rust and adapters
small. Avoid generic frameworks, duplicated parser logic, broad catch-and-ignore
blocks, unchecked indexing of untrusted input and unexplained magic constants.
Use Rustfmt, Clippy and Prettier rather than personal formatting conventions.

A behavior change needs a focused regression and, when portable, a shared fixture
in `fixtures/cases.json`. Preserve source snapshots and diagnostic provenance.
Never weaken resolver policy to make a fixture pass. Explain intentional behavior
compatibility changes in the pull request and public README.

## Checks

```sh
node scripts/cargo.mjs fmt --all -- --check
node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings
node scripts/cargo.mjs test --workspace
npm run build:node
npm run build:wasm
npm run test:node
npm run test:parity
npm run test:swagger
npm run test:browser
npm run format:check
npm audit
```

Build the independent development reference with `npm ci --prefix reference/typescript`
and `npm run build --prefix reference/typescript` before running `test:parity`. The browser harness serves
only a temporary loopback test server and closes its browser/server on completion.
Set `OCTRI_BROWSER_CHANNEL=chrome` to use installed Chrome instead of Playwright's
Chromium. Evidence is written under ignored `artifacts/`.

Native language adapter changes also require the build, advisory audit, exact
transport matrix and isolated package consumers in [bindings/README.md](bindings/README.md).
Linux checks include both current runtimes and the Python 3.8/JVM 11/PHP 8.1
compatibility image, plus executable-permission checks. Keep ABI ownership and
numeric/Unicode behavior documented in [bindings/README.md](bindings/README.md).

Review the complete diff after checks. A fresh independent reviewer should inspect
reference transformations, security boundaries and public contracts before a
release. Document commands, failures, platform gaps and remaining risk.
