/**
 * Review N5: every `perp …` command the MCP server tells an agent to run (cli_schema usages,
 * suggest_command steps, explain_command relatedCommands, tips) must exist in the REAL
 * command tree (buildProgram — the same tree src/index.ts parses), including its flags.
 * A stale entry makes an agent run a command that errors, or worse, a different one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Command, Option } from "commander";

const { buildProgram } = await import("../cli-program.js");

const SOURCES = ["src/mcp-server.ts"].map((p) => resolve(__dirname, "..", "..", p));

/** Every quoted / template string in the MCP sources that contains a `perp <cmd>` invocation. */
export function mcpCommandStrings(): string[] {
  const out = new Set<string>();
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf-8");
    const re = /(["`])((?:(?!\1)[^\\\n]|\\.)*?\bperp\s+(?:-|[a-z])(?:(?!\1)[^\\\n]|\\.)*)\1/g;
    for (const m of src.matchAll(re)) {
      const s = m[2].replace(/\$\{[^}]*\}/g, "<x>");
      // Only invocations: "perp" followed by a flag or a lowercase word, not prose like "perp-cli".
      // A string may hold several invocations ("perp setup, or perp wallet …"): check each.
      for (const part of s.split(/(?=(?:^|[\s|])perp\s+(?:-|[a-z]))/)) {
        const idx = part.search(/(^|[\s|])perp\s+(-|[a-z])/);
        if (idx < 0) continue;
        out.add(part.slice(idx).trim().replace(/[,.;:)]+$/, ""));
      }
    }
  }
  return [...out];
}

function findOption(cmd: Command, flag: string): { opt: Option; owner: Command } | null {
  const name = flag.split("=")[0];
  for (let c: Command | null = cmd; c !== null; c = c.parent) {
    const opt = c.options.find((o) => o.long === name || o.short === name || (o.negate && o.long === name));
    if (opt) return { opt, owner: c };
  }
  return null;
}

/** Walk `perp …` through the program; returns null when valid, else the reason. */
function checkInvocation(root: Command, invocation: string): string | null {
  const tokens = invocation.replace(/^.*?\bperp\s+/, "").match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  let cmd = root;
  let argsPhase = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "|" || t === "&&" || t === "#" || t === "or" || t.endsWith(",")) break;
    if (t === "--help" || t === "-h") continue;
    if (t.startsWith("-")) {
      const found = findOption(cmd, t);
      if (!found) return `unknown flag ${t} on "${cmd.name()}"`;
      if ((found.opt.required || found.opt.optional) && !t.includes("=")) i++;
      continue;
    }
    if (argsPhase) continue;
    const isPlaceholder = /^[<['"]|^\.\.\.$/.test(t);
    const findSub = (n: string) => cmd.commands.find((c) => c.name() === n || c.aliases().includes(n));
    const sub = isPlaceholder ? undefined : findSub(t);
    if (sub) { cmd = sub; continue; }
    // "<a|b|c>" over subcommands: every alternative must exist.
    const alts = /^<([a-z-]+(?:\|[a-z-]+)+)>$/.exec(t);
    if (alts && cmd.commands.length > 0) {
      const missing = alts[1].split("|").filter((a) => findSub(a) === undefined);
      if (missing.length > 0) return `unknown command(s) ${missing.join(", ")} under "${cmd.name()}"`;
      argsPhase = true;
      continue;
    }
    // A placeholder in a subcommand position (e.g. "funds deposit <exchange>") stands for one of them.
    if (cmd.registeredArguments.length > 0 || isPlaceholder) { argsPhase = true; continue; }
    return `unknown command "${t}" under "${cmd.name()}"`;
  }
  return null;
}

/**
 * Placeholder names that stand for a differently-named commander argument (same meaning).
 * Key: placeholder text inside <>; value: the commander argument name it denotes.
 */
const PLACEHOLDER_ALIASES: Record<string, string> = {
  "buy|sell": "side",
  "long|short": "positionSide",
  n: "leverage",
};

/**
 * Walk `perp …` to its leaf command, then pair each positional token with the commander argument
 * at the same position. A `<placeholder>` must name that argument (a literal value or a template
 * substitution `<x>` is not checked). Returns the mismatches.
 */
function argOrderMismatches(root: Command, invocation: string): string[] {
  const tokens = invocation.replace(/^.*?\bperp\s+/, "").match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  let cmd = root;
  const positionals: string[] = [];
  let inArgs = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "|" || t === "&&" || t === "#" || t === "or" || t.endsWith(",")) break;
    if (t.startsWith("-")) {
      const found = findOption(cmd, t);
      if (found && (found.opt.required || found.opt.optional) && !t.includes("=")) i++;
      continue;
    }
    if (!inArgs) {
      const sub = /^[<['"]/.test(t) ? undefined : cmd.commands.find((c) => c.name() === t || c.aliases().includes(t));
      if (sub) { cmd = sub; continue; }
      inArgs = true;
    }
    positionals.push(t);
  }
  const declared = cmd.registeredArguments;
  if (declared.length === 0) return [];
  const out: string[] = [];
  positionals.forEach((t, k) => {
    const m = /^<([^>]+)>$/.exec(t);
    if (!m || m[1] === "x") return;
    const arg = declared[Math.min(k, declared.length - 1)];
    if (k >= declared.length && !arg.variadic) { out.push(`${invocation}: extra positional ${t}`); return; }
    const raw = m[1].replace(/\.\.\.$/, "");
    const name = PLACEHOLDER_ALIASES[raw] ?? raw;
    // `trade cancel <symbolOrOrderId> [orderId]`: the two-argument form passes the symbol first.
    if (name !== arg.name() && !(arg.name() === "symbolOrOrderId" && name === "symbol")) out.push(`${invocation}: position ${k} is <${arg.name()}> but the template says ${t}`);
  });
  return out;
}

describe("MCP command templates follow the real argument order", () => {
  const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });

  it("trade stop is <symbol> <side> <size> <stopPrice> in the real command", () => {
    const trade = program.commands.find((c) => c.name() === "trade")!;
    const stop = trade.commands.find((c) => c.name() === "stop")!;
    expect(stop.registeredArguments.map((a) => a.name())).toEqual(["symbol", "side", "size", "stopPrice"]);
  });

  it("every <placeholder> in an MCP command template sits at its commander argument's position", () => {
    const bad = mcpCommandStrings().flatMap((s) => argOrderMismatches(program, s));
    expect(bad).toEqual([]);
  });

  it("the checker catches a swapped template (sanity)", () => {
    expect(argOrderMismatches(program, "perp -e x --json trade stop <x> <side> <stopPrice> <size>")).toHaveLength(2);
  });
});

describe("MCP command references resolve in buildProgram()", () => {
  const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  const strings = mcpCommandStrings();

  it("finds the MCP command references (sanity)", () => {
    expect(strings.length).toBeGreaterThan(60);
  });

  it("references the uniform builder-fee commands (wallet builder), not the removed manage builder approve/revoke/list", () => {
    expect(strings.some((s) => s.includes("perp wallet builder <status|approve|revoke>"))).toBe(true);
    const wallet = program.commands.find((c) => c.name() === "wallet")!;
    const wb = wallet.commands.find((c) => c.name() === "builder")!;
    expect(wb.commands.map((c) => c.name()).sort()).toEqual(["approve", "revoke", "status"]);
    const manageBuilder = wallet.commands.find((c) => c.name() === "manage")!.commands.find((c) => c.name() === "builder")!;
    expect(manageBuilder.commands.map((c) => c.name())).not.toEqual(expect.arrayContaining(["approve"]));
    expect(manageBuilder.commands.map((c) => c.name())).not.toContain("revoke");
    expect(manageBuilder.commands.map((c) => c.name())).not.toContain("list");
  });

  it("every referenced command path and flag exists", () => {
    const bad = strings.map((s) => [s, checkInvocation(program, s)] as const).filter(([, r]) => r !== null);
    expect(bad.map(([s, r]) => `${s}  →  ${r}`)).toEqual([]);
  });
});
