import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The workspace version every binding package and crate is released under. */
export const version = readFileSync("Cargo.toml", "utf8").match(
  /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/,
)[1];

/** Platform file name of a native library built from `name`. */
export const libraryFile = (name, kind = "shared") =>
  kind === "static"
    ? `lib${name}.a`
    : process.platform === "darwin"
      ? `lib${name}.dylib`
      : `lib${name}.so`;

export function findJavaHome() {
  let javaHome = process.env.JAVA_HOME;
  if (!javaHome && process.platform === "darwin") {
    const homebrew =
      "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
    javaHome = existsSync(homebrew)
      ? homebrew
      : execFileSync("/usr/libexec/java_home", ["-v", "11+"], {
          encoding: "utf8",
        }).trim();
  }
  if (!javaHome) throw new Error("JAVA_HOME must point to JDK 11 or newer");
  return javaHome;
}

/** Compile the JNI bridge against the C ABI library in `nativeDir`. */
export function buildJniBridge(javaHome, nativeDir, output) {
  const jniPlatform = process.platform === "darwin" ? "darwin" : "linux";
  execFileSync(
    "clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-fPIC",
      "-shared",
      "-Ibindings/c/include",
      `-I${join(javaHome, "include")}`,
      `-I${join(javaHome, "include", jniPlatform)}`,
      "bindings/java/native/bridge.c",
      `-L${nativeDir}`,
      "-loctri_parser_ffi",
      process.platform === "darwin"
        ? "-Wl,-rpath,@loader_path"
        : "-Wl,-rpath,$ORIGIN",
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
}
