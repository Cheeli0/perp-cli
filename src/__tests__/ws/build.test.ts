/**
 * perp-cli/ws build output (plan ws-0.14.4 §4.7, Phase 1 purity): the tsup bundle is a single-file
 * ES2020 ESM with no Node built-ins / ws / Buffer / process, no top-level await and no global touched
 * at module load; it imports in Node with WebSocket and fetch removed; the d.ts is self-contained and
 * matches the committed API snapshot.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../../tsup.ws.config.js";

let out = "";
let indexJs = "";
let nodeJs = "";

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "perp-ws-build-"));
  for (const c of config as unknown as Array<Parameters<typeof build>[0]>) await build({ ...c, outDir: out, silent: true });
  indexJs = readFileSync(join(out, "index.js"), "utf8");
  nodeJs = readFileSync(join(out, "node.js"), "utf8");
}, 120_000);

afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

const GLOBALS = new Set(["WebSocket", "fetch", "document", "window", "globalThis", "self", "navigator", "location", "TextDecoder", "localStorage", "process", "Buffer"]);

/** Problems found in a module: post-ES2020 syntax anywhere; await / global reads at top level. */
function audit(code: string): string[] {
  const sf = ts.createSourceFile("m.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const problems: string[] = [];
  // Module-scope bindings (imports, top-level declarations) shadow the global names.
  const local = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause !== undefined) {
      const c = st.importClause;
      if (c.name !== undefined) local.add(c.name.text);
      if (c.namedBindings !== undefined) {
        if (ts.isNamespaceImport(c.namedBindings)) local.add(c.namedBindings.name.text);
        else for (const el of c.namedBindings.elements) local.add(el.name.text);
      }
    }
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) local.add(d.name.text);
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined) local.add(st.name.text);
  }
  const where = (n: ts.Node) => `${n.getText(sf).slice(0, 60)} @${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node, topLevel: boolean): void => {
    if (ts.isBinaryExpression(n) && [
      ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ].includes(n.operatorToken.kind)) problems.push(`logical assignment (ES2021): ${where(n)}`);
    if (ts.isPrivateIdentifier(n)) problems.push(`#private (ES2022): ${where(n)}`);
    if (ts.isClassStaticBlockDeclaration(n)) problems.push(`static block (ES2022): ${where(n)}`);
    if (ts.isNumericLiteral(n) && n.getText(sf).includes("_")) problems.push(`numeric separator (ES2021): ${where(n)}`);
    if (topLevel && (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier !== undefined))) problems.push(`top-level await: ${where(n)}`);
    if (topLevel && ts.isIdentifier(n) && GLOBALS.has(n.text) && !local.has(n.text)) {
      const p = n.parent;
      const isProp = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
      if (!isProp) problems.push(`global read at module load: ${where(n)}`);
    }
    const fnBoundary = ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n);
    ts.forEachChild(n, c => visit(c, topLevel && !fnBoundary));
  };
  visit(sf, true);
  return problems;
}

describe("perp-cli/ws bundle purity", () => {
  it("the audit itself flags post-ES2020 syntax, top-level await and load-time globals", () => {
    const p = audit("await x; let a; a ??= 1; class C { #p = 1 }; const y = fetch; const n = 1_000; function f() { return document; }");
    expect(p.map(s => s.split(":")[0])).toEqual([
      "top-level await", "logical assignment (ES2021)", "#private (ES2022)", "global read at module load", "numeric separator (ES2021)",
    ]);
  });

  it("index.js: no Node built-ins, ws, Buffer, process, require, import.meta; no imports at all", () => {
    for (const re of [/\bprocess\b/, /\bBuffer\b/, /\brequire\s*\(/, /from\s*["']node:/, /from\s*["']ws["']/, /import\.meta/, /__dirname/]) {
      expect(re.test(indexJs), String(re)).toBe(false);
    }
    expect(/^\s*import\s/m.test(indexJs)).toBe(false);
    expect(/\bimport\s*\(/.test(indexJs)).toBe(false);
  });

  it("index.js / node.js: ES2020 syntax only, no top-level await, no global read at module load", () => {
    expect(audit(indexJs)).toEqual([]);
    expect(audit(nodeJs)).toEqual([]);
  });

  it("node.js imports only node:module (`ws` is required lazily, never imported statically)", () => {
    const specs = [...nodeJs.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map(m => m[1]);
    expect(specs).toEqual(["node:module"]);
    expect(nodeJs).not.toMatch(/from\s*["']ws["']/);
  });

  it("imports in Node with WebSocket and fetch removed from globalThis; createVenueStream needs a transport", async () => {
    const g = globalThis as { WebSocket?: unknown; fetch?: unknown };
    const saved = { WebSocket: g.WebSocket, fetch: g.fetch };
    delete g.WebSocket;
    delete g.fetch;
    try {
      const mod = await import(`${pathToFileURL(join(out, "index.js")).href}?t=${Date.now()}`) as typeof import("../../ws/index.js");
      expect(typeof mod.createVenueStream).toBe("function");
      expect(() => mod.createVenueStream(mod.hyperliquid)).toThrow(expect.objectContaining({
        structured: expect.objectContaining({ code: "INVALID_PARAMS", remediation: "import from the /node entry (perp-cli/ws/node or @hypurrquant/perp-ws/node) or pass transport" }),
      }));
    } finally {
      if (saved.WebSocket !== undefined) g.WebSocket = saved.WebSocket;
      if (saved.fetch !== undefined) g.fetch = saved.fetch;
    }
  });

  it("d.ts files are self-contained (no relative imports into chunks)", () => {
    for (const f of ["index.d.ts", "node.d.ts"]) {
      const dts = readFileSync(join(out, f), "utf8");
      expect(/from\s*["']\.\.?\//.test(dts), f).toBe(false);
    }
  });

  it("public API (dist/ws/index.d.ts) matches the committed snapshot", async () => {
    await expect(readFileSync(join(out, "index.d.ts"), "utf8")).toMatchFileSnapshot("./__snapshots__/ws-index.d.ts.snap");
  });
});
