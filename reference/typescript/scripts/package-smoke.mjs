import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const cwd = mkdtempSync(join(tmpdir(), "octri-package-"));
let tarball;
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
      encoding: "utf8",
    }),
  );
  tarball = resolve(packed[0].filename);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "parser-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--cache",
      "/tmp/octri-parser-npm-cache",
      tarball,
    ],
    { cwd, stdio: "pipe" },
  );
  const input = JSON.stringify({
    openapi: "3.1.2",
    info: { title: "Consumer", version: "1" },
    paths: {},
  });
  const esm = `import P from '@octri/openapi-parser'; const d=await P.validate(${input}); if(d.info.title!=='Consumer')throw Error('ESM consumer failed');`;
  execFileSync(process.execPath, ["--input-type=module", "-e", esm], {
    cwd,
    stdio: "pipe",
  });
  const cjs = `const P=require('@octri/openapi-parser').default; P.validate(${input}).then(d=>{if(d.info.title!=='Consumer')throw Error('CJS consumer failed');});`;
  execFileSync(process.execPath, ["-e", cjs], { cwd, stdio: "pipe" });
  writeFileSync(
    join(cwd, "consumer.ts"),
    `import P, {type Analysis} from '@octri/openapi-parser'; const report: Analysis = await P.analyze(${input}); console.log(report.valid);`,
  );
  writeFileSync(
    join(cwd, "consumer.cts"),
    `import Parser = require('@octri/openapi-parser'); const report: Promise<Parser.Analysis> = Parser.default.analyze(${input}); void report;`,
  );
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
      "consumer.cts",
    ],
    { cwd, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [join(cwd, "node_modules/@octri/openapi-parser/dist/cli.js"), "--version"],
    { cwd, stdio: "pipe" },
  );
  const browser = `import P from '@octri/openapi-parser/browser'; if(!(await P.analyze(${input})).valid)throw Error('Browser export failed');`;
  execFileSync(process.execPath, ["--input-type=module", "-e", browser], {
    cwd,
    stdio: "pipe",
  });
  console.log(
    "Packed tarball: ESM, CommonJS, NodeNext TypeScript, browser export and CLI consumers passed.",
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });
}
