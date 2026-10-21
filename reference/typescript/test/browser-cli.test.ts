import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, schemas } from "./helpers.js";
describe("browser bundle", () => {
  it("runs without Node process, Buffer or filesystem globals", async () => {
    const result = await build({
      entryPoints: ["dist/browser.js"],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "OctriParser",
      platform: "browser",
      target: "es2022",
    });
    const context = {
      URL,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      structuredClone,
      console,
    };
    const Parser = runInNewContext(
      result.outputFiles[0]!.text + "\nOctriParser.OpenAPIParser",
      context,
    );
    const d = await Parser.bundle(schemas({ A: { $ref: "a.yaml" } }), {
      files: { "a.yaml": "type: string" },
    });
    expect(d.components.schemas.A.type).toBe("string");
    expect((await Parser.analyze(api("3.2.0"))).valid).toBe(true);
  });
});
describe("CLI", () => {
  const cli = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      input,
      timeout: 10000,
    });
  it("prints help and version", () => {
    expect(cli(["--help"]).stdout).toContain("Usage:");
    expect(cli(["--version"]).stdout.trim()).toBe("1.0.0");
  });
  it("validates stdin with JSON output", () => {
    const r = cli(["validate", "-"], JSON.stringify(api()));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      valid: true,
      dialect: "openapi3.1",
    });
    expect(r.stderr).toBe("");
  });
  it("returns policy failure separately from usage failure", () => {
    const r = cli(["validate", "-"], JSON.stringify({ ...api(), info: {} }));
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).valid).toBe(false);
    expect(cli(["nonsense", "-"], "{}").status).toBe(2);
  });
  it("supports YAML output", () => {
    expect(
      cli(["parse", "-", "--format", "yaml"], JSON.stringify(api())).stdout,
    ).toContain("openapi: 3.1.2");
  });
  it("protects existing output files", async () => {
    const folder = await mkdtemp(join(tmpdir(), "octri-cli-"));
    const target = join(folder, "out.json");
    try {
      expect(
        cli(["parse", "-", "--output", target], JSON.stringify(api())).status,
      ).toBe(0);
      expect(
        cli(["parse", "-", "--output", target], JSON.stringify(api("3.2.0")))
          .status,
      ).toBe(2);
      expect(JSON.parse(await readFile(target, "utf8")).openapi).toBe("3.1.2");
      expect(
        cli(
          ["parse", "-", "--output", target, "--force"],
          JSON.stringify(api("3.2.0")),
        ).status,
      ).toBe(0);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
