import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run with npm run pack:release");
const platform = `${process.platform}-${process.arch}`;
const directory = resolve("artifacts", "release", platform);
mkdirSync(directory, { recursive: true });
for (const name of ["node", "browser"])
  execFileSync(
    process.execPath,
    [npmCli, "pack", "--pack-destination", directory],
    { cwd: resolve("packages", name), stdio: "inherit" },
  );
const binary =
  process.platform === "win32" ? "octri-openapi.exe" : "octri-openapi";
copyFileSync(join("target", "release", binary), join(directory, binary));
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "SECURITY.md"])
  copyFileSync(file, join(directory, file));
const files = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== "manifest.json")
  .map((entry) => entry.name)
  .sort()
  .map((name) => {
    const bytes = readFileSync(join(directory, name));
    return {
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(
    {
      platform,
      node: process.version,
      version: JSON.parse(readFileSync("package.json", "utf8")).version,
      distribution:
        "local release candidates; no registry publication performed",
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Release candidates written to ${directory}`);
