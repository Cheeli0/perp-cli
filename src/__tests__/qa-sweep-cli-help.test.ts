/**
 * Pre-release QA sweep (0.15.0) — help and bare command groups.
 *  1. `perp <group> <leaf> --help` prints THAT leaf's help (never the root's) for every leaf
 *     command of the real program, including leaves with options and nested groups.
 *  2. `perp help <group> <leaf>` resolves every level (Commander's built-in root help command
 *     resolved only the first operand and printed the group help).
 *  3. A group run without a subcommand in --json mode is one INVALID_PARAMS document with the
 *     subcommand list and remediation (was a CLI_ERROR whose message was the usage text).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Command, CommanderError } from "commander";
import { buildProgram } from "../cli-program.js";

const out: string[] = [];

function wire(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: (s) => { out.push(s); }, writeErr: (s) => { out.push(s); } });
  for (const c of cmd.commands) wire(c);
}

function leaves(cmd: Command, path: string[] = []): string[][] {
  const res: string[][] = [];
  for (const c of cmd.commands) {
    if (c.name() === "help") continue;
    const p = [...path, c.name()];
    if (c.commands.filter((x) => x.name() !== "help").length === 0) res.push(p);
    else res.push(...leaves(c, p));
  }
  return res;
}

let program: Command;

/** Help of exactly this command: "Usage: perp <path> " or "Usage: perp <path>|<alias> ". */
const isHelpOf = (text: string, p: string[]) => text.startsWith(`Usage: perp ${p.join(" ")} `) || text.startsWith(`Usage: perp ${p.join(" ")}|`);

async function helpOf(argv: string[]): Promise<string> {
  out.length = 0;
  try {
    await program.parseAsync(["node", "perp", ...argv]);
  } catch (e) {
    if (!(e instanceof CommanderError) || e.exitCode !== 0) throw e;
  }
  return out.join("");
}

beforeAll(() => {
  program = buildProgram({ defaultExchange: "pacifica", version: "0.0.0-test" }).program;
  wire(program);
});

describe("leaf help", () => {
  it("the program has leaf commands to check (incl. the QA cases)", () => {
    const all = leaves(program).map((p) => p.join(" "));
    expect(all.length).toBeGreaterThan(100);
    for (const p of ["market list", "account positions", "trade limit", "arb scan", "funds withdraw", "wallet balance"]) {
      expect(all.some((x) => x === p || x.startsWith(`${p} `))).toBe(true);
    }
  });

  it("`<group> <leaf> --help` prints the leaf's own usage for every leaf command", async () => {
    const wrong: string[] = [];
    for (const p of leaves(program)) {
      const text = await helpOf([...p, "--help"]);
      if (!isHelpOf(text, p)) wrong.push(`${p.join(" ")} → ${text.split("\n")[0]}`);
    }
    expect(wrong).toEqual([]);
  });

  it("root options before the path do not change it (-n mainnet --json -e hyperliquid)", async () => {
    for (const p of [["market", "list"], ["account", "positions"], ["trade", "limit"], ["arb", "scan"], ["wallet", "balance"]]) {
      const text = await helpOf(["-n", "mainnet", "--json", "-e", "hyperliquid", ...p, "--help"]);
      expect(isHelpOf(text, p)).toBe(true);
    }
  });

  it("`perp help <group> <leaf>` resolves every level for every leaf command", async () => {
    const wrong: string[] = [];
    for (const p of leaves(program)) {
      const text = await helpOf(["help", ...p]);
      if (!isHelpOf(text, p)) wrong.push(`help ${p.join(" ")} → ${text.split("\n")[0]}`);
    }
    expect(wrong).toEqual([]);
  });

  it("`perp help <unknown>` is INVALID_PARAMS naming what exists", async () => {
    await expect(helpOf(["help", "market", "nope"])).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "INVALID_PARAMS", remediation: expect.stringContaining("list, prices, info") }),
    });
  });
});

describe("bare command group", () => {
  it("--json: INVALID_PARAMS listing the subcommands, with remediation", async () => {
    await expect(helpOf(["--json", "history"])).rejects.toMatchObject({
      structured: expect.objectContaining({
        code: "INVALID_PARAMS",
        message: expect.stringMatching(/^'perp history' needs a subcommand: list, /),
        remediation: expect.stringContaining("perp history --help"),
      }),
    });
  });

  it("human mode keeps the usage listing (as an error: exit code 1)", async () => {
    out.length = 0;
    const err = await program.parseAsync(["node", "perp", "history"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).exitCode).toBe(1);
    expect(out.join("")).toMatch(/^Usage: perp history /);
  });
});
