#!/usr/bin/env node
/**
 * Sync skills/perp-cli/SKILL.md `metadata.version` and the install-guard
 * comment to package.json's version field, and keep packages/perp-ws
 * (@hypurrquant/perp-ws, built from the same src/ws) in lockstep: its
 * `version` must equal perp-cli's.
 *
 * Two modes:
 *   - default   — write SKILL.md with the synced version (used by
 *                 `prepublishOnly` so the published bundle never drifts)
 *   - --check   — exit non-zero if SKILL.md would have been changed,
 *                 without writing. Wire this into CI to fail PRs that
 *                 bump package.json without re-running the sync.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgPath = resolve(root, "package.json");
const skillPath = resolve(root, "skills/perp-cli/SKILL.md");

const isCheck = process.argv.includes("--check");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const skill = readFileSync(skillPath, "utf-8");

const updated = skill
  .replace(/^(\s*version:\s*)"[\d.]+"/m, `$1"${pkg.version}"`)
  .replace(/(must be >= )[\d.]+/g, `$1${pkg.version}`);

const wsPkgPath = resolve(root, "packages/perp-ws/package.json");
const wsPkgText = readFileSync(wsPkgPath, "utf-8");
const wsPkg = JSON.parse(wsPkgText);
const wsDrift = wsPkg.version !== pkg.version;

if (updated === skill && !wsDrift) {
  console.log(`[sync-skill-version] OK (SKILL.md and @hypurrquant/perp-ws already at ${pkg.version})`);
  process.exit(0);
}

if (isCheck) {
  if (updated !== skill) console.error(`[sync-skill-version] DRIFT — SKILL.md is not synced to package.json@${pkg.version}`);
  if (wsDrift) console.error(`[sync-skill-version] DRIFT — packages/perp-ws is ${wsPkg.version}, perp-cli is ${pkg.version}`);
  console.error(`  Fix: pnpm run sync-skill-version`);
  process.exit(1);
}

if (updated !== skill) {
  writeFileSync(skillPath, updated, "utf-8");
  console.log(`[sync-skill-version] SKILL.md synced to ${pkg.version}`);
}
if (wsDrift) {
  wsPkg.version = pkg.version;
  writeFileSync(wsPkgPath, `${JSON.stringify(wsPkg, null, 2)}\n`, "utf-8");
  console.log(`[sync-skill-version] packages/perp-ws synced to ${pkg.version}`);
}
