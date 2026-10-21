import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const blocks = [
  "THIRD-PARTY NOTICES\n\nProduction dependencies, including code bundled in the browser distribution.\nThis file is generated from the locked local installation.",
];
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev || !existsSync(path)) continue;
  const licenses = readdirSync(path).filter((f) =>
    /^(licen[sc]e|copying)(\.|$)/i.test(f),
  );
  blocks.push(
    `\n${"=".repeat(72)}\n${path.replace(/^node_modules\//, "")} ${pkg.version} (${pkg.license ?? "see package"})\n` +
      licenses.map((f) => readFileSync(join(path, f), "utf8")).join("\n"),
  );
}
writeFileSync("THIRD_PARTY_NOTICES.txt", blocks.join("\n"));
