import { describe, expect, it, vi, beforeEach } from "vitest";

// Side-effect modules — stubbed so the tests don't touch the real
// execution-log file or the client-id-tracker keystore on disk.
vi.mock("../../execution-log.js", () => ({
  logExecution: vi.fn(),
}));
vi.mock("../../client-id-tracker.js", () => ({
  generateClientId: vi.fn().mockReturnValue("test-id-deterministic"),
  logClientId: vi.fn(),
  isOrderDuplicate: vi.fn().mockReturnValue(false),
}));
// The manual-order risk gate is orthogonal to dry-run gating; stub it to a
// no-op pass so the live-order (dry-run OFF) cases reach marketOrder without
// the gate's getMarkets/getBalance/getPositions fetch. The gate has its own
// coverage in enforce-order-risk.test.ts.
vi.mock("../../trade-validator.js", () => ({
  enforceOrderRisk: vi.fn().mockResolvedValue(undefined),
  validateTrade: vi.fn().mockResolvedValue({ valid: true, checks: [], warnings: [], timestamp: "" }),
}));

import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { enforceOrderRisk } from "../../trade-validator.js";
import { PerpError } from "../../errors.js";
import { registerTradeCommands } from "../../commands/trade.js";

/**
 * Minimal ExchangeAdapter stub. Only includes the methods that the
 * dry-run gated paths in trade.ts could possibly reach. Any call to
 * marketOrder / placeOrder / closeOrder is the test failing — it means a
 * venue-bound side effect leaked through the --dry-run guard.
 */
function makeMockAdapter() {
  return {
    name: "hyperliquid",
    marketOrder: vi.fn(),
    placeOrder: vi.fn(),
    closeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    // BTC must be listed with a lot step: a live market order floors its size to the lot
    // (lotStepOf) before sending, so an empty market list would stop the order for an
    // unrelated reason (SYMBOL_NOT_FOUND) and the dry-run tests would prove nothing.
    getMarkets: vi.fn().mockResolvedValue([{
      symbol: "BTC", markPrice: "100", indexPrice: "100", fundingRate: "0.0001", volume24h: "1", openInterest: "1",
      maxLeverage: 20, sizeDecimals: 3, stepSize: "0.001", fundingHours: 1, marginTiers: null,
    }]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
  } as any;
}

function buildProgram(opts: {
  adapter: ReturnType<typeof makeMockAdapter>;
  isDryRun: boolean;
}) {
  const program = new Command();
  program.exitOverride(); // throw on parse error instead of process.exit
  addRootSafetyOptions(program).option("--json");
  registerTradeCommands(
    program,
    async () => opts.adapter,
    () => true, // isJson — silences chalk paths
    () => opts.isDryRun,
  );
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trade --dry-run gating — venue calls must not escape (Section 7 / Rule #2)", () => {
  // --- The core guarantee: dry-run blocks every venue-bound side effect ---

  it("trade market BTC buy 0.01 --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "market", "BTC", "buy", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("trade market BTC sell 0.01 --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "market", "BTC", "sell", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("trade buy <sym> <size> shortcut --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "buy", "BTC", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("trade sell <sym> <size> shortcut --dry-run: adapter.marketOrder is NOT called", async () => {
    const adapter = makeMockAdapter();
    const program = buildProgram({ adapter, isDryRun: true });

    await program.parseAsync([
      "node", "perp", "--dry-run", "--json",
      "trade", "sell", "BTC", "0.01",
    ]);

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  // --- Positive control: prove the test plumbing reaches marketOrder
  //     in the absence of dry-run. Without this, the negative tests
  //     could be passing because of a wiring bug, not because gating works.

  it("trade market WITHOUT --dry-run reaches adapter.marketOrder (positive control)", async () => {
    const adapter = makeMockAdapter();
    adapter.marketOrder.mockResolvedValue({ status: "ok" });
    const program = buildProgram({ adapter, isDryRun: false });

    await program.parseAsync([
      "node", "perp", "--json",
      "trade", "market", "BTC", "buy", "0.01",
    ]).catch(() => {
      // Downstream printJson / logExecution may incidentally throw with
      // mocks — we only care that marketOrder was reached at least once.
    });

    expect(adapter.marketOrder).toHaveBeenCalledTimes(1);
    // Every market order states reduceOnly + the resolved slippage bound (default 50 bps).
    expect(adapter.marketOrder).toHaveBeenCalledWith("BTC", "buy", "0.01", { reduceOnly: false, slippage: { bps: 50, source: "default" } });
  });
});

describe("trade --dry-run: sent:false + read-only risk check before the dry-run return (L5)", () => {
  function capture(): string[] {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    return out;
  }

  it("market --dry-run result carries sent:false and the risk gate ran (force=undefined)", async () => {
    const out = capture();
    const adapter = makeMockAdapter();
    await buildProgram({ adapter, isDryRun: true }).parseAsync(["node", "perp", "--dry-run", "--json", "trade", "market", "BTC", "buy", "0.01"]);
    const env = JSON.parse(out.find((l) => l.includes('"ok"'))!);
    expect(env.data).toMatchObject({ dryRun: true, sent: false, action: "market_order" });
    expect(vi.mocked(enforceOrderRisk)).toHaveBeenCalledWith(adapter, expect.objectContaining({ symbol: "BTC", size: 0.01 }));
    vi.restoreAllMocks();
  });

  it("market --dry-run that breaches the risk limits fails like the live order would (nothing sent)", async () => {
    vi.mocked(enforceOrderRisk).mockRejectedValueOnce(new PerpError("RISK_VIOLATION", "Order blocked by local risk limits"));
    const adapter = makeMockAdapter();
    await expect(buildProgram({ adapter, isDryRun: true }).parseAsync(["node", "perp", "--dry-run", "--json", "trade", "market", "BTC", "buy", "0.01"]))
      .rejects.toThrow(/risk limits/);
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("limit --dry-run also runs the risk gate first", async () => {
    capture();
    const adapter = makeMockAdapter();
    await buildProgram({ adapter, isDryRun: true }).parseAsync(["node", "perp", "--dry-run", "--json", "trade", "limit", "BTC", "buy", "100", "0.01"]).catch(() => {});
    expect(vi.mocked(enforceOrderRisk)).toHaveBeenCalledWith(adapter, expect.objectContaining({ symbol: "BTC", price: 100 }));
    vi.restoreAllMocks();
  });
});
