import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { checkElfPermissions } from "./binding-elf.mjs";

const root = process.cwd();
const build = JSON.parse(readFileSync("artifacts/bindings/build.json", "utf8"));
const release = resolve(
  "artifacts/release",
  `${process.platform}-${process.arch}`,
  "bindings",
);
const manifest = JSON.parse(
  readFileSync(join(release, "manifest.json"), "utf8"),
);
for (const file of manifest.files) {
  const data = readFileSync(join(release, file.name));
  if (
    data.length !== file.bytes ||
    createHash("sha256").update(data).digest("hex") !== file.sha256
  )
    throw new Error(`Release checksum mismatch: ${file.name}`);
}
const directory = mkdtempSync(join(tmpdir(), "octri-binding-consumers-"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
const extract = (language) => {
  const target = join(directory, language);
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", join(release, `${language}-0.1.0.tar.gz`), "-C", target]);
  return target;
};
const passed = [];
try {
  const native = join(directory, "native");
  mkdirSync(native);
  for (const file of [build.library, build.jniLibrary])
    copyFileSync(join(release, basename(file)), join(native, basename(file)));
  const library = join(native, basename(build.library));
  const jni = join(native, basename(build.jniLibrary));
  checkElfPermissions(library);
  checkElfPermissions(jni);
  const spec =
    "openapi: 3.1.2\ninfo: {title: Installed, version: '1'}\npaths: {}\n";

  run("python3", ["-m", "venv", "python-env"]);
  const python = join(directory, "python-env/bin/python");
  const wheel = manifest.files.find((file) => file.name.endsWith(".whl")).name;
  run(python, ["-m", "pip", "install", "--no-index", join(release, wheel)]);
  run(python, [
    "-c",
    "import sys;from octri_parser import Parser,Source;assert Parser(sys.argv[1]).validate(Source.text(sys.argv[2]))['valid']",
    library,
    spec,
  ]);
  passed.push("python");

  const gems = join(directory, "gems");
  run("gem", [
    "install",
    "--local",
    "--no-document",
    "--install-dir",
    gems,
    join(release, "octri-openapi-parser-0.1.0.gem"),
  ]);
  const gemPaths = run("ruby", [
    "-e",
    "puts Gem.path.join(File::PATH_SEPARATOR)",
  ]).trim();
  run(
    "ruby",
    [
      "-e",
      "require 'octri_parser';abort unless OctriParser::Parser.new(ARGV[0]).validate(OctriParser::Source.text(ARGV[1]))['valid']",
      library,
      spec,
    ],
    {
      env: {
        ...process.env,
        GEM_HOME: gems,
        GEM_PATH: [gems, gemPaths].join(delimiter),
      },
    },
  );
  passed.push("ruby");

  const php = extract("php");
  run("composer", [
    "install",
    "--working-dir",
    php,
    "--no-dev",
    "--no-interaction",
    "--no-plugins",
    "--no-scripts",
  ]);
  writeFileSync(
    join(php, "consumer.php"),
    "<?php require __DIR__.'/vendor/autoload.php'; $p=new \\Octri\\OpenAPI\\Parser($argv[1]);if(!$p->validate(\\Octri\\OpenAPI\\Source::text($argv[2]))->valid)throw new RuntimeException('consumer');",
  );
  run("php", [
    "-d",
    "ffi.enable=true",
    join(php, "consumer.php"),
    library,
    spec,
  ]);
  passed.push("php");

  const jars = readdirSync(release)
    .filter((name) => name.endsWith(".jar"))
    .map((name) => join(release, name));
  const cp = jars.join(delimiter);
  writeFileSync(
    join(directory, "Consumer.java"),
    'import java.nio.file.Path;import dev.octri.parser.*;class Consumer{public static void main(String[]args)throws Exception{var p=new Parser(Path.of(args[0]),Path.of(args[1]));if(!p.validate(Source.text(args[2]),null).path("valid").asBoolean())throw new AssertionError();}}',
  );
  run(join(build.javaHome, "bin/javac"), [
    "--release",
    "11",
    "-cp",
    cp,
    "Consumer.java",
  ]);
  run(join(build.javaHome, "bin/java"), [
    "-Xcheck:jni",
    "-cp",
    [directory, cp].join(delimiter),
    "Consumer",
    library,
    jni,
    spec,
  ]);
  passed.push("java");
  writeFileSync(
    join(directory, "Consumer.kt"),
    'import java.nio.file.Path\nfun main(args:Array<String>){val p=dev.octri.parser.kotlin.Parser(Path.of(args[0]),Path.of(args[1]));check(p.validate(dev.octri.parser.Source.text(args[2])).path("valid").asBoolean())}\n',
  );
  run("kotlinc", [
    "Consumer.kt",
    "-jvm-target",
    "11",
    "-classpath",
    cp,
    "-include-runtime",
    "-d",
    "consumer.jar",
  ]);
  run(join(build.javaHome, "bin/java"), [
    "-Xcheck:jni",
    "-cp",
    [join(directory, "consumer.jar"), cp].join(delimiter),
    "ConsumerKt",
    library,
    jni,
    spec,
  ]);
  passed.push("kotlin");

  const go = extract("go");
  const goConsumer = join(directory, "go-consumer");
  mkdirSync(goConsumer);
  writeFileSync(
    join(goConsumer, "go.mod"),
    `module consumer\n\ngo 1.23\nrequire github.com/octridev/octri-openapi-parser/bindings/go v0.0.0\nreplace github.com/octridev/octri-openapi-parser/bindings/go => ${go}\n`,
  );
  writeFileSync(
    join(goConsumer, "main.go"),
    'package main\nimport("os";p "github.com/octridev/octri-openapi-parser/bindings/go")\nfunc main(){r,e:=(p.Parser{}).Validate(p.Text(os.Args[1],"memory://consumer/api.yaml"),nil);if e!=nil||!r.Valid{panic(e)}}\n',
  );
  run("go", ["run", ".", spec], {
    cwd: goConsumer,
    env: {
      ...process.env,
      CC: process.env.CC ?? "clang",
      CGO_ENABLED: "1",
      CGO_LDFLAGS: `-L${native} -Wl,-rpath,${native}`,
      GOWORK: "off",
    },
  });
  passed.push("go");

  const dart = extract("dart");
  const dartConsumer = join(directory, "dart-consumer");
  mkdirSync(dartConsumer);
  writeFileSync(
    join(dartConsumer, "pubspec.yaml"),
    `name: consumer\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\ndependencies:\n  octri_openapi_parser:\n    path: ${dart}\n`,
  );
  writeFileSync(
    join(dartConsumer, "main.dart"),
    "import 'package:octri_openapi_parser/octri_openapi_parser.dart';void main(List<String>args){if(Parser(args[0]).validate(Source.text(args[1]))['valid']!=true)throw StateError('consumer');}\n",
  );
  run("dart", ["pub", "get", "--offline"], { cwd: dartConsumer });
  run("dart", ["run", "main.dart", library, spec], { cwd: dartConsumer });
  passed.push("dart");

  const swift = extract("swift");
  const swiftConsumer = join(directory, "swift-consumer");
  mkdirSync(join(swiftConsumer, "Sources/Consumer"), { recursive: true });
  writeFileSync(
    join(swiftConsumer, "Package.swift"),
    `// swift-tools-version: 6.0\nimport PackageDescription\nlet package=Package(name:"Consumer",platforms:[.macOS(.v13)],dependencies:[.package(path:"${swift}")],targets:[.executableTarget(name:"Consumer",dependencies:[.product(name:"OctriOpenAPIParser",package:"swift")])])\n`,
  );
  writeFileSync(
    join(swiftConsumer, "Sources/Consumer/main.swift"),
    'import OctriOpenAPIParser\nlet p=try Parser()\nlet r=try p.validate(.text(CommandLine.arguments[1]))\nprecondition(r["valid"] == .bool(true))\n',
  );
  run(
    "swift",
    [
      "run",
      "-c",
      "release",
      "-Xlinker",
      `-L${native}`,
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      native,
      ...(process.platform === "linux"
        ? ["-Xlinker", "-z", "-Xlinker", "separate-code"]
        : []),
      "Consumer",
      spec,
    ],
    { cwd: swiftConsumer },
  );
  checkElfPermissions(join(swiftConsumer, ".build/release/Consumer"));
  passed.push("swift");

  const rust = extract("rust");
  // Reuse compiled dependency artifacts, but compile the installed SDK consumer
  // against the extracted source, not its original workspace path.
  const rustConsumer = join(directory, "rust-consumer");
  mkdirSync(join(rustConsumer, "src"), { recursive: true });
  writeFileSync(
    join(rustConsumer, "Cargo.toml"),
    `[package]\nname="binding-consumer"\nversion="0.0.0"\nedition="2024"\n[dependencies]\noctri-parser-sdk={path="${rust}/crates/octri-parser-sdk"}\n`,
  );
  writeFileSync(
    join(rustConsumer, "src/main.rs"),
    'fn main()->Result<(),Box<dyn std::error::Error>>{let p=octri_parser_sdk::Parser::default();let r=p.validate(octri_parser_sdk::text(std::env::args().nth(1).ok_or("missing source")?,"memory://consumer/api.yaml"))?;assert!(r.valid);Ok(())}\n',
  );
  run(
    process.execPath,
    [
      resolve(root, "scripts/cargo.mjs"),
      "run",
      "--offline",
      "--manifest-path",
      join(rustConsumer, "Cargo.toml"),
      "--",
      spec,
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "target") } },
  );
  passed.push("rust");
  writeFileSync(
    resolve(root, "artifacts/bindings/package-results.json"),
    JSON.stringify(
      {
        platform: process.platform,
        architecture: process.arch,
        manifestFilesVerified: manifest.files.length,
        consumers: passed,
        relocatedNativeLibraries: true,
        notes:
          "Fresh installed/extracted language packages outside repository; JNI, cgo and Swift link relocated platform libraries. No package publication.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Nine isolated binding package consumers passed: ${passed.join(", ")}`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
