#!/usr/bin/env node
/**
 * prepublishOnly of packages/perp-ws (@hypurrquant/perp-ws): fail on version drift from perp-cli,
 * delete the package's dist/ (no stale files), then rebuild it from src/ws/** with the same tsup
 * options as perp-cli/ws (tsup.perp-ws.config.ts). Runs from any cwd.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const step = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

step("node", ["scripts/sync-skill-version.mjs", "--check"]);
rmSync(resolve(root, "packages/perp-ws/dist"), { recursive: true, force: true });
step("pnpm", ["exec", "tsup", "--config", "tsup.perp-ws.config.ts"]);
const pkg = JSON.parse(readFileSync(resolve(root, "packages/perp-ws/package.json"), "utf8"));
if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  console.error("[perp-ws-prepublish] @hypurrquant/perp-ws must have no dependencies");
  process.exit(1);
}
console.log(`[perp-ws-prepublish] @hypurrquant/perp-ws ${pkg.version} built into packages/perp-ws/dist`);
