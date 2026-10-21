import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rustEnvironment } from "./toolchain.mjs";

execFileSync(
  "cargo",
  ["build", "--locked", "--release", "-p", "octri-parser-node"],
  { stdio: "inherit", env: rustEnvironment() },
);
const filename =
  process.platform === "darwin"
    ? "liboctri_parser_node.dylib"
    : process.platform === "win32"
      ? "octri_parser_node.dll"
      : "liboctri_parser_node.so";
// Replace the inode atomically. Overwriting a previously loaded Mach-O file can
// leave stale code-signing pages in macOS's cache even when its bytes verify.
const staging = mkdtempSync("packages/node/.native-build-");
try {
  const addon = join(staging, "octri-parser.node");
  copyFileSync(`target/release/${filename}`, addon);
  renameSync(addon, "packages/node/octri-parser.node");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
