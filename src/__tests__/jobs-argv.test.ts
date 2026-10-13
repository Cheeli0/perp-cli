/**
 * Background jobs re-invoke the CLI. They used to spawn `perp run <strategy> ...` —
 * no top-level `run` command exists, so every background job died on start, and
 * the child never received the parent's -n / --dry-run.
 *
 * For every `--background` entry point: capture the StartJobOpts, build the child
 * argv with the real jobArgv(), and parse it through a fresh buildProgram(). The
 * parse must reach the expected command's action (after the root guard validated
 * -n / --dry-run) with no Commander error, and the child must see the parent's
 * network and dry-run.
 *
 * No network, no tmux: startJob is mocked; venue adapters are stubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StartJobOpts } from "../jobs.js";

const stubAdapter = {
  name: "hyperliquid",
  address: "0x1111111111111111111111111111111111111111",
  getBalance: vi.fn(async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" })),
  getPositions: vi.fn(async () => []),
  getOpenOrders: vi.fn(async () => []),
  getMarkets: vi.fn(async () => []),
};

vi.mock("../exchanges/venue.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../exchanges/venue.js")>();
  return {
    ...orig,
    getVenue: (input: string) => {
      const def = orig.getVenue(input);
      return def.create === null ? def : { ...def, create: async () => ({ ...stubAdapter, name: def.id }) };
    },
  };
});
vi.mock("../config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config.js")>();
  return { ...orig, hasCredentials: vi.fn(async () => false) };
});
vi.mock("../trade-validator.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../trade-validator.js")>();
  return { ...orig, enforceOrderRisk: vi.fn(async () => undefined) };
});

const startJob = vi.fn((o: StartJobOpts) => ({ id: "job1", ...o }));
vi.mock("../jobs.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../jobs.js")>();
  return { ...orig, startJob };
});

const { buildProgram } = await import("../cli-program.js");
const { allCommands, commandPath, isDryRun, networkOf } = await import("../cli-flags.js");
const { jobArgv } = await vi.importActual<typeof import("../jobs.js")>("../jobs.js");

function program(): Command {
  const { program: p } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  for (const c of [p, ...allCommands(p)]) {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  }
  return p;
}

const REACHED = new Error("child action reached");

type ChildView = {
  path: string; network: string; dryRun: boolean; jobId: unknown; exchange: unknown;
  ows: unknown; wallet: unknown; agent: unknown; dex: unknown;
};

/** Parse the child argv; stop at the action (after the root -n / --dry-run guard ran). */
async function parseChild(argv: string[]): Promise<ChildView> {
  const p = program();
  let seen: ChildView | null = null;
  p.hook("preAction", (_root, action) => {
    const r = p.opts();
    seen = {
      path: commandPath(action), network: networkOf(action), dryRun: isDryRun(action), jobId: action.opts().jobId, exchange: r.exchange,
      ows: r.ows, wallet: r.wallet, agent: r.agent, dex: r.dex,
    };
    throw REACHED;
  });
  await expect(p.parseAsync(["node", "perp", ...argv])).rejects.toBe(REACHED);
  return seen!;
}

const fetchSpy = vi.fn(async (url: unknown) => { throw new Error(`unexpected network call: ${String(url)}`); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cfgDir = mkdtempSync(join(tmpdir(), "jobcfg-"));
const cfgPath = join(cfgDir, "bot.yaml");
writeFileSync(cfgPath, `name: t
exchange: hyperliquid
symbol: BTC
strategy:
  type: grid
  upper_price: 110
  lower_price: 90
  grids: 5
  size: 0.01
entry_conditions:
  - type: always
    value: 0
risk:
  max_drawdown: 100
  max_daily_loss: 50
`);

const CASES: Array<[string[], string, string | null]> = [
  [["strategy", "start", cfgPath, "--background"], "strategy start", "hyperliquid"],
  [["-e", "hl", "strategy", "quick-grid", "BTC", "--background"], "strategy quick-grid", "hyperliquid"],
  [["-e", "hl", "strategy", "quick-dca", "BTC", "buy", "10", "60", "--background"], "strategy quick-dca", "hyperliquid"],
  [["strategy", "quick-arb", "--exchanges", "hyperliquid,pacifica", "--background"], "strategy quick-arb", null],
  [["strategy", "delta-neutral", "--exchanges", "hyperliquid", "--background"], "strategy delta-neutral", null],
  [["-e", "hl", "strategy", "preset", "grid-standard", "BTC", "--background"], "strategy preset", "hyperliquid"],
  [["strategy", "preset", "arb-standard", "BTC", "--background"], "strategy preset", null],
  [["-e", "hl", "strategy", "apex", "ETH", "--background"], "strategy apex", "hyperliquid"],
  [["-e", "hl", "trade", "twap", "BTC", "buy", "0.1", "600", "--background"], "strategy twap", "hyperliquid"],
  [["arb", "auto", "--background", "--notify", "https://example.invalid/hook"], "arb auto", null],
];

describe("background job argv parses through the real program", () => {
  it.each(CASES)("%j → child runs '%s'", async (parentArgv, childPath, venue) => {
    for (const net of ["mainnet", "testnet"] as const) {
      startJob.mockClear();
      await program().parseAsync(["node", "perp", "-n", net, ...parentArgv]);
      expect(startJob).toHaveBeenCalledTimes(1);
      const opts = startJob.mock.calls[0][0];
      const argv = jobArgv(opts, "abc123");
      expect(argv).not.toContain("run");
      const child = await parseChild(argv);
      expect(child.path).toBe(childPath);
      expect(child.network).toBe(net);
      expect(child.dryRun).toBe(false);
      expect(child.jobId).toBe("abc123");
      if (venue !== null) expect(child.exchange).toBe(venue);
    }
  });

  it("arb auto --background --dry-run -n testnet → child inherits both", async () => {
    await program().parseAsync(["node", "perp", "-n", "testnet", "--dry-run", "arb", "auto", "--background"]);
    const child = await parseChild(jobArgv(startJob.mock.calls[0][0], "j"));
    expect(child).toMatchObject({ path: "arb auto", network: "testnet", dryRun: true });
  });

  it("jobArgv puts root flags first and --job-id last", () => {
    const selectors = { ows: "main", wallet: null, noAgent: true, dex: "xyz", noBuilder: false };
    expect(jobArgv({ strategy: "x", exchange: "hl", params: {}, venue: "hyperliquid", network: "testnet", dryRun: true, selectors, cliArgs: ["strategy", "twap", "BTC"] }, "id1"))
      .toEqual(["-n", "testnet", "--dry-run", "-e", "hyperliquid", "--ows", "main", "--no-agent", "--dex", "xyz", "strategy", "twap", "BTC", "--job-id", "id1"]);
    expect(jobArgv({ strategy: "x", exchange: "hl", params: {}, network: "mainnet", dryRun: false, selectors: { ows: null, wallet: "w2", noAgent: false, dex: null, noBuilder: false }, cliArgs: ["arb", "auto"] }, "id2"))
      .toEqual(["-n", "mainnet", "-w", "w2", "arb", "auto", "--job-id", "id2"]);
  });
});

/**
 * The child must select the SAME account / market as the parent: --ows, -w, --no-agent
 * and --dex used to be dropped, so a background job silently traded the active wallet,
 * signed with the agent the parent bypassed, or quoted the main dex.
 */
describe("background child inherits the parent's account / market selectors", () => {
  const SELECTOR_CASES: Array<[string[], Partial<ChildView>]> = [
    [["--ows", "acct2"], { ows: "acct2", wallet: undefined, agent: true, dex: undefined }],
    [["-w", "legacy-w"], { wallet: "legacy-w", ows: undefined }],
    [["--no-agent"], { agent: false }],
    [["--dex", "xyz"], { dex: "xyz" }],
    [["--ows", "acct2", "--no-agent", "--dex", "xyz"], { ows: "acct2", agent: false, dex: "xyz" }],
  ];
  it.each(CASES)("%j inherits every selector", async (parentArgv, childPath) => {
    for (const [flags, expected] of SELECTOR_CASES) {
      startJob.mockClear();
      await program().parseAsync(["node", "perp", ...flags, ...parentArgv]);
      expect(startJob).toHaveBeenCalledTimes(1);
      const child = await parseChild(jobArgv(startJob.mock.calls[0][0], "j"));
      expect(child.path).toBe(childPath);
      expect(child).toMatchObject(expected);
    }
  });

  it("no selector on the parent → none on the child", async () => {
    await program().parseAsync(["node", "perp", "-e", "hl", "strategy", "quick-grid", "BTC", "--background"]);
    const argv = jobArgv(startJob.mock.calls[0][0], "j");
    for (const f of ["--ows", "-w", "--no-agent", "--dex"]) expect(argv).not.toContain(f);
  });

  it.each([
    [["-k", "0x" + "11".repeat(32)], "-k/--private-key"],
    [["--passphrase", "pp-secret"], "--passphrase"],
    [["--ows-key", "ows_key_secret"], "--ows-key"],
  ])("%j: key material cannot be handed to the child → INVALID_PARAMS, no job", async (flags, label) => {
    const err = await program().parseAsync(["node", "perp", ...flags, "-e", "hl", "strategy", "quick-grid", "BTC", "--background"]).then(() => null, (e: unknown) => e);
    expect(startJob).not.toHaveBeenCalled();
    const printed = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().map(String).join("\n");
    const msg = err instanceof Error ? `${(err as { structured?: { code?: string } }).structured?.code} ${err.message}` : printed;
    expect(msg).toContain("INVALID_PARAMS");
    expect(msg).toContain(label);
  });
});
