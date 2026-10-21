import { execFileSync } from "node:child_process";
for (const engine of ["chromium", "firefox", "webkit"]) {
  execFileSync(process.execPath, ["scripts/browser-test.mjs"], {
    stdio: "inherit",
    env: { ...process.env, OCTRI_BROWSER: engine, OCTRI_BROWSER_CHANNEL: "" },
  });
}
