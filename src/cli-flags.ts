/**
 * Root-level CLI flags shared by every command (single source).
 *
 * `--dry-run` and `-n/--network` are defined ONLY on the root program. Commander
 * (v13, non-positional options) lets the root consume a root option wherever it
 * appears in argv — so a subcommand that re-declares `--dry-run` never sees it
 * (the root swallows it) and silently runs live. Commands therefore never declare
 * these options themselves; they read them with `isDryRun(cmd)` / `networkOf(cmd)`.
 *
 * Dry-run is default-deny: `installDryRunGuard(root)` rejects `--dry-run` with
 * INVALID_PARAMS on every command that has not been explicitly marked with
 * `supportsDryRun(cmd)`. A write command added later without dry-run handling
 * therefore refuses `--dry-run` instead of executing live.
 */
import { Command, Option } from "commander";
import { PerpError } from "./errors.js";
import type { Network } from "./exchanges/venue-types.js";

export const NETWORKS = ["mainnet", "testnet"] as const satisfies readonly Network[];

/** `-n, --network` option for the root program (validated: a typo is a usage error, never mainnet). */
export function networkOption(): Option {
  return new Option("-n, --network <network>", "Network: mainnet or testnet").choices(NETWORKS).default("mainnet");
}

/**
 * The root-only safety flags (`-n/--network`, `--dry-run`) — declared ONCE on the root program
 * (cli-program.ts) and by tests that mount a command subtree on a bare root.
 */
export function addRootSafetyOptions(root: Command): Command {
  return root
    .addOption(networkOption())
    .option("--dry-run", "Simulate without sending anything (only commands that support it; others reject --dry-run)");
}

function rootOf(cmd: Command): Command {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c;
}

/** True when the root `--dry-run` flag is set (wherever it appeared in argv). */
export function isDryRun(cmd: Command): boolean {
  return rootOf(cmd).opts().dryRun === true;
}

/** The validated `-n` network. Throws INVALID_PARAMS for anything but mainnet/testnet (no coercion). */
export function networkOf(cmd: Command): Network {
  return parseNetwork(rootOf(cmd).opts().network);
}

export function parseNetwork(value: unknown): Network {
  if (value === "mainnet" || value === "testnet") return value;
  throw new PerpError("INVALID_PARAMS", `Invalid network "${String(value)}" — expected one of: ${NETWORKS.join(", ")}`, {
    remediation: "Pass -n mainnet or -n testnet (lowercase)",
  });
}

const DRY_RUN_AWARE = new WeakSet<Command>();

/**
 * Mark a command as honoring `--dry-run`: it must return a plan — `sent: false` — before
 * SIGNING or SENDING anything. Contract (review L3): reading account state (balance /
 * positions / open orders, needed to size closes and run the local risk check) may resolve
 * the configured credentials — that can decrypt a key or prompt for the passphrase — but a
 * dry-run never signs, never sends, and never writes venue state. Commands that can plan
 * from public data alone (funds deposit/withdraw plans, `funds bridge send` with --sender
 * and --recipient) load no key. Returns the command for chaining.
 */
export function supportsDryRun<T extends Command>(cmd: T): T {
  DRY_RUN_AWARE.add(cmd);
  return cmd;
}

export function honorsDryRun(cmd: Command): boolean {
  return DRY_RUN_AWARE.has(cmd);
}

export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(" ");
}

/** Throws INVALID_PARAMS when `--dry-run` is set on a command that does not honor it. */
export function assertDryRunSupported(actionCommand: Command): void {
  if (!isDryRun(actionCommand) || honorsDryRun(actionCommand)) return;
  throw new PerpError("INVALID_PARAMS", `'perp ${commandPath(actionCommand)}' does not support --dry-run (it would run live)`, {
    remediation: "Remove --dry-run. Commands that can simulate say 'supports --dry-run' in --help",
  });
}

/**
 * Root preAction hook: validates `-n` and enforces default-deny dry-run before any
 * command action runs (so nothing is loaded or signed for a rejected invocation).
 */
export function installDryRunGuard(root: Command): void {
  root.hook("preAction", (_thisCommand, actionCommand) => {
    networkOf(actionCommand);
    assertDryRunSupported(actionCommand);
  });
}

/** Every command in the tree (depth-first), excluding the root. */
export function allCommands(root: Command): Command[] {
  const out: Command[] = [];
  const walk = (c: Command): void => {
    for (const sub of c.commands) {
      out.push(sub);
      walk(sub);
    }
  };
  walk(root);
  return out;
}
