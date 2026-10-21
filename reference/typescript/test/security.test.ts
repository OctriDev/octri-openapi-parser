import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import P, { isPublicAddress } from "../src/index.js";
import { schemas, api } from "./helpers.js";
let root: string, server: Server, origin: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "octri-parser-"));
  await mkdir(join(root, "allowed"));
  await writeFile(
    join(root, "allowed", "api.json"),
    JSON.stringify(schemas({ A: { $ref: "model.yaml" } })),
  );
  await writeFile(join(root, "allowed", "model.yaml"), "type: string");
  await writeFile(join(root, "outside.yaml"), "type: number");
  await symlink(
    join(root, "outside.yaml"),
    join(root, "allowed", "escape.yaml"),
  );
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/spec" }).end();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" }).end();
      return;
    }
    if (req.url === "/large") {
      res.end("x".repeat(1024));
      return;
    }
    if (req.url === "/bad-scheme") {
      res.writeHead(302, { location: "file:///etc/passwd" }).end();
      return;
    }
    if (req.url === "/schema") {
      res.end("type: string");
      return;
    }
    if (req.url === "/spec") {
      res.end(JSON.stringify(schemas({ A: { $ref: "/schema" } })));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
describe("filesystem policy", () => {
  it("reads explicit input and fences relative references", async () => {
    const p = new P();
    const d = await p.dereference(join(root, "allowed", "api.json"));
    expect((d.components as any).schemas.A.type).toBe("string");
    expect(p.$refs.paths("file")).toHaveLength(2);
  });
  it("blocks directory traversal", async () => {
    await expect(
      P.resolve({
        uri: join(root, "allowed", "api.json"),
        content: schemas({ A: { $ref: "../outside.yaml" } }),
      }),
    ).rejects.toThrow(/escapes/);
  });
  it("blocks symlink escape", async () => {
    await expect(
      P.resolve({
        uri: join(root, "allowed", "api.json"),
        content: schemas({ A: { $ref: "escape.yaml" } }),
      }),
    ).rejects.toThrow(/escapes/);
  });
  it("lets a caller explicitly widen root", async () => {
    expect(
      await P.resolve(
        {
          uri: join(root, "allowed", "api.json"),
          content: schemas({ A: { $ref: "../outside.yaml" } }),
        },
        { resolve: { file: { root } } },
      ),
    ).toBeTruthy();
  });
  it("disables filesystem access for object input and when explicitly disabled", async () => {
    await expect(
      P.resolve(schemas({ A: { $ref: "file:///etc/passwd" } })),
    ).rejects.toThrow(/disabled/);
    await expect(
      P.parse(join(root, "allowed", "api.json"), { resolve: { file: false } }),
    ).rejects.toThrow(/disabled/);
  });
});
describe("network policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])("rejects private/special address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "recognizes public %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
  it("disables HTTP by default", async () => {
    await expect(P.parse(origin + "/spec")).rejects.toThrow(/disabled/);
  });
  it("blocks private addresses even with network enabled", async () => {
    await expect(
      P.parse(origin + "/spec", { resolve: { http: true } }),
    ).rejects.toThrow(/blocked/);
  });
  it("supports explicitly trusted private endpoints and remote transitive refs", async () => {
    const p = new P({ resolve: { http: { allowPrivate: true } } });
    const d = await p.dereference(origin + "/spec");
    expect((d.components as any).schemas.A.type).toBe("string");
    expect(p.$refs.paths("http")).toHaveLength(2);
  });
  it("revalidates each redirect and enforces redirect limit", async () => {
    await expect(
      P.parse(origin + "/redirect", {
        resolve: { http: { allowPrivate: true } },
      }),
    ).resolves.toBeTruthy();
    await expect(
      P.parse(origin + "/loop", {
        resolve: { http: { allowPrivate: true, maxRedirects: 1 } },
      }),
    ).rejects.toThrow(/Redirect limit/);
    await expect(
      P.parse(origin + "/bad-scheme", {
        resolve: { http: { allowPrivate: true } },
      }),
    ).rejects.toThrow(/Unsafe URL/);
  });
  it("enforces host allowlist", async () => {
    await expect(
      P.parse(origin + "/spec", {
        resolve: { http: { allowPrivate: true, allowHosts: ["example.com"] } },
      }),
    ).rejects.toThrow(/allowlist/);
  });
  it("bounds response bytes", async () => {
    await expect(
      P.parse(origin + "/large", {
        resolve: { http: { allowPrivate: true } },
        limits: { maxDocumentBytes: 100 },
      }),
    ).rejects.toThrow(/exceeds byte/);
  });
  it("rejects credentials in URLs", async () => {
    await expect(
      P.parse(origin.replace("http://", "http://user:pass@") + "/spec", {
        resolve: { http: { allowPrivate: true } },
      }),
    ).rejects.toThrow(/credentials/);
  });
});
describe("data/URI hardening", () => {
  it("supports hash characters in property names", async () => {
    const d = await P.dereference(
      schemas({
        "a#b": { type: "string" },
        A: { $ref: "#/components/schemas/a%23b" },
      }),
    );
    expect((d.components as any).schemas.A.type).toBe("string");
  });
  it("ignores unsupported reference siblings and retains description override", async () => {
    const input = {
      ...api(),
      components: { responses: { R: { description: "Original" } } },
      paths: {
        "/x": {
          get: {
            responses: {
              200: {
                $ref: "#/components/responses/R",
                description: "Override",
                headers: { X: { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };
    const p = new P();
    const d = await p.dereference(input);
    expect((d.paths as any)["/x"].get.responses[200]).toEqual({
      description: "Override",
    });
    expect(
      p.diagnostics.some((d) => d.code === "IGNORED_REFERENCE_SIBLING"),
    ).toBe(true);
  });
  it("rejects deep YAML before value conversion", async () => {
    const yaml =
      "openapi: 3.1.0\nx: " + "[".repeat(100) + "0" + "]".repeat(100);
    await expect(
      P.parse(yaml, { limits: { maxDepth: 50 } }),
    ).rejects.toMatchObject({ code: "LIMIT_DEPTH" });
  });
  it("never reads a reference-like literal embedded schema identifier", async () => {
    const d = schemas({
      A: {
        type: "string",
        examples: [
          { $id: "https://example.test/evil", $ref: "file:///etc/passwd" },
        ],
      },
    });
    await expect(P.bundle(d)).resolves.toBeTruthy();
  });
});
