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
