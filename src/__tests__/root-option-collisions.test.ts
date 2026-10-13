/**
 * Root-option collisions (Commander 13, non-positional options): a subcommand option whose flag
 * is also a ROOT option (-e/--exchange, --dex, --json, -w, ...) is consumed by the root wherever
 * it appears in argv — the subcommand's copy is never set and its filter silently does nothing.
 * Every command in the real tree (buildProgram) is scanned; only reviewed, deliberate cases may
 * be allowlisted. Also: the `-n <number>` migration error and the `perp --json` landing document.
 */
import { describe, expect, it } from "vitest";
import type { Command } from "commander";

const { buildProgram, landingData, numericNetworkFlagError } = await import("../cli-program.js");
const { allCommands, commandPath } = await import("../cli-flags.js");

function program(): Command {
  return buildProgram({ defaultExchange: "hyperliquid", version: "test" }).program;
}

/**
 * Deliberate duplicates: "<command path> <flags>". Each reads the value from the root itself
 * (`command.optsWithGlobals()`, `program.getOptionValueSource(...) === "cli"`, or isJson() for
 * --json) — the subcommand copy exists for its help text only.
 */
const DELIBERATE_COLLISIONS = [
  "wallet generate --passphrase <pp>",
  "wallet import --passphrase <pp>",
  "wallet key create -p, --passphrase <pass>",
  "wallet agent approve --passphrase <pp>",
  "wallet agent approve --json",
  "wallet agent import --json",
  "wallet agent list --json",
  "wallet agent revoke --passphrase <pp>",
  "wallet agent revoke --json",
  "wallet agent rotate --passphrase <pp>",
  "wallet agent rotate --json",
  "wallet agent verify --passphrase <pp>",
  "wallet agent verify --json",
  "wallet builder approve --passphrase <pp>",
  "wallet builder revoke --passphrase <pp>",
  "wallet manage account-mode --passphrase <pp>",
  "wallet manage account-mode --json",
  "setup --wallet <name>",
  "setup --passphrase <pp>",
  "alerts add --exchange <ex>",
];

/**
 * KNOWN BUGS, not deliberate: these read `opts.exchange`, which the root always swallows (the
 * filter is silently ignored). Tracked here so the scan stays green for everything else and
 * fails on any NEW collision; remove an entry when its command reads the root value.
 */
const KNOWN_UNFIXED_COLLISIONS: string[] = [];

const ALLOWED_COLLISIONS: string[] = [...DELIBERATE_COLLISIONS, ...KNOWN_UNFIXED_COLLISIONS];

describe("no subcommand option collides with a root option", () => {
  it("every registered subcommand is free of root-flag collisions (except the reviewed allowlist)", () => {
    const root = program();
    const rootLongs = new Set(root.options.map(o => o.long).filter((f): f is string => f !== undefined));
    const rootShorts = new Set(root.options.map(o => o.short).filter((f): f is string => f !== undefined));
    const offenders = allCommands(root).flatMap(c => c.options
      .filter(o => (o.long !== undefined && rootLongs.has(o.long)) || (o.short !== undefined && rootShorts.has(o.short)))
      .map(o => `${commandPath(c)} ${o.flags}`))
      .filter(x => !ALLOWED_COLLISIONS.includes(x));
    expect(offenders).toEqual([]);
  });

  it("the scan sees the tree (sanity: history / risk / portfolio commands are registered)", () => {
    const paths = allCommands(program()).map(commandPath);
    for (const p of ["history list", "history positions", "history pnl", "history perf", "risk status", "risk check", "risk liquidation-distance", "portfolio"]) {
      expect(paths).toContain(p);
    }
  });
});

describe("numeric -n on history / account → --limit migration error", () => {
  it.each([
    [["history", "list", "-n", "5"], "5"],
    [["--json", "history", "positions", "--network", "20"], "20"],
    [["account", "funding", "-n10"], "10"],
    [["history", "list", "--network=7"], "7"],
  ])("%j → INVALID_PARAMS \"use --limit %s\"", (argv, n) => {
    const err = numericNetworkFlagError(argv);
    expect(err).not.toBeNull();
    expect(err!.structured).toMatchObject({ code: "INVALID_PARAMS", remediation: `The record count is --limit now: use --limit ${n}` });
  });

  it.each([
    [["history", "list", "-n", "testnet"]],
    [["history", "list", "--limit", "5"]],
    [["trade", "market", "BTC", "buy", "-n", "5"]], // other commands: the normal -n usage error
    [["-n", "mainnet", "account", "positions"]],
  ])("%j → no migration error", (argv) => {
    expect(numericNetworkFlagError(argv)).toBeNull();
  });
});

describe("perp --json with no subcommand", () => {
  it("landingData is one static usage document listing the visible top-level commands", () => {
    const p = program();
    const d = landingData(p, "9.9.9");
    expect(d).toMatchObject({ name: "perp", version: "9.9.9", help: "perp <command> --help" });
    const names = d.commands.map(c => c.name);
    for (const n of ["trade", "account", "market", "portfolio", "history"]) expect(names).toContain(n);
    // hidden deprecated aliases are not advertised
    expect(names).not.toContain("analytics");
    expect(names).not.toContain("pnl");
    expect(() => JSON.stringify(d)).not.toThrow();
  });
});
