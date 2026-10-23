/**
 * Install the assembled packages the way a user would and parse a spec with the
 * library each one bundles. No consumer is told where the native library is.
 *
 *   node scripts/release-verify.mjs [python|ruby|maven|dart|go|php|swift|c ...]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { checkElfPermissions } from "./binding-elf.mjs";
import { version } from "./native-build.mjs";

const packages = resolve("artifacts/packages");
const platform = `${process.platform}-${process.arch}`;
const spec =
  "openapi: 3.1.2\ninfo: {title: Installed, version: '1'}\npaths: {}\n";
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });

const consumers = {
  python(directory) {
    run("python3", ["-m", "venv", join(directory, "env")]);
    const python = join(directory, "env/bin/python");
    // pip picks the wheel by platform tag, which is what a user's install does.
    run(python, [
      "-m",
      "pip",
      "install",
      "--no-index",
      "--find-links",
      join(packages, "python"),
      `octri-openapi-parser==${version}`,
    ]);
    run(python, [
      "-c",
      "import sys;from octri_parser import Parser,Source;assert Parser().validate(Source.text(sys.argv[1]))['valid']",
      spec,
    ]);
  },

  ruby(directory) {
    const gems = join(directory, "gems");
    // A local install cannot choose among platform gems, so ask RubyGems which
    // one this host matches, as rubygems.org does, and require exactly one.
    const gem = run("ruby", [
      "-rrubygems/package",
      "-e",
      "m = Dir[File.join(ARGV[0], '*.gem')].select { |f| Gem::Platform.match_spec?(Gem::Package.new(f).spec) }; abort(m.inspect) unless m.size == 1; print m[0]",
      join(packages, "ruby"),
    ]);
    run("gem", ["install", "--no-document", "--install-dir", gems, gem]);
    run(
      "ruby",
      [
        "-e",
        "require 'octri_parser';abort unless OctriParser::Parser.new.validate(OctriParser::Source.text(ARGV[0]))['valid']",
        spec,
      ],
      { env: { ...process.env, GEM_HOME: gems, GEM_PATH: gems } },
    );
  },

  maven(directory) {
    const repository = `-Dmaven.repo.local=${join(directory, "m2")}`;
    for (const project of ["java", "kotlin"])
      run("mvn", [
        "-q",
        repository,
        "-f",
        join(packages, "maven", project, "pom.xml"),
        "install",
        "-DskipTests",
      ]);
    const classpath = join(directory, "classpath.txt");
    run("mvn", [
      "-q",
      repository,
      "-f",
      join(packages, "maven/kotlin/pom.xml"),
      "dependency:build-classpath",
      `-Dmdep.outputFile=${classpath}`,
    ]);
    const cp = [
      join(
        packages,
        "maven/kotlin/target",
        `openapi-parser-kotlin-${version}.jar`,
      ),
      readFileSync(classpath, "utf8").trim(),
    ].join(delimiter);
    writeFileSync(
      join(directory, "Consumer.java"),
      "import dev.octri.parser.Source;class Consumer{public static void main(String[]a)throws Exception{" +
        'if(!new dev.octri.parser.Parser().validate(Source.text(a[0]),null).path("valid").asBoolean())throw new AssertionError("java");' +
        'if(!new dev.octri.parser.kotlin.Parser().validate(Source.text(a[0]),null).path("valid").asBoolean())throw new AssertionError("kotlin");}}',
    );
    run("javac", ["--release", "11", "-cp", cp, "Consumer.java"], {
      cwd: directory,
    });
    run("java", [
      "-Xcheck:jni",
      "-cp",
      [directory, cp].join(delimiter),
      "Consumer",
      spec,
    ]);
  },

  dart(directory) {
    writeFileSync(
      join(directory, "pubspec.yaml"),
      `name: consumer\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\ndependencies:\n  octri_openapi_parser:\n    path: ${join(packages, "dart")}\n`,
    );
    writeFileSync(
      join(directory, "main.dart"),
      "import 'package:octri_openapi_parser/octri_openapi_parser.dart';void main(List<String>args){if(Parser().validate(Source.text(args[0]))['valid']!=true)throw StateError('consumer');}\n",
    );
    run("dart", ["pub", "get"], { cwd: directory });
    run("dart", ["run", "main.dart", spec], { cwd: directory });
  },

  go(directory) {
    const module = "github.com/octridev/octri-openapi-parser-go";
    writeFileSync(
      join(directory, "go.mod"),
      `module consumer\n\ngo 1.23\nrequire ${module} v${version}\nreplace ${module} => ${join(packages, "go")}\n`,
    );
    writeFileSync(
      join(directory, "main.go"),
      `package main\nimport("os";p "${module}")\nfunc main(){r,e:=(p.Parser{}).Validate(p.Text(os.Args[1],"memory://consumer/api.yaml"),nil);if e!=nil||!r.Valid{panic(e)}}\n`,
    );
    const env = { ...process.env, CGO_ENABLED: "1", GOWORK: "off" };
    delete env.CGO_LDFLAGS;
    run("go", ["build", "-o", "consumer", "."], { cwd: directory, env });
    checkElfPermissions(join(directory, "consumer"));
    run(join(directory, "consumer"), [spec]);
  },

  php(directory) {
    writeFileSync(
      join(directory, "composer.json"),
      JSON.stringify({
        repositories: [
          {
            type: "path",
            url: join(packages, "php"),
            options: { symlink: false },
          },
        ],
        require: { "octri/openapi-parser": "*" },
        "minimum-stability": "dev",
      }),
    );
    run(
      "composer",
      ["install", "--no-interaction", "--no-plugins", "--no-scripts"],
      {
        cwd: directory,
      },
    );
    writeFileSync(
      join(directory, "consumer.php"),
      "<?php require __DIR__.'/vendor/autoload.php'; $p=new \\Octri\\OpenAPI\\Parser();if(!$p->validate(\\Octri\\OpenAPI\\Source::text($argv[1]))->valid)throw new RuntimeException('consumer');",
    );
    run("php", ["-d", "ffi.enable=true", "consumer.php", spec], {
      cwd: directory,
    });
  },

  swift(directory) {
    mkdirSync(join(directory, "Sources/Consumer"), { recursive: true });
    writeFileSync(
      join(directory, "Package.swift"),
      `// swift-tools-version: 6.0\nimport PackageDescription\nlet package=Package(name:"Consumer",platforms:[.macOS(.v13)],dependencies:[.package(path:"${join(packages, "swift")}")],targets:[.executableTarget(name:"Consumer",dependencies:[.product(name:"OctriOpenAPIParser",package:"swift")])])\n`,
    );
    writeFileSync(
      join(directory, "Sources/Consumer/main.swift"),
      'import OctriOpenAPIParser\nlet r=try Parser().validate(.text(CommandLine.arguments[1]))\nprecondition(r["valid"] == .bool(true))\n',
    );
    run(
      "swift",
      [
        "run",
        "-c",
        "release",
        ...(process.platform === "linux"
          ? ["-Xlinker", "-z", "-Xlinker", "separate-code"]
          : []),
        "Consumer",
        spec,
      ],
      { cwd: directory },
    );
    checkElfPermissions(join(directory, ".build/release/Consumer"));
  },

  c(directory) {
    const name = `octri-openapi-parser-c-${version}-${platform}`;
    run("tar", [
      "-xzf",
      join(packages, "c", `${name}.tar.gz`),
      "-C",
      directory,
    ]);
    const root = join(directory, name);
    run("clang", [
      "-std=c11",
      `-I${join(root, "include")}`,
      resolve("bindings/c/check.c"),
      `-L${join(root, "lib")}`,
      "-loctri_parser_ffi",
      `-Wl,-rpath,${join(root, "lib")}`,
      "-o",
      join(directory, "check"),
    ]);
    run(join(directory, "check"), []);
  },
};

const requested = process.argv.slice(2);
for (const language of requested.length ? requested : Object.keys(consumers)) {
  assert(consumers[language], `Unknown package: ${language}`);
  const directory = mkdtempSync(join(tmpdir(), `octri-${language}-consumer-`));
  try {
    consumers[language](directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(`Installed ${language} ${version} package works on ${platform}`);
}
