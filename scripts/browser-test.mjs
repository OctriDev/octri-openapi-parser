import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const root = resolve(".");
const types = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
const server = createServer(async (request, response) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
  );
  try {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Octri WASM tests</title>");
      return;
    }
    const path = resolve(
      root,
      "." +
        decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    );
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      types[extname(path)] ?? "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const engine = process.env.OCTRI_BROWSER ?? "chromium";
const browserType = { chromium, firefox, webkit }[engine];
assert(browserType, `Unsupported browser: ${engine}`);
try {
  browser = await browserType.launch(
    process.env.OCTRI_BROWSER_CHANNEL
      ? { channel: process.env.OCTRI_BROWSER_CHANNEL }
      : {},
  );
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { default: P, serialize } =
      await import("/packages/browser/dist/index.js");
    const { specification } = await import("/scripts/workloads.mjs");
    const fixtures = await fetch("/fixtures/cases.json").then((response) =>
      response.json(),
    );
    const failures = [];
    for (const fixture of fixtures) {
      const result = await P.analyze(fixture.input, {
        ...fixture.options,
        validate: { ...fixture.options?.validate, mode: "strict" },
      });
      if (result.valid !== fixture.valid)
        failures.push({ name: fixture.name, diagnostics: result.diagnostics });
    }
    const bomSource =
      '\uFEFF{"openapi":"3.2.1","info":{"title":"BOM API","version":"1"},"paths":{}}';
    const bomParser = new P();
    await bomParser.parse({
      uri: "https://api.example/openapi.json",
      content: bomSource,
    });
    if (
      bomParser.sources[0].text !== bomSource ||
      bomParser.api.info.title !== "BOM API" ||
      bomParser.sources[0].locations["/info/title"].offset !==
        new TextEncoder().encode(
          bomSource.slice(0, bomSource.indexOf('"BOM API"')),
        ).byteLength
    )
      failures.push({ name: "authored JSON BOM source and token locations" });
    const redirected = new P();
    await redirected.resolve(
      {
        uri: "https://api.example/openapi.json",
        content: {
          openapi: "3.1.2",
          info: { title: "Redirects", version: "1" },
          paths: {},
          components: {
            schemas: { Pet: { $ref: "https://old.example/pet.json#Pet" } },
          },
        },
      },
      {
        retrievalAliases: {
          "https://old.example/pet.json": "https://cdn.example/v2/pet.json",
        },
        files: {
          "https://cdn.example/v2/pet.json": {
            $anchor: "Pet",
            type: "object",
            properties: { "a/b": { $ref: "child.json" } },
          },
          "https://cdn.example/v2/child.json": { type: "string" },
        },
      },
    );
    if (
      redirected.$refs.get("https://old.example/pet.json#Pet").type !==
        "object" ||
      redirected.$refs.get("https://old.example/pet.json#/properties/a~1b")
        .type !== "string" ||
      !redirected.$refs.exists("https://old.example/pet.json#Pet") ||
      redirected.sources.some(
        (source) => source.uri === "https://old.example/pet.json",
      )
    )
      failures.push({
        name: "retrieval alias registry and physical provenance",
      });
    const operation = (id) => ({
      operationId: id,
      description: `Description for ${id}`,
      "x-interfacer-namespace": "events",
      responses: { 204: { description: "Copied" } },
    });
    const custom = await P.analyze(
      {
        openapi: "3.2.1",
        info: { title: "Custom methods", version: "1" },
        paths: { "/events": { $ref: "events.json" } },
      },
      {
        files: {
          "events.json": {
            additionalOperations: {
              COPY: operation("upper"),
              copy: operation("lower"),
            },
          },
        },
        validate: { mode: "strict" },
      },
    );
    const methods = custom.inspection?.operations ?? [];
    if (
      !custom.valid ||
      methods.map((operation) => operation.method).join(",") !== "COPY,copy" ||
      methods.some(
        (operation) =>
          operation.description !==
            `Description for ${operation.operationId}` ||
          operation.extensions?.["x-interfacer-namespace"] !== "events" ||
          operation.location.uri !== "memory://octri/events.json",
      )
    ) {
      failures.push({
        name: "case-sensitive methods and referenced metadata",
        diagnostics: custom.diagnostics,
      });
    }
    const document = {
      openapi: "3.2.0",
      info: { title: "Pets", version: "1" },
      paths: {},
      components: {
        schemas: {
          Tree: {
            type: "object",
            properties: { child: { $ref: "#/components/schemas/Tree" } },
          },
          A: { $ref: "pet.yaml" },
        },
      },
    };
    const output = await P.dereference(document, {
      files: { "pet.yaml": "type: string\n" },
    });
    const identity =
      output.components.schemas.Tree.properties.child ===
      output.components.schemas.Tree;
    const bundled = await P.bundle(document, {
      files: { "pet.yaml": "type: string\n" },
    });
    const moved = await P.analyze({
      uri: "memory://fresh/moved.json",
      content: bundled,
    });
    const networkDenied = await P.analyze(
      {
        ...document,
        components: {
          schemas: { A: { $ref: "https://example.test/pet.json" } },
        },
      },
      { resolve: { http: true } },
    );
    const yaml = await serialize(bundled, "yaml");
    const yamlRoundtrip = await P.analyze({
      uri: "memory://fresh/from-yaml.yaml",
      content: yaml,
    });
    const missingVersion = {
      openapi: "3.1.2",
      info: { title: "Defaults" },
      paths: {},
    };
    const compatible = await P.analyze(missingVersion);
    const strict = await P.analyze(missingVersion, {
      validate: { mode: "strict" },
    });
    const compatibleOutput = await P.validate(missingVersion);
    const compatibleDefaultsPreserved =
      compatible.valid &&
      !strict.valid &&
      compatible.document.info.version === "0.1.0" &&
      compatibleOutput.info.version === "0.1.0" &&
      compatible.sources[0].document.info.version === undefined &&
      missingVersion.info.version === undefined;
    const workerInput = structuredClone(document);
    delete workerInput.info.version;
    const workerResult = await new Promise((resolve, reject) => {
      const worker = new Worker("/scripts/worker-test.js", { type: "module" });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Worker test timed out"));
      }, 15000);
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.postMessage({
        input: workerInput,
        options: { files: { "pet.yaml": "type: string\n" } },
      });
    });
    const source = moved.sources[0];
    const locations = source.locations;
    const sourceLocationsPreserved =
      locations["/info/title"].uri === source.uri &&
      locations["/info/title"].pointer === "/info/title" &&
      locations["/info/title"].line === undefined &&
      structuredClone(source).locations["/info/title"].pointer ===
        "/info/title" &&
      workerResult.report.sources[0].locations["/info/title"].pointer ===
        "/info/title";
    const largeWorker = await new Promise((resolve, reject) => {
      const worker = new Worker("/scripts/worker-test.js", { type: "module" });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Large Worker timed out"));
      }, 60000);
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.postMessage({ command: "memory", input: specification(5000) });
    });
    const workerTerminated = await new Promise((resolve, reject) => {
      const worker = new Worker("/scripts/worker-test.js", { type: "module" });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Termination probe timed out"));
      }, 15000);
      worker.onmessage = ({ data }) => {
        if (data.started) {
          clearTimeout(timer);
          worker.terminate();
          resolve(true);
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.postMessage({ command: "terminate", input: specification(5000) });
    });
    let accessorCalls = 0;
    const accessorKeys = [
      "uri",
      "content",
      "files",
      "limits",
      "resolve",
      "validate",
      "dereference",
    ];
    const originalAccessors = accessorKeys.map((key) =>
      Object.getOwnPropertyDescriptor(Object.prototype, key),
    );
    let inheritedAccessorsIgnored = false;
    try {
      for (const key of accessorKeys)
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            accessorCalls++;
            return undefined;
          },
        });
      const parsed = await P.parse(missingVersion, {});
      inheritedAccessorsIgnored =
        parsed.info.title === "Defaults" && accessorCalls === 0;
    } finally {
      accessorKeys.forEach((key, index) => {
        if (originalAccessors[index])
          Object.defineProperty(
            Object.prototype,
            key,
            originalAccessors[index],
          );
        else delete Object.prototype[key];
      });
    }
    return {
      fixtureCount: fixtures.length,
      compatibleDefaultsPreserved,
      workerDefaultPreserved:
        workerResult.report.document.info.version === "0.1.0" &&
        workerResult.report.sources[0].document.info.version === undefined,
      sourceLocationsPreserved,
      yamlRoundtripValid: yamlRoundtrip.valid,
      workerExecuted: workerResult.ok && workerResult.report.valid,
      failures,
      identity,
      movedBundleValid: moved.valid,
      networkDenied:
        !networkDenied.valid &&
        networkDenied.diagnostics.some((d) => d.code === "RESOLVER_DENIED"),
      globalsClean: !("Buffer" in globalThis) && !("process" in globalThis),
      largeWorker,
      workerTerminated,
      inheritedAccessorsIgnored,
    };
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.identity, true);
  assert.equal(result.sourceLocationsPreserved, true);
  assert.equal(result.compatibleDefaultsPreserved, true);
  assert.equal(result.workerDefaultPreserved, true);
  assert.equal(result.yamlRoundtripValid, true);
  assert.equal(result.workerExecuted, true);
  assert.equal(result.movedBundleValid, true);
  assert.equal(result.networkDenied, true);
  assert.equal(result.globalsClean, true);
  assert.equal(result.largeWorker.ok, true);
  assert.equal(result.largeWorker.operations, 5000);
  assert.equal(result.largeWorker.memoryBytes.length, 8);
  // WASM memory is a high-water allocation, not live heap. Repeated requests
  // should reuse it after warmup rather than growing by one document per call.
  assert(
    result.largeWorker.memoryBytes[7] <=
      result.largeWorker.memoryBytes[2] * 1.25 + 16 * 1024 * 1024,
  );
  assert.equal(result.workerTerminated, true);
  assert.equal(result.inheritedAccessorsIgnored, true);
  assert.deepEqual(errors, []);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    `artifacts/browser.${engine}.json`,
    JSON.stringify(
      {
        engine,
        browser: browser.version(),
        csp: true,
        ...result,
        pageErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${engine} ${browser.version()}: ${result.fixtureCount} WASM fixtures, CSP, large Worker memory reuse, termination, identity and resolver isolation passed.`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
