/**
 * Review fixes on the `perp trade` order paths (no network, nothing sent):
 *  - split / market --split / stop --no-reduce-only run the local risk gate before the dry-run return;
 *  - every opening path refuses a quarantined symbol (--force does not bypass it), reduce-only passes;
 *  - one-arg `trade cancel` never treats an order reference as a symbol; "not found" is an error;
 *  - sizes are parsed once (parsePositiveDecimal) — "1,000" / "abc" refused before any read;
 *  - an ORDER_PENDING send is logged "unverified", not "failed";
 *  - close / reduce with no position, bad leverage / TWAP ids, --force-tif without --tif are errors.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../execution-log.js", () => ({ logExecution: vi.fn() }));
vi.mock("../../client-id-tracker.js", () => ({
  generateClientId: vi.fn().mockReturnValue("test-id"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn().mockReturnValue(false),
}));
vi.mock("../../trade-validator.js", () => ({
  enforceOrderRisk: vi.fn().mockResolvedValue(undefined),
  validateTrade: vi.fn().mockResolvedValue({ valid: true, checks: [], warnings: [], timestamp: "" }),
}));
vi.mock("../../bot/quarantine.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../bot/quarantine.js")>();
  return { ...orig, quarantineEntryFor: vi.fn(() => null), quarantineSymbol: vi.fn() };
});

import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { enforceOrderRisk } from "../../trade-validator.js";
import { quarantineEntryFor } from "../../bot/quarantine.js";
import { logExecution } from "../../execution-log.js";
import { PerpError } from "../../errors.js";
import { registerTradeCommands, looksLikeOrderId } from "../../commands/trade.js";

const MARK = 100;

function makeAdapter(name = "hyperliquid") {
  return {
    name,
    marketOrder: vi.fn(),
    limitOrder: vi.fn(),
    stopOrder: vi.fn(),
    cancelOrder: vi.fn(),
    setLeverage: vi.fn(),
    getMarkets: vi.fn().mockResolvedValue([{
      symbol: "BTC", markPrice: String(MARK), indexPrice: String(MARK), fundingRate: "0.0001", volume24h: "1", openInterest: "1",
      maxLeverage: 20, sizeDecimals: 3, stepSize: "0.001", fundingHours: 1, marginTiers: null,
    }]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" }),
  } as any;
}

const out: string[] = [];
function program(adapter: ReturnType<typeof makeAdapter>, dryRun: boolean): Command {
  const p = new Command();
  p.exitOverride();
  addRootSafetyOptions(p).option("--json");
  registerTradeCommands(p, async () => adapter, () => true, () => dryRun);
  for (const c of p.commands) c.exitOverride();
  return p;
}
const run = (p: Command, args: string[]) => p.parseAsync(["node", "perp", "--json", ...args]);
const lastJson = () => JSON.parse(out[out.length - 1]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quarantineEntryFor).mockReturnValue(null);
  out.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const quarantined = () => vi.mocked(quarantineEntryFor).mockReturnValue({
  strategy: "trade-multi", symbol: "BTC", reason: "outcome unknown", remediation: "check BTC", time: new Date().toISOString(), network: null,
});

describe("risk gate on split / stop --no-reduce-only (before the dry-run return)", () => {
  it("trade split BTC buy 1000 --dry-run → risk check with size = usd / mark, price = mark; nothing sent", async () => {
    const a = makeAdapter();
    await run(program(a, true), ["trade", "split", "BTC", "buy", "1000"]);
    expect(enforceOrderRisk).toHaveBeenCalledWith(a, expect.objectContaining({ symbol: "BTC", size: 1000 / MARK, price: MARK }));
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false } });
    expect(a.marketOrder).not.toHaveBeenCalled();
  });

  it("trade split --force forwards force to the risk gate", async () => {
    const a = makeAdapter();
    await run(program(a, true), ["trade", "split", "BTC", "buy", "1000", "--force"]);
    expect(enforceOrderRisk).toHaveBeenCalledWith(a, expect.objectContaining({ force: true }));
  });

  it("a RISK_VIOLATION stops trade split before the dry-run plan", async () => {
    const a = makeAdapter();
    vi.mocked(enforceOrderRisk).mockRejectedValueOnce(new PerpError("RISK_VIOLATION", "over the limit"));
    await expect(run(program(a, true), ["trade", "split", "BTC", "buy", "1000"])).rejects.toMatchObject({ structured: { code: "RISK_VIOLATION" } });
    expect(out).toEqual([]);
  });

  it("trade market --split --dry-run → risk check on the base size at the mark", async () => {
    const a = makeAdapter();
    await run(program(a, true), ["trade", "market", "BTC", "buy", "2", "--split"]);
    expect(enforceOrderRisk).toHaveBeenCalledWith(a, expect.objectContaining({ symbol: "BTC", size: 2, price: MARK }));
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true } });
  });

  it("trade stop --no-reduce-only → risk check at the trigger (or the limit price); --force forwarded", async () => {
    const a = makeAdapter();
    await run(program(a, true), ["trade", "stop", "BTC", "buy", "1", "105", "--no-reduce-only"]);
    expect(enforceOrderRisk).toHaveBeenLastCalledWith(a, expect.objectContaining({ symbol: "BTC", size: 1, price: 105 }));
    await run(program(a, true), ["trade", "stop", "BTC", "buy", "1", "105", "--no-reduce-only", "--limit-price", "106", "--force"]);
    expect(enforceOrderRisk).toHaveBeenLastCalledWith(a, expect.objectContaining({ price: 106, force: true }));
  });

  it("a reduce-only stop (default) is exempt from the risk gate", async () => {
    const a = makeAdapter();
    await run(program(a, true), ["trade", "stop", "BTC", "sell", "1", "95"]);
    expect(enforceOrderRisk).not.toHaveBeenCalled();
  });
});

describe("quarantine gate on every opening path (same as MCP; --force does not bypass)", () => {
  it.each([
    [["trade", "market", "BTC", "buy", "1"]],
    [["trade", "buy", "BTC", "1", "--force"]],
    [["trade", "limit", "BTC", "buy", "99", "1"]],
    [["trade", "split", "BTC", "buy", "1000", "--force"]],
    [["trade", "market", "BTC", "buy", "1", "--split"]],
    [["trade", "stop", "BTC", "buy", "1", "105", "--no-reduce-only"]],
    [["trade", "scale-in", "BTC", "buy", "--levels", "99:50,98:50", "--size", "1"]],
  ])("%j on a quarantined symbol → RISK_VIOLATION with the quarantine-clear remediation, even in dry-run", async (args) => {
    quarantined();
    const a = makeAdapter();
    const err = await run(program(a, true), args).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ structured: { code: "RISK_VIOLATION", remediation: expect.stringContaining("perp strategy quarantine-clear BTC") } });
    expect(out).toEqual([]);
  });

  it("a reduce-only market order on a quarantined symbol passes the gate", async () => {
    quarantined();
    const a = makeAdapter();
    await run(program(a, true), ["trade", "market", "BTC", "sell", "1", "--reduce-only"]);
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true } });
  });
});

describe("one-arg trade cancel: an order reference is never a symbol", () => {
  it("looksLikeOrderId: numeric / UUID / 0x-hex ids; symbols are not ids", () => {
    for (const id of ["12345", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "0x1234567890abcdef1234567890abcdef"]) expect(looksLikeOrderId(id)).toBe(true);
    for (const sym of ["BTC", "xyz:TSLA", "1000PEPE", "GOLD-USD"]) expect(looksLikeOrderId(sym)).toBe(false);
  });

  it("cancel c:<id> on a venue that needs the symbol → INVALID_PARAMS naming `trade cancel <symbol> <id>`; nothing read or sent", async () => {
    const a = makeAdapter();
    await expect(run(program(a, false), ["trade", "cancel", "c:0x1234567890abcdef1234567890abcdef"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS", remediation: expect.stringContaining("perp trade cancel <symbol> c:0x1234567890abcdef1234567890abcdef") } });
    expect(a.getOpenOrders).not.toHaveBeenCalled();
    expect(a.cancelOrder).not.toHaveBeenCalled();
  });

  it.each([["12345"], ["f47ac10b-58cc-4372-a567-0e02b2c3d479"]])("cancel %s not in the open orders → ORDER_NOT_FOUND (never ok:true)", async (id) => {
    const a = makeAdapter();
    await expect(run(program(a, false), ["trade", "cancel", id])).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    expect(a.cancelOrder).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("a UUID found in the open orders is cancelled on its symbol (dry-run: planned, not sent)", async () => {
    const a = makeAdapter();
    const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    a.getOpenOrders.mockResolvedValue([{ orderId: id, symbol: "ETH", side: "buy", price: "1", size: "1", filled: "0", status: "open", type: "limit", triggerPrice: null }]);
    await run(program(a, true), ["trade", "cancel", id]);
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, symbol: "ETH", orderId: id } });
    expect(a.cancelOrder).not.toHaveBeenCalled();
  });
});

describe("size parsed once, up front", () => {
  it.each([
    [["trade", "market", "BTC", "buy", "1,000"]],
    [["trade", "buy", "BTC", "abc"]],
    [["trade", "limit", "BTC", "buy", "99", "1,5"]],
    [["trade", "stop", "BTC", "sell", "abc", "95"]],
    [["trade", "twap", "BTC", "buy", "1e3", "60"]],
    [["trade", "market", "BTC", "buy", "1,000", "--split"]],
  ])("%j → INVALID_PARAMS before any read", async (args) => {
    const a = makeAdapter();
    await expect(run(program(a, true), args)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(enforceOrderRisk).not.toHaveBeenCalled();
    expect(a.getMarkets).not.toHaveBeenCalled();
  });

  it("the parsed size reaches the risk gate as a number", async () => {
    const a = makeAdapter();
    await run(program(a, true), ["trade", "limit", "BTC", "buy", "99", " 0.5 "]);
    expect(enforceOrderRisk).toHaveBeenCalledWith(a, expect.objectContaining({ size: 0.5, price: 99 }));
  });
});

describe("ORDER_PENDING is logged unverified", () => {
  it("a market order whose outcome is unknown → execution log status \"unverified\"", async () => {
    const a = makeAdapter();
    a.marketOrder.mockRejectedValue(new PerpError("ORDER_PENDING", "outcome unknown"));
    await expect(run(program(a, false), ["trade", "market", "BTC", "buy", "1"])).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(logExecution).toHaveBeenCalledWith(expect.objectContaining({ type: "market_order", status: "unverified" }));
  });

  it("a definite failure stays \"failed\"", async () => {
    const a = makeAdapter();
    a.marketOrder.mockRejectedValue(new PerpError("ORDER_REJECTED", "refused"));
    await expect(run(program(a, false), ["trade", "market", "BTC", "buy", "1"])).rejects.toBeTruthy();
    expect(logExecution).toHaveBeenCalledWith(expect.objectContaining({ type: "market_order", status: "failed" }));
  });
});

describe("failures are error envelopes (exit 1), parameters validated before the dry-run return", () => {
  it.each([[["trade", "close", "BTC"]], [["trade", "reduce", "BTC", "50"]]])("%j with no position → POSITION_NOT_FOUND, ok:false, exit 1", async (args) => {
    const a = makeAdapter();
    await run(program(a, false), args);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "POSITION_NOT_FOUND" } });
    expect(process.exitCode).toBe(1);
  });

  it("trade cancel-twap with a non-numeric id → INVALID_PARAMS before the adapter is built", async () => {
    const a = makeAdapter();
    await expect(run(program(a, false), ["trade", "cancel-twap", "BTC", "abc"])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("trade leverage NaN → INVALID_PARAMS even in dry-run", async () => {
    const a = makeAdapter();
    await expect(run(program(a, true), ["trade", "leverage", "BTC", "x"])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(out).toEqual([]);
  });

  it("trade edit --force-tif without --tif is refused in dry-run too", async () => {
    const a = makeAdapter("ondo");
    const err = await run(program(a, true), ["trade", "edit", "TSLA", "1", "100", "1", "--force-tif"]).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ message: expect.stringContaining("--force-tif needs --tif") });
    expect(out).toEqual([]);
  });
});
