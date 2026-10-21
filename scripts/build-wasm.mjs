import { execFileSync } from "node:child_process";
import { rustEnvironment } from "./toolchain.mjs";

const env = rustEnvironment();
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "-p",
    "octri-parser-wasm",
    "--target",
    "wasm32-unknown-unknown",
  ],
  { stdio: "inherit", env },
);
execFileSync(
  "wasm-bindgen",
  [
    "target/wasm32-unknown-unknown/release/octri_parser_wasm.wasm",
    "--target",
    "web",
    "--out-dir",
    "packages/browser/pkg",
    "--out-name",
    "octri_parser",
  ],
  { stdio: "inherit", env },
);
