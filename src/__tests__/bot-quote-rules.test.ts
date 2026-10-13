/**
 * Live 2026-10-12 (Aster SOL tick 0.01): every quoting strategy failed at start with
 * "price 108.861840 is not a multiple of 0.0100" and the run still exited 0 ("Fills: 0").
 * Quotes are now put on the venue grid (bid ↓, ask ↑, size floored to the lot, minimums refused),
 * and a run whose strategy never ran / kept failing throws (non-zero exit).
 */
import { describe, it, expect, vi } from "vitest";
import "../exchanges/venues/index.js";
import { prepareLimitQuote, prepareMarketSize, quoteRulesOf, type QuoteRules } from "../bot/quote-rules.js";
import { registerAdapterNetwork } from "../exchanges/adapter-network.js";
import { runBot } from "../bot/engine.js";
import { registerStrategy } from "../bot/strategy-registry.js";
import type { BotConfig } from "../bot/config.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

const rules: QuoteRules = { tickSize: "0.01", stepSize: "0.01", minSize: null, minNotional: "5" };

describe("prepareLimitQuote", () => {
  it("aligns passively: bid down, ask up; floors the size to the lot", () => {
    expect(prepareLimitQuote(rules, "aster", "SOL", "buy", "108.861840", "0.0567")).toEqual({ price: "108.86", size: "0.05" });
    expect(prepareLimitQuote(rules, "aster", "SOL", "sell", "108.861840", "0.05")).toEqual({ price: "108.87", size: "0.05" });
    expect(prepareLimitQuote(rules, "aster", "SOL", "buy", "108.86", "0.05").price).toBe("108.86");
  });

  it("below the venue minimum order value / size / lot → SIZE_TOO_SMALL before sending", () => {
    expect(() => prepareLimitQuote(rules, "aster", "SOL", "buy", "108.86", "0.04")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SIZE_TOO_SMALL" }) }));
    expect(() => prepareLimitQuote({ ...rules, minSize: "0.1", minNotional: null }, "aster", "SOL", "buy", "108.86", "0.05")).toThrow(/below the venue minimum 0.1/);
    expect(() => prepareLimitQuote(rules, "aster", "SOL", "buy", "108.86", "0.004")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SIZE_TOO_SMALL" }) }));
  });

  it("no published tick → price passed through (the adapter rounds / validates)", () => {
    expect(prepareLimitQuote({ ...rules, tickSize: null }, "hyperliquid", "xyz:NVDA", "buy", "180.123456", "1").price).toBe("180.123456");
  });

  it("market size floored; min value checked at the reference price", () => {
    expect(prepareMarketSize(rules, "aster", "SOL", "0.0567", 108)).toBe("0.05");
    expect(() => prepareMarketSize(rules, "aster", "SOL", "0.04", 108)).toThrow(/minimum order value/);
  });
});

describe("quoteRulesOf", () => {
  it("needs the adapter's network (never guessed)", async () => {
    const a = { name: "aster", getMarkets: vi.fn(async () => []) } as unknown as ExchangeAdapter;
    await expect(quoteRulesOf(a, "SOL")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("runBot failure surfacing", () => {
  function adapter(): ExchangeAdapter {
    const a = {
      name: "hyperliquid",
      getMarkets: vi.fn(async () => [{ symbol: "ETH", markPrice: "100", indexPrice: "100", fundingRate: "0", volume24h: "1", openInterest: "1", maxLeverage: 10 }]),
      getKlines: vi.fn(async () => []),
      getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })),
      getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
      getPositions: vi.fn(async () => []),
      getOpenOrders: vi.fn(async () => []),
      cancelAllOrders: vi.fn(async () => ({})),
    } as unknown as ExchangeAdapter;
    registerAdapterNetwork(a, "mainnet");
    return a;
  }
  const config: BotConfig = {
    name: "t-fail", exchange: "hyperliquid", symbol: "ETH", strategy: { type: "test-fail" } as never,
    entry_conditions: [{ type: "always", value: 0 }], exit_conditions: [{ type: "time_after", value: 0.1 }],
    risk: { max_position_usd: 1000, max_daily_loss: 100, max_drawdown: 200, pause_after_loss_sec: 0, max_open_bots: 1 },
    monitor_interval_sec: 0.02,
  };

  it("a strategy whose start always fails → the run throws with the last error (not a clean done)", async () => {
    registerStrategy("test-fail", () => ({ name: "test-fail", init: async () => { throw new Error("price 108.861840 is not a multiple of 0.0100"); }, onTick: async () => [], onStop: async () => [] } as never));
    await expect(runBot(adapter(), config, undefined, () => {}, undefined, "headless", false))
      .rejects.toThrow(/never started.*108\.861840/);
  });

  it("a strategy that started and ticked fine → resolves", async () => {
    registerStrategy("test-fail", () => ({ name: "test-fail", init: async () => {}, onTick: async () => [], onStop: async () => [] } as never));
    await expect(runBot(adapter(), config, undefined, () => {}, undefined, "headless", false)).resolves.toMatchObject({ fills: 0 });
  });
});
