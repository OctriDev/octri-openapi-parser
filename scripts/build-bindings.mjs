import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { rustEnvironment } from "./toolchain.mjs";
import { checkElfPermissions } from "./binding-elf.mjs";
import {
  buildJniBridge,
  findJavaHome,
  libraryFile,
  version,
} from "./native-build.mjs";

const root = process.cwd();
if (process.platform === "win32")
  throw new Error(
    "The nine-language binding builder supports macOS/Linux; Windows is experimental",
  );
const output = resolve("artifacts/bindings");
mkdirSync(output, { recursive: true });
const libraryName = libraryFile("octri_parser_ffi");
export const library = resolve("target/release", libraryName);
const run = (command, args, options = {}) =>
  execFileSync(
    command,
    command === "mvn"
      ? ["-Dmaven.wagon.http.retryHandler.count=3", ...args]
      : args,
    { stdio: "inherit", ...options },
  );
run(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "-p",
    "octri-parser-ffi",
    "-p",
    "octri-parser-sdk",
    "--example",
    "bindingcheck",
  ],
  { env: rustEnvironment() },
);
// A separate build is needed because --example selects examples, not cdylibs.
run("cargo", ["build", "--release", "--locked", "-p", "octri-parser-ffi"], {
  env: rustEnvironment(),
});
copyFileSync("bindings/c/include/octri_parser.h", "bindings/go/octri_parser.h");
if (process.platform === "darwin")
  run("install_name_tool", ["-id", `@rpath/${libraryName}`, library]);

const javaHome = findJavaHome();
const javaEnv = {
  ...process.env,
  JAVA_HOME: javaHome,
  PATH: `${join(javaHome, "bin")}${delimiter}${process.env.PATH}`,
};
const jniLibrary = resolve("target/release", libraryFile("octri_parser_jni"));
buildJniBridge(javaHome, resolve("target/release"), jniLibrary);
// Docker COPY can replace a source with an older timestamp than cached classes.
// Clean JVM outputs so neither bytecode targets nor public types survive stale.
run(
  "mvn",
  ["-q", "-f", "bindings/java/pom.xml", "clean", "install", "-DskipTests"],
  {
    env: javaEnv,
  },
);
run(
  "mvn",
  [
    "-q",
    "-f",
    "bindings/java/pom.xml",
    "dependency:build-classpath",
    `-Dmdep.outputFile=${resolve(output, "java-dependencies.txt")}`,
  ],
  { env: javaEnv },
);
const dependencies = readFileSync(
  join(output, "java-dependencies.txt"),
  "utf8",
).trim();
const javaJar = resolve(`bindings/java/target/openapi-parser-${version}.jar`);
const kotlinJar = resolve(
  `bindings/kotlin/target/openapi-parser-kotlin-${version}.jar`,
);
run(
  "mvn",
  ["-q", "-f", "bindings/kotlin/pom.xml", "clean", "package", "-DskipTests"],
  {
    env: javaEnv,
  },
);
// Kotlin's test consumer is compiled with the same compiler used by its package.
const kotlinCheck = resolve(output, "kotlin-check.jar");
run(
  "kotlinc",
  [
    "bindings/kotlin/src/test/kotlin/BindingCheck.kt",
    "-jvm-target",
    "11",
    "-classpath",
    [javaJar, kotlinJar, dependencies].join(delimiter),
    "-include-runtime",
    "-d",
    kotlinCheck,
  ],
  { env: javaEnv },
);

const nativeDir = resolve("target/release");
run("clang", [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  ...(process.platform === "linux" ? ["-fsanitize=address"] : []),
  "-g",
  "-Ibindings/c/include",
  "bindings/c/check.c",
  `-L${nativeDir}`,
  "-loctri_parser_ffi",
  `-Wl,-rpath,${nativeDir}`,
  "-o",
  resolve(output, "c-check"),
]);
run(resolve(output, "c-check"), [], { timeout: 30000, killSignal: "SIGKILL" });
const goEnv = {
  ...process.env,
  CC: process.env.CC ?? "clang",
  CGO_ENABLED: "1",
  CGO_LDFLAGS: `-L${nativeDir} -Wl,-rpath,${nativeDir}`,
  GOTOOLCHAIN: "local",
};
run("go", ["build", "-o", resolve(output, "go-check"), "./cmd/bindingcheck"], {
  cwd: resolve("bindings/go"),
  env: goEnv,
});
// Swift loads the C ABI at runtime, so only the Linux segment policy applies.
const swiftLinkerArgs =
  process.platform === "linux"
    ? ["-Xlinker", "-z", "-Xlinker", "separate-code"]
    : [];
run("swift", [
  "build",
  "-c",
  "release",
  "--package-path",
  "bindings/swift",
  "--product",
  "BindingCheck",
  ...swiftLinkerArgs,
]);
const swiftBin = execFileSync(
  "swift",
  [
    "build",
    "-c",
    "release",
    "--package-path",
    "bindings/swift",
    "--show-bin-path",
  ],
  { encoding: "utf8" },
).trim();
run("swift", [
  "test",
  "--parallel",
  "--num-workers",
  "4",
  "-c",
  "release",
  "--package-path",
  "bindings/swift",
  ...swiftLinkerArgs,
]);
run("dart", ["pub", "get"], { cwd: resolve("bindings/dart") });
run("dart", [
  "compile",
  "exe",
  "bindings/dart/bin/check.dart",
  "-o",
  resolve(output, "dart-check"),
]);
for (const path of [
  library,
  jniLibrary,
  join(swiftBin, "BindingCheck"),
  resolve(output, "go-check"),
  resolve(output, "dart-check"),
  resolve(output, "c-check"),
])
  checkElfPermissions(path);
writeFileSync(
  join(output, "build.json"),
  JSON.stringify(
    {
      root,
      library,
      jniLibrary,
      javaHome,
      javaJar,
      kotlinJar,
      dependencies,
      kotlinCheck,
      swiftCheck: join(swiftBin, "BindingCheck"),
      goCheck: resolve(output, "go-check"),
      dartCheck: resolve(output, "dart-check"),
    },
    null,
    2,
  ) + "\n",
);
console.log(`All native language consumers built: ${output}`);
