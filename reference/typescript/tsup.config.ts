import { defineConfig } from "tsup";
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    splitting: false,
  },
  {
    entry: ["src/browser.ts"],
    format: ["esm"],
    dts: true,
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    splitting: false,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.inject = ["src/browser-shims.ts"];
    },
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node22",
    splitting: false,
    sourcemap: true,
  },
]);
