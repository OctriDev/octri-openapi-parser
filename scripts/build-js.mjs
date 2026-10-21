import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";

execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "packages/tsconfig.json"],
  {
    stdio: "inherit",
  },
);
for (const name of ["node", "browser"]) {
  const destination = `packages/${name}/dist`;
  cpSync(`packages/dist/${name}`, destination, { recursive: true });
  cpSync("packages/dist/shared", `${destination}/shared`, { recursive: true });
  for (const file of [
    "numbers.mjs",
    "transport_json.mjs",
    "numbers.d.mts",
    "transport_json.d.mts",
  ])
    cpSync(`packages/shared/${file}`, `${destination}/shared/${file}`);
  for (const extension of ["js", "d.ts"]) {
    const path = `${destination}/index.${extension}`;
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll("../shared/", "./shared/"),
    );
  }
}
