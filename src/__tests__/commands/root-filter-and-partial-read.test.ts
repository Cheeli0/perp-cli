/**
 * - history / risk exchange filters come from the ROOT `-e, --exchange` when typed on the command
 *   line (wherever it appears); the root's default venue is never used as a filter.
 * - multi-venue `account positions --json`: ONE read per venue; a failing venue is an `errors` entry
 *   (never silently dropped by a second, swallowed refetch).
 * No network: execution log, venue list and adapters are mocked.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const readExecutionLog = vi.fn((..._a: unknown[]) => [] as unknown[]);
vi.mock("../../execution-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../execution-log.js")>()),
  readExecutionLog: (...a: unknown[]) => readExecutionLog(...a),
}));
vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  listConfiguredAccountVenues: vi.fn(async () => ["hyperliquid", "pacifica"]),
}));

import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerHistoryCommands } from "../../commands/history.js";
import { registerRiskCommands } from "../../commands/risk.js";
import { registerAccountCommands } from "../../commands/account.js";

const out: string[] = [];
beforeEach(() => {
  out.length = 0;
  readExecutionLog.mockClear();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

function root(): Command {
  const p = new Command();
  p.exitOverride();
  addRootSafetyOptions(p)
    .option("-e, --exchange <exchange>", "Exchange", "hyperliquid")
    .option("--json");
  return p;
}
const lastJson = () => JSON.parse(out[out.length - 1]);

function stubAdapter(name: string, positions: unknown[] | Error) {
  return {
    name,
    getPositions: vi.fn(async () => { if (positions instanceof Error) throw positions; return positions; }),
    getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
  };
}

describe("history: -e filter is read from the root", () => {
  it("no -e → no exchange filter (never the root default venue)", async () => {
    const p = root();
    registerHistoryCommands(p, () => true);
    await p.parseAsync(["node", "perp", "--json", "history", "list"]);
    expect(readExecutionLog).toHaveBeenCalledWith(expect.objectContaining({ exchange: undefined }));
  });

  it.each([
    [["--json", "history", "list", "-e", "pacifica"]],
    [["--json", "-e", "pacifica", "history", "list"]],
    [["--json", "history", "list", "--exchange", "pacifica"]],
  ])("%j → exchange filter pacifica", async (argv) => {
    const p = root();
    registerHistoryCommands(p, () => true);
    await p.parseAsync(["node", "perp", ...argv]);
    expect(readExecutionLog).toHaveBeenCalledWith(expect.objectContaining({ exchange: "pacifica" }));
  });
});

describe("risk: --exchange / -e list is read from the root", () => {
  it("risk status --exchange pacifica reads only pacifica; without it every configured venue", async () => {
    const seen: string[] = [];
    const get = async (ex: string) => { seen.push(ex); return stubAdapter(ex, []) as never; };
    const p = root();
    registerRiskCommands(p, get, () => true);
    await p.parseAsync(["node", "perp", "--json", "risk", "status", "--exchange", "pacifica"]);
    expect(seen).toEqual(["pacifica"]);

    seen.length = 0;
    const p2 = root();
    registerRiskCommands(p2, get, () => true);
    await p2.parseAsync(["node", "perp", "--json", "risk", "status"]);
    expect(seen.sort()).toEqual(["hyperliquid", "pacifica"]);
  });
});

describe("account positions (multi-venue) --json", () => {
  it("one read per venue; a failing venue is reported in errors, the others in exchanges", async () => {
    const hl = stubAdapter("hyperliquid", [{ symbol: "BTC", side: "long", size: "1", entryPrice: "1", markPrice: "1", liquidationPrice: null, unrealizedPnl: "0", leverage: 1 }]);
    const pac = stubAdapter("pacifica", new Error("pacifica down"));
    const p = root();
    registerAccountCommands(p, async () => hl as never, () => true, async (ex) => (ex === "hyperliquid" ? hl : pac) as never);
    await p.parseAsync(["node", "perp", "--json", "account", "positions"]);
    const j = lastJson();
    expect(j.ok).toBe(true);
    expect(Object.keys(j.data.exchanges)).toEqual(["hyperliquid"]);
    expect(j.data.errors).toEqual({ pacifica: "pacifica down" });
    expect(hl.getPositions).toHaveBeenCalledTimes(1);
    expect(pac.getPositions).toHaveBeenCalledTimes(1);
  });

  it("a venue that read fine is never dropped (no second refetch that could fail silently)", async () => {
    let calls = 0;
    const flaky = { name: "pacifica", getPositions: vi.fn(async () => { calls++; if (calls > 1) throw new Error("second read fails"); return []; }) };
    const hl = stubAdapter("hyperliquid", []);
    const p = root();
    registerAccountCommands(p, async () => hl as never, () => true, async (ex) => (ex === "hyperliquid" ? hl : flaky) as never);
    await p.parseAsync(["node", "perp", "--json", "account", "positions"]);
    const j = lastJson();
    expect(Object.keys(j.data.exchanges).sort()).toEqual(["hyperliquid", "pacifica"]);
    expect(j.data.errors).toBeUndefined();
  });
});
