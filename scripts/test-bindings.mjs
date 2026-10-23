import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const build = JSON.parse(readFileSync("artifacts/bindings/build.json", "utf8"));
const fixtures = JSON.parse(readFileSync("fixtures/cases.json", "utf8"));
const validationCases = JSON.parse(
  readFileSync("fixtures/validation-cases.json", "utf8"),
);
const cases = [];
function add(name, envelope, valid) {
  cases.push({ name, envelope, valid });
}
for (const fixture of [...fixtures, ...validationCases]) {
  for (const mode of ["compatible", "strict"]) {
    for (const generated of [false, true]) {
      const content =
        typeof fixture.input === "string"
          ? fixture.input
          : JSON.stringify(fixture.input);
      // Text fixtures cannot be labelled generated JSON when they contain YAML.
      if (generated && typeof fixture.input === "string") continue;
      const input = { uri: "memory://octri/openapi.yaml", content, generated };
      const options = {
        ...fixture.options,
        validate: { ...fixture.options?.validate, mode },
      };
      for (const operation of [
        "parse",
        "resolve",
        "bundle",
        "dereference",
        "validate",
        "inspect",
        "analyze",
      ]) {
        add(
          `${fixture.name}/${mode}/${generated}/${operation}`,
          {
            abiVersion: 1,
            action: "report",
            request: { operation, input, options },
          },
          mode === "strict" && operation === "analyze"
            ? fixture.valid
            : undefined,
        );
      }
      for (const operation of ["parse", "bundle", "dereference", "validate"]) {
        add(`${fixture.name}/${mode}/${generated}/document/${operation}`, {
          abiVersion: 1,
          action: "document",
          request: { operation, input, options },
        });
      }
    }
  }
}
for (const format of ["json", "yaml", "xml"]) {
  add(`serialize/${format}`, {
    abiVersion: 1,
    action: "serialize",
    document: JSON.stringify({
      "雪/~/😀": [true, false, null, 1.5, "line\ntext"],
      emptyObject: {},
      emptyArray: [],
    }),
    format,
  });
}
add("serialize/output-limit", {
  abiVersion: 1,
  action: "serialize",
  document: '"too long"',
  format: "json",
  limits: { maxOutputBytes: 2 },
});
add("unknown-action", { abiVersion: 1, action: "unknown" });
add("unknown-version", {
  abiVersion: 2,
  action: "serialize",
  document: "{}",
  format: "json",
});
add("unknown-envelope-field", {
  abiVersion: 1,
  action: "serialize",
  document: "{}",
  format: "json",
  ignored: true,
});
const redirectedInput = {
  uri: "https://api.example/openapi.json",
  content: JSON.stringify({
    openapi: "3.2.1",
    info: { title: "Retrieval identity", version: "1" },
    paths: {},
    components: {
      schemas: { Pet: { $ref: "https://old.example/pet.json#Pet" } },
    },
  }),
  generated: false,
};
const redirectedOptions = {
  retrievalAliases: {
    "https://old.example/pet.json": "https://cdn.example/v2/pet.json",
  },
  files: {
    "https://cdn.example/v2/pet.json": JSON.stringify({
      $anchor: "Pet",
      type: "object",
      properties: { name: { $ref: "child.json" } },
    }),
    "https://cdn.example/v2/child.json":
      '{"type":"number","example":0.100000000000000005}',
  },
};
for (const operation of ["analyze", "bundle", "dereference"]) {
  add(
    `retrieval-alias/${operation}`,
    {
      abiVersion: 1,
      action: "report",
      request: {
        operation,
        input: redirectedInput,
        options: redirectedOptions,
      },
    },
    true,
  );
  add(
    `authored-bom/${operation}`,
    {
      abiVersion: 1,
      action: "report",
      request: {
        operation,
        input: {
          ...redirectedInput,
          content:
            '\uFEFF{"openapi":"3.2.1","info":{"title":"BOM API","version":"1"},"paths":{}}',
        },
      },
    },
    true,
  );
}
add(
  "retrieval-alias/cycle",
  {
    abiVersion: 1,
    action: "report",
    request: {
      operation: "analyze",
      input: redirectedInput,
      options: {
        retrievalAliases: {
          "https://old.example/pet.json": "https://cdn.example/pet.json",
          "https://cdn.example/pet.json": "https://old.example/pet.json",
        },
      },
    },
  },
  false,
);

const minimal = {
  uri: "memory://test/api.json",
  content:
    '{"openapi":"3.1.2","info":{"title":"Large integer","version":"1"},"paths":{},"x-number":9007199254740993}',
  generated: false,
};
add("exact-integer", {
  abiVersion: 1,
  action: "report",
  request: { operation: "parse", input: minimal },
});
add("unknown-options", {
  abiVersion: 1,
  action: "report",
  request: { operation: "parse", input: minimal, options: { unknown: true } },
});
let nested = "leaf";
for (let index = 0; index < 120; index++) nested = [nested];
add("deep-source-report", {
  abiVersion: 1,
  action: "report",
  request: {
    operation: "parse",
    input: {
      uri: "memory://test/deep.json",
      content: JSON.stringify({
        openapi: "3.1.2",
        info: { title: "Deep", version: "1" },
        paths: {},
        "x-deep": nested,
      }),
    },
  },
});
for (const content of [
  '{"openapi":"3.1.2","openapi":"3.0.4"}',
  "[".repeat(256) + "0" + "]".repeat(256),
]) {
  add("malformed-input", {
    abiVersion: 1,
    action: "report",
    request: {
      operation: "analyze",
      input: { uri: "memory://test/api.json", content },
    },
  });
}
const forbidden = {
  openapi: "3.1.2",
  info: { title: "File denial", version: "1" },
  paths: {},
  components: { schemas: { Secret: { $ref: "file:///etc/passwd" } } },
};
add("content-file-authority-denied", {
  abiVersion: 1,
  action: "report",
  request: {
    operation: "analyze",
    input: { uri: "file:///tmp/api.json", content: JSON.stringify(forbidden) },
  },
});
add("native-path", {
  abiVersion: 1,
  action: "report",
  request: {
    operation: "analyze",
    input: { uri: resolve("fixtures/pets.yaml") },
  },
});
if (process.env.OCTRI_BINDINGS_SPEC) {
  const content = readFileSync(process.env.OCTRI_BINDINGS_SPEC, "utf8");
  for (const mode of ["compatible", "strict"]) {
    for (const operation of [
      "parse",
      "resolve",
      "bundle",
      "dereference",
      "validate",
      "inspect",
      "analyze",
    ]) {
      add(`supplied-spec/${mode}/${operation}`, {
        abiVersion: 1,
        action: "report",
        request: {
          operation,
          input: { uri: "memory://test/combined.yaml", content },
          options: { validate: { mode } },
        },
      });
    }
  }
}
const root = resolve("artifacts/bindings");
mkdirSync(root, { recursive: true });
const input =
  cases.map(({ envelope }) => JSON.stringify(envelope)).join("\n") + "\n";
writeFileSync(join(root, "requests.jsonl"), input);
writeFileSync(
  join(root, "cases.json"),
  JSON.stringify(
    cases.map(({ envelope, ...rest }) => rest),
    null,
    2,
  ) + "\n",
);

const java = join(build.javaHome, "bin/java");
const classpath = [
  build.javaJar,
  resolve("bindings/java/target/test-classes"),
  build.dependencies,
].join(delimiter);
const commands = [
  ["rust", resolve("target/release/examples/bindingcheck"), []],
  [
    "python",
    "python3",
    ["bindings/python/check.py", build.library],
    { PYTHONPATH: resolve("bindings/python/src") },
  ],
  ["go", build.goCheck, []],
  [
    "java",
    java,
    [
      "-Xcheck:jni",
      "-cp",
      classpath,
      "dev.octri.parser.BindingCheck",
      build.library,
      build.jniLibrary,
    ],
  ],
  [
    "kotlin",
    java,
    [
      "-Xcheck:jni",
      "-cp",
      [
        build.kotlinCheck,
        build.kotlinJar,
        build.javaJar,
        build.dependencies,
      ].join(delimiter),
      "BindingCheckKt",
      build.library,
      build.jniLibrary,
    ],
  ],
  [
    "php",
    "php",
    ["-d", "ffi.enable=true", "bindings/php/check.php", build.library],
  ],
  ["ruby", "ruby", ["bindings/ruby/check.rb", build.library]],
  ["swift", build.swiftCheck, [build.library]],
  ["dart", build.dartCheck, [build.library]],
];
const selected = process.argv.slice(2);
const rows = [];
for (const [language, command, args, extraEnv] of commands) {
  if (selected.length && !selected.includes(language) && language !== "rust")
    continue;
  const output = execFileSync(command, args, {
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, ...extraEnv },
  });
  const filename = join(root, `${language}.jsonl`);
  writeFileSync(filename, output);
  const lines = output.trim().split("\n");
  assert.equal(
    lines.length,
    cases.length,
    `${language}: unexpected output line count`,
  );
  // Python compares parsed numeric values exactly; JavaScript JSON.parse would
  // erase the deliberate >2^53 integer transport regression.
  execFileSync(
    "python3",
    [
      "-c",
      `import json,sys,re
from pathlib import Path
expected=[json.loads(s) for s in Path(sys.argv[1]).read_text(encoding='utf-8').split(chr(10)) if s]
actual=[json.loads(s) for s in Path(sys.argv[2]).read_text(encoding='utf-8').split(chr(10)) if s]
cases=json.loads(Path(sys.argv[3]).read_text(encoding='utf-8'))
assert len(expected)==len(actual)==len(cases)
def normalize_transport_columns(result):
 error=result.get('Err')
 if error and error.get('diagnostics') and all(d['code']=='INVALID_REQUEST' for d in error['diagnostics']):
  # Host encoders vary envelope whitespace. Only the transport byte column
  # varies; source-document positions and all other diagnostics stay exact.
  error['message']=re.sub(r' at line [0-9]+ column [0-9]+$', '', error['message'])
  for diagnostic in error['diagnostics']:
   diagnostic['message']=re.sub(r' at line [0-9]+ column [0-9]+$', '', diagnostic['message'])
 return result
for index,(left,right,case) in enumerate(zip(expected,actual,cases)):
 assert normalize_transport_columns(left)==normalize_transport_columns(right), f"{case['name']}: transport mismatch at {index}"
 if 'valid' in case: assert right['Ok']['valid']==case['valid'],case['name']
`,
      join(root, "rust.jsonl"),
      filename,
      join(root, "cases.json"),
    ],
    { stdio: "inherit" },
  );
  rows.push({
    language,
    cases: cases.length,
    fullReportAndDocumentParity: true,
    structuredErrors: true,
    consumerMethods: true,
    transport: ["php", "dart"].includes(language)
      ? "lossless native JSON; decoded integer-range behavior tested separately"
      : "host-decoded JSON values",
  });
  console.log(
    `${language}: ${cases.length} exact native transport cases and language consumer checks passed`,
  );
}
writeFileSync(
  join(root, "results.json"),
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cases: cases.length,
      languages: rows,
      notes:
        "Complete report/document/error equality with Rust SDK transport oracle, including source text/locations, graph IDs and exact >2^53 integers. PHP/Dart use lossless callJson output; their decoded number model is checked separately. Only serde INVALID_REQUEST envelope byte columns are normalized because host encoders use different whitespace; source diagnostics stay exact. Both modes; generated JSON and textual inputs. Finite fixtures, not universal conformance. Consumer checks exercise facade methods, writer, errors, recovery and concurrency where supported.",
    },
    null,
    2,
  ) + "\n",
);
