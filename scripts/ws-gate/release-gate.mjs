#!/usr/bin/env node
// perp-cli/ws 0.15.0 release gate (plan ws-0.14.4 Phase 4). Required steps, output recorded to
// .omc/research/ws-0.15.0-release-gate.md (gitignored):
//   1. build (tsc + tsup) and the ws unit tests (incl. bundle purity: no Node built-ins / ws / Buffer /
//      process, no top-level await, no load-time globals, ES2020 syntax, API snapshot)
//   2. pnpm pack → tarball contents
//   3. install the tarball in a clean consumer: import perp-cli/ws + perp-cli/ws/node in Node; typecheck a
//      consumer with moduleResolution bundler / node16 / node10; typecheck every ```ts block of
//      skills/perp-cli/references/ws-library.md (taken from the installed package)
//   4. @arethetypeswrong/cli on the tarball
//   5. Next 13.5 (webpack, transpilePackages) build of examples/ws-funding-compare-browser via
//      examples/ws-next-smoke against the tarball; the client chunk carrying perp-cli/ws has no Node-only
//      references
//   6. Node example smoke: examples/ws-node-stream (public data, 15 s)
// Usage: node scripts/ws-gate/release-gate.mjs   (network: npm registry + venue WebSockets)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = join(REPO, ".omc/research/ws-0.15.0-release-gate.md");
const WORK = mkdtempSync(join(tmpdir(), "perp-ws-gate-"));
const steps = [];

function run(name, cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO, encoding: "utf8", env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const step = { name, cmd: `${cmd} ${args.join(" ")}`, cwd: opts.cwd ?? REPO, code: r.status, ms: Date.now() - t0, out };
  steps.push(step);
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${name} (${step.ms} ms)`);
  return step;
}

function check(name, ok, detail) {
  steps.push({ name, cmd: "(check)", cwd: "", code: ok ? 0 : 1, ms: 0, out: detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  return ok;
}

const tail = (s, n = 40) => s.split("\n").slice(-n).join("\n");

// 1. build + unit tests of the library
run("build (tsc + tsup)", "pnpm", ["-s", "run", "build"]);
run("ws unit tests (purity, parity, API snapshot, codecs, lifecycle)", "npx", ["vitest", "run", "src/__tests__/ws"]);

// 2. pack
const pack = run("pnpm pack", "pnpm", ["pack", "--pack-destination", WORK]);
const tgz = readdirSync(WORK).find(f => f.endsWith(".tgz"));
if (tgz === undefined) throw new Error("no tarball");
const TGZ = join(WORK, tgz);
const list = spawnSync("tar", ["-tzf", TGZ], { encoding: "utf8" }).stdout.split("\n");
const need = ["package/package.json", "package/dist/ws/index.js", "package/dist/ws/index.d.ts", "package/dist/ws/node.js", "package/dist/ws/node.d.ts", "package/skills/perp-cli/references/ws-library.md"];
check("tarball contents", need.every(f => list.includes(f)) && !list.some(f => /^package\/dist\/ws\/(?!index|node)/.test(f)),
  `${tgz}: ${list.filter(f => f.startsWith("package/dist/ws/")).join(", ")}; required present: ${need.filter(f => list.includes(f)).length}/${need.length}`);
void pack;

// 3. consumer install + imports + typecheck + skill code blocks
const C = join(WORK, "consumer");
mkdirSync(C, { recursive: true });
writeFileSync(join(C, "package.json"), JSON.stringify({ name: "ws-gate-consumer", private: true, type: "module" }));
run("consumer: npm install tarball + typescript", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", TGZ, "typescript@5", "@types/node@20"], { cwd: C });
writeFileSync(join(C, "imports.mjs"), `
const a = await import("perp-cli/ws"); const b = await import("perp-cli/ws/node");
for (const k of ["createVenueStream", "createFundingComparator", "toApr", "toHourly", "hyperliquid", "pacifica", "lighter", "lighterRh", "aster", "arcus"]) if (typeof a[k] === "undefined") throw new Error("missing export " + k);
if (typeof b.nodeTransport !== "function") throw new Error("missing nodeTransport");
delete globalThis.WebSocket;
try { a.createVenueStream(a.hyperliquid, { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }); throw new Error("expected INVALID_PARAMS"); }
catch (e) { if (e.structured?.code !== "INVALID_PARAMS") throw e; }
console.log("imports ok:", Object.keys(a).length, "exports; node extra:", Object.keys(b).filter(k => !(k in a)).join(","));
`);
run("consumer: import perp-cli/ws and perp-cli/ws/node (Node)", "node", ["imports.mjs"], { cwd: C });
writeFileSync(join(C, "consumer.ts"), `
import { createVenueStream, createFundingComparator, hyperliquid, toApr, type MarketUpdate, type UserUpdate } from "perp-cli/ws";
import { nodeTransport } from "perp-cli/ws/node";
const s = createVenueStream(hyperliquid, { transport: nodeTransport });
const apr = (u: MarketUpdate): number | null => toApr(u.funding.rate, u.funding.rateIntervalHours);
const onUser = (u: UserUpdate): string => u.type;
void s; void apr; void onUser; void createFundingComparator;
`);
for (const [mr, mod] of [["bundler", "esnext"], ["node16", "node16"], ["node10", "esnext"]]) {
  run(`consumer: tsc moduleResolution=${mr}`, "npx", ["tsc", "--noEmit", "--strict", "--target", "es2020", "--lib", "es2020,dom", "--types", "node", "--module", mod, "--moduleResolution", mr, "consumer.ts"], { cwd: C });
}
const md = readFileSync(join(C, "node_modules/perp-cli/skills/perp-cli/references/ws-library.md"), "utf8");
const blocks = [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map(m => m[1]);
const files = blocks.map((b, i) => { const f = `skill-block-${i + 1}.ts`; writeFileSync(join(C, f), `${b}\nexport {};\n`); return f; });
run(`skill reference: typecheck ${files.length} ts code blocks`, "npx", ["tsc", "--noEmit", "--strict", "--target", "es2022", "--lib", "es2022,dom", "--types", "node", "--module", "esnext", "--moduleResolution", "bundler", ...files], { cwd: C });

// 4. attw
run("@arethetypeswrong/cli (esm-only profile)", "npx", ["-y", "@arethetypeswrong/cli@latest", TGZ, "--profile", "esm-only"], { cwd: WORK });

// 5. Next 13.5
const EX = join(WORK, "examples");
cpSync(join(REPO, "examples/ws-funding-compare-browser"), join(EX, "ws-funding-compare-browser"), { recursive: true });
cpSync(join(REPO, "examples/ws-next-smoke"), join(EX, "ws-next-smoke"), { recursive: true });
const N = join(EX, "ws-next-smoke");
run("next-smoke: npm install (next 13.5, react 18) + tarball", "npm", ["install", "--no-audit", "--no-fund", TGZ], { cwd: N, timeout: 900_000 });
const nv = spawnSync("node", ["-p", "require('next/package.json').version"], { cwd: N, encoding: "utf8" }).stdout.trim();
check("next version is 13.5.x", nv.startsWith("13.5."), `next ${nv}`);
run("next-smoke: next build (webpack, transpilePackages: [\"perp-cli\"])", "npx", ["next", "build"], { cwd: N, timeout: 900_000 });
const chunksDir = join(N, ".next/static/chunks");
let lib = null;
if (existsSync(chunksDir)) {
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []));
  for (const f of walk(chunksDir)) { const t = readFileSync(f, "utf8"); if (t.includes("connection refused before open")) { lib = { f, t }; break; } }
}
check("next client chunk carries perp-cli/ws without Node-only references", lib !== null && !/require\(["']ws["']\)|["']node:|\bBuffer\.from\b|createRequire|__dirname/.test(lib.t),
  lib === null ? "perp-cli/ws code not found in .next/static/chunks" : `chunk ${lib.f.slice(N.length + 1)} (${lib.t.length} B): no require("ws"), node:*, Buffer, createRequire, __dirname`);

// 6. Node example
run("node example smoke: examples/ws-node-stream (hyperliquid BTC, 15 s)", "node", ["examples/ws-node-stream/stream.mjs", "hyperliquid", "BTC", "--seconds", "15"], { timeout: 120_000 });

// report
const pass = steps.every(s => s.code === 0);
const lines = [
  "# perp-cli/ws 0.15.0 — release gate",
  "",
  `Date: ${new Date().toISOString()}  ·  Node ${process.version}  ·  repo ${spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim()} (+ working tree)  ·  tarball ${tgz}`,
  "",
  `**Result: ${pass ? "PASS" : "FAIL"}** (${steps.filter(s => s.code === 0).length}/${steps.length} steps)`,
  "",
  "| # | Step | Result | Time |",
  "|---|---|---|---|",
  ...steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.code === 0 ? "PASS" : `FAIL (${s.code})`} | ${(s.ms / 1000).toFixed(1)} s |`),
  "",
  ...steps.flatMap((s, i) => [`## ${i + 1}. ${s.name}`, "", `\`${s.cmd}\`${s.cwd && s.cwd !== REPO ? ` (in ${s.cwd.replace(WORK, "$WORK")})` : ""}`, "", "```", tail(s.out.replaceAll(WORK, "$WORK")), "```", ""]),
];
mkdirSync(join(REPO, ".omc/research"), { recursive: true });
writeFileSync(OUT, lines.join("\n"));
console.log(`\n${pass ? "GATE PASS" : "GATE FAIL"} → ${OUT}`);
process.exit(pass ? 0 : 1);
