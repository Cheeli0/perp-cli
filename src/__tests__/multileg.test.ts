/**
 * Tests for multi-leg order parsing and execution logic.
 */
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { PerpError } from "../errors.js";

const SLIP = { bps: 50, source: "default" };
const entry = { reduceOnly: false, slippage: SLIP };
const reduce = { reduceOnly: true, slippage: SLIP };

/**
 * Mock venue with STATEFUL positions: `trade multi` legs are placed one at a time and verified
 * by the position delta (placePerpVerified), and rollbacks are reduce-only verified closes
 * (CHANGELOG: "trade multi legs are placed one at a time and verified"). A market order moves
 * the position; `name` must be a registered venue id (slippage is resolved per venue).
 */
function createMockAdapter(overrides: Record<string, unknown> = {}) {
  const pos = new Map<string, number>(); // symbol → signed size
  const fill = (symbol: string, side: "buy" | "sell", size: string) => {
    pos.set(symbol, (pos.get(symbol) ?? 0) + (side === "buy" ? 1 : -1) * Number(size));
  };
  const marketOrder = vi.fn(async (symbol: string, side: "buy" | "sell", size: string) => {
    fill(symbol, side, size);
    return { orderId: "123" };
  });
  return {
    name: "hyperliquid",
    marketOrder,
    /** Test hook: move the position as a real fill would (for custom marketOrder mocks). */
    fill,
    limitOrder: vi.fn().mockResolvedValue({ orderId: "456" }),
    getBalance: vi.fn().mockResolvedValue({ equity: "100", available: "80", marginUsed: "20", unrealizedPnl: "0" }),
    getPositions: vi.fn(async () => [...pos].filter(([, n]) => Math.abs(n) > 1e-12).map(([symbol, n]) => ({
      symbol, side: n > 0 ? "long" : "short", size: String(Math.abs(n)), entryPrice: "1", markPrice: "1",
      liquidationPrice: null, unrealizedPnl: "0", leverage: 1,
    }))),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    // enforceOrderRisk (run per leg before execution) resolves a mark price via
    // getMarkets for market orders, then checks notional against the local risk
    // limits. Supply modest mark prices so the tiny test orders (≤ $100 notional)
    // pass cleanly under DEFAULT_LIMITS.maxPositionUsd ($100k) — this exercises the
    // real risk gate rather than bypassing it with --force. stepSize = the lot each
    // leg is floored to before sending (lotStepOf).
    getMarkets: vi.fn().mockResolvedValue([
      { symbol: "ETH", markPrice: "2000", indexPrice: "2000", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 50, sizeDecimals: 4, stepSize: "0.0001", fundingHours: 1, marginTiers: null },
      { symbol: "SOL", markPrice: "100", indexPrice: "100", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 50, sizeDecimals: 2, stepSize: "0.01", fundingHours: 1, marginTiers: null },
      { symbol: "BTC", markPrice: "60000", indexPrice: "60000", fundingRate: "0", volume24h: "0", openInterest: "0", maxLeverage: 50, sizeDecimals: 5, stepSize: "0.00001", fundingHours: 1, marginTiers: null },
    ]),
    ...overrides,
  };
}

async function setupMultileg(
  getAdapter: (exchange: string) => Promise<unknown>,
) {
  const { registerTradeCommands } = await import("../commands/trade.js");
  const program = new Command();
  program.exitOverride();
  // registerTradeCommands registers 'trade multi' subcommand and deprecated top-level 'multi'
  registerTradeCommands(
    program,
    // getAdapter (single-exchange) — not used by multi-leg, but required by signature
    (async () => getAdapter("hyperliquid")) as () => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
    () => true, // isJson
    () => false, // isDryRun
    getAdapter as (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
  );
  return program;
}

describe("Multi-leg order", () => {
  // CHANGELOG: legs are placed one at a time (sequential) and each is verified (no Promise.all).
  it("executes both legs (sequentially, each verified)", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "ETH", "buy", "0.01", entry);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "sell", "0.01", entry);
  });

  it("resolves exchange aliases (hl→hyperliquid, lit→lighter)", async () => {
    const adapters = new Map<string, unknown>();
    const getAdapter = vi.fn().mockImplementation(async (ex: string) => {
      if (!adapters.has(ex)) adapters.set(ex, createMockAdapter({ name: ex })); // ex = resolved venue id
      return adapters.get(ex);
    });

    const program = await setupMultileg(getAdapter);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:BTC:buy:0.001", "lit:BTC:sell:0.001"], { from: "user" });
    process.stdout.write = origWrite;

    expect(getAdapter).toHaveBeenCalledWith("hyperliquid");
    expect(getAdapter).toHaveBeenCalledWith("lighter");
  });

  it("rejects single leg (needs at least 2)", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    // No orders should be placed
    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for invalid leg format", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "bad_format", "hl:ETH:buy:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for invalid side", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:long:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for invalid size", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "hl:ETH:buy:abc", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("does not execute trades for unknown exchange", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(["multi", "binance:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    process.stdout.write = origWrite;

    expect(adapter.marketOrder).not.toHaveBeenCalled();
  });

  it("rolls back filled legs (reduce-only, verified) when a later leg is DEFINITELY rejected", async () => {
    const successAdapter = createMockAdapter();
    const failAdapter = createMockAdapter({
      name: "pacifica",
      // A typed definite rejection: nothing was placed (isDefiniteOrderFailure).
      marketOrder: vi.fn().mockRejectedValue(new PerpError("ORDER_REJECTED", "Insufficient balance")),
    });

    const getAdapter = vi.fn().mockImplementation(async (ex: string) => {
      return ex === "hyperliquid" ? successAdapter : failAdapter;
    });

    const program = await setupMultileg(getAdapter);

    // Suppress all output
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await program.parseAsync(["multi", "hl:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });
    } finally {
      process.stdout.write = origWrite;
    }

    // HL: buy (fill) + sell (rollback, reduce-only, sized to the measured fill) = 2 calls
    expect(successAdapter.marketOrder).toHaveBeenCalledTimes(2);
    expect(successAdapter.marketOrder).toHaveBeenNthCalledWith(1, "ETH", "buy", "0.01", entry);
    expect(successAdapter.marketOrder).toHaveBeenNthCalledWith(2, "ETH", "sell", "0.01", reduce);

    // Pac: 1 failed call
    expect(failAdapter.marketOrder).toHaveBeenCalledTimes(1);
    // Rolled back but not a success: ORDER_REJECTED → non-zero exit.
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("an unconfirmed leg (untyped error, position unchanged) is quarantined and NOTHING is rolled back", async () => {
    vi.useFakeTimers();
    const successAdapter = createMockAdapter();
    // Untyped error = may have been placed; the measured position never moves → ORDER_PENDING.
    const unknownAdapter = createMockAdapter({ name: "pacifica", marketOrder: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    const getAdapter = vi.fn().mockImplementation(async (ex: string) => (ex === "hyperliquid" ? successAdapter : unknownAdapter));
    const program = await setupMultileg(getAdapter);
    const out: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    try {
      const p = program.parseAsync(["multi", "hl:ETH:buy:0.01", "pac:ETH:sell:0.01"], { from: "user" });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      process.stdout.write = origWrite;
      logSpy.mockRestore();
      vi.useRealTimers();
    }

    // No rollback of the filled HL leg: undoing it could leave the unknown leg naked.
    expect(successAdapter.marketOrder).toHaveBeenCalledTimes(1);
    const env = JSON.parse(out.filter(l => l.trim().startsWith("{")).pop()!);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("ORDER_PENDING");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const { quarantineEntryFor, clearQuarantine } = await import("../bot/quarantine.js");
    expect(quarantineEntryFor("ETH", () => {})?.strategy).toBe("trade-multi");
    clearQuarantine("ETH", null); // isolated HOME; keep later tests unquarantined
  });

  it("refuses a quarantined symbol before any leg is sent (RISK_VIOLATION)", async () => {
    const { quarantineSymbol, clearQuarantine } = await import("../bot/quarantine.js");
    quarantineSymbol("trade-multi", "ETH", "earlier unknown outcome", "check by hand", () => {});
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await program.parseAsync(["multi", "hl:ETH:buy:0.01", "pac:SOL:sell:1"], { from: "user" });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      clearQuarantine("ETH", null);
    }
    expect(adapter.marketOrder).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("supports 3+ legs", async () => {
    const adapter = createMockAdapter();
    const program = await setupMultileg(vi.fn().mockResolvedValue(adapter));

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await program.parseAsync(
      ["multi", "hl:ETH:buy:0.01", "pac:SOL:buy:1", "lit:BTC:sell:0.001"],
      { from: "user" },
    );

    process.stdout.write = origWrite;

    expect(adapter.marketOrder).toHaveBeenCalledTimes(3);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(1, "ETH", "buy", "0.01", entry);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(2, "SOL", "buy", "1", entry);
    expect(adapter.marketOrder).toHaveBeenNthCalledWith(3, "BTC", "sell", "0.001", entry);
  });
});
