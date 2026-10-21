import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check with npm run test:package");
const directory = mkdtempSync(join(tmpdir(), "octri-parser-consumer-"));
const run = (command, args, cwd = directory) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
try {
  run(
    process.execPath,
    [resolve("scripts/package-node-native.mjs")],
    resolve("."),
  );
  const nativeOutput = resolve(
    "artifacts/npm-native",
    `${process.platform}-${process.arch}`,
  );
  const nativeManifest = JSON.parse(
    readFileSync(join(nativeOutput, "manifest.json"), "utf8"),
  );
  const tarballs = [join(nativeOutput, nativeManifest.packages[0].filename)];
  for (const name of ["node", "browser"]) {
    const packed = JSON.parse(
      run(
        process.execPath,
        [npmCli, "pack", "--json", "--pack-destination", directory],
        resolve(`packages/${name}`),
      ),
    )[0];
    tarballs.push(join(directory, packed.filename));
    assert(packed.files.some((file) => file.path === "dist/index.js"));
    assert(packed.files.some((file) => file.path === "dist/index.d.ts"));
    assert(packed.files.some((file) => file.path === "THIRD_PARTY_NOTICES.md"));
    assert(
      packed.files.some((file) =>
        name === "node"
          ? file.path === "load-native.cjs"
          : file.path.endsWith(".wasm"),
      ),
    );
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(process.execPath, [
    npmCli,
    "install",
    "--ignore-scripts",
    "--cache",
    join(directory, "cache"),
    ...tarballs,
  ]);
  writeFileSync(
    join(directory, "smoke.mjs"),
    `import assert from 'node:assert/strict';
import Parser from '@octri/openapi-parser-native';
const output=await Parser.analyze({openapi:'3.1.2',info:{title:'Consumer',version:'1'},paths:{}});
assert.equal(output.valid,true); console.log('Isolated native consumer passed.');`,
  );
  process.stdout.write(run(process.execPath, ["smoke.mjs"]));
  writeFileSync(
    join(directory, "smoke.cjs"),
    `const assert = require('node:assert/strict');
const Parser = require('@octri/openapi-parser-native');
Parser.analyze({openapi:'3.1.2',info:{title:'CJS',version:'1'},paths:{}}).then(result=>{assert.equal(result.valid,true);console.log('CommonJS native consumer passed.');});`,
  );
  process.stdout.write(run(process.execPath, ["smoke.cjs"]));
  writeFileSync(
    join(directory, "consumer.cts"),
    `import Parser = require('@octri/openapi-parser-native');
void Parser.analyze({openapi:'3.1.2',info:{title:'CJS types',version:'1'},paths:{}});`,
  );

  writeFileSync(
    join(directory, "consumer.ts"),
    `import P, {type Options} from '@octri/openapi-parser-native';
import Browser from '@octri/openapi-parser-wasm';
const options:Options={dereference:{circular:'ignore'}};
await P.parse({openapi:'3.1.2',info:{title:'Consumer',version:'1'},paths:{}},options);
void Browser;`,
  );
  run(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "consumer.ts",
    "consumer.cts",
  ]);
  console.log(
    "Both packed packages include declarations, legal notices and real runtime artifacts.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
