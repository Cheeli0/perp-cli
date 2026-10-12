/**
 * Live 2026-10-12:
 *  17. avellaneda-mm quoted SOL ≈ $109 at $38.62: the spread (2/γ)·ln(1+γ/κ) = 1.29 ($) was
 *      multiplied by the mid. The A–S formulas now run in $ (σ in $/√s, T − t in s) and a quote
 *      > 5% from mid is an error.
 *  18. Skewed / split quote sizes under the venue minimum failed the whole tick: that side is now
 *      skipped (logged); only a batch where every order is undersized fails.
 *  19. HIP-4: describeCoin names the outcome / side behind "#14881".
 */
import { describe, it, expect, vi } from "vitest";
import "../exchanges/venues/index.js";
import { avellanedaQuotes, estimateSigma } from "../bot/strategies/avellaneda-mm.js";
import { HyperliquidOutcomeAdapter } from "../exchanges/hyperliquid-outcome.js";
import { registerAdapterNetwork } from "../exchanges/adapter-network.js";
import { registerStrategy } from "../bot/strategy-registry.js";
import { runBot } from "../bot/engine.js";
import type { BotConfig } from "../bot/config.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

describe("avellaneda-mm quotes (17)", () => {
  it("SOL $109, γ 0.1, κ 1.5, σ from a ~$0.8 1h ATR, T−t 86400 s → quotes ~1.3% around mid", () => {
    const sigma = 0.8 / Math.sqrt(3600);
    const r = avellanedaQuotes({ mid: 109, q: 0, gamma: 0.1, kappa: 1.5, sigma, secondsLeft: 86400 });
    // δ = γσ²(T−t) + (2/γ)ln(1+γ/κ) = 1.536 + 1.291 = 2.827 $
    expect(r.spread).toBeCloseTo(0.1 * sigma ** 2 * 86400 + 20 * Math.log(1 + 0.1 / 1.5), 10);
    expect(r.bid).toBeGreaterThan(107);
    expect(r.ask).toBeLessThan(111);
    expect(r.reservation).toBe(109);
  });

  it("inventory shifts the reservation price by q·γσ²(T−t)", () => {
    const base = { mid: 109, gamma: 0.1, kappa: 1.5, sigma: 0.01, secondsLeft: 3600 };
    const r = avellanedaQuotes({ ...base, q: 0.5 });
    expect(r.reservation).toBeCloseTo(109 - 0.5 * 0.1 * 0.0001 * 3600, 10);
  });

  it("a quote more than 5% from mid is refused (the live $38.62 case cannot happen silently)", () => {
    expect(() => avellanedaQuotes({ mid: 1, q: 0, gamma: 0.1, kappa: 1.5, sigma: 0.0001, secondsLeft: 60 }))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });

  it("σ = ATR ÷ √(candle interval s); too few candles → PRICE_STALE (no constant fallback)", () => {
    const klines = Array.from({ length: 20 }, (_, i) => ({ time: i * 3_600_000, open: "100", high: "100.4", low: "99.6", close: "100", volume: "1" }));
    expect(estimateSigma({ klines } as never, 0)).toBeCloseTo(0.8 / 60, 6);
    expect(() => estimateSigma({ klines: klines.slice(0, 5) } as never, 0)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "PRICE_STALE" }) }));
    expect(estimateSigma({ klines: [] } as never, 0.02)).toBe(0.02);
  });
});

describe("engine: an undersized side is skipped, not the whole tick (18)", () => {
  function adapter() {
    const limitOrder = vi.fn(async () => ({}));
    const a = {
      name: "aster",
      getMarkets: vi.fn(async () => [{ symbol: "SOL", markPrice: "109", indexPrice: "109", fundingRate: "0", volume24h: "1", openInterest: "1", maxLeverage: 10, stepSize: "0.01", sizeDecimals: 2 }]),
      getKlines: vi.fn(async () => []),
      getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })),
      getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
      getPositions: vi.fn(async () => []),
      getOpenOrders: vi.fn(async () => []),
      cancelAllOrders: vi.fn(async () => ({})),
      limitOrder,
    } as unknown as ExchangeAdapter;
    registerAdapterNetwork(a, "mainnet");
    return { a, limitOrder };
  }
  vi.mock("../bot/quote-rules.js", async (orig) => ({
    ...(await orig<typeof import("../bot/quote-rules.js")>()),
    quoteRulesOf: async () => ({ tickSize: "0.01", stepSize: "0.01", minSize: null, minNotional: "5" }),
  }));
  const config = (type: string): BotConfig => ({
    name: `t-${type}`, exchange: "aster", symbol: "SOL", strategy: { type } as never,
    entry_conditions: [{ type: "always", value: 0 }], exit_conditions: [{ type: "time_after", value: 0.1 }],
    risk: { max_position_usd: 1000, max_daily_loss: 100, max_drawdown: 200, pause_after_loss_sec: 0, max_open_bots: 1 },
    monitor_interval_sec: 0.02,
  });

  it("bid 0.05 placed, skewed ask 0.02 ($2.18 < $5) skipped with a log; the run succeeds", async () => {
    registerStrategy("t-skew", () => ({
      name: "t-skew", init: async () => {}, onStop: async () => [],
      onTick: async () => [
        { type: "place_order", side: "buy", price: "108.5", size: "0.05", orderType: "limit" },
        { type: "place_order", side: "sell", price: "109.07", size: "0.02", orderType: "limit" },
      ],
    } as never));
    const { a, limitOrder } = adapter();
    const log = vi.fn();
    await expect(runBot(a, config("t-skew"), undefined, log, undefined, "headless", false)).resolves.toBeDefined();
    expect(limitOrder.mock.calls.every(c => (c as unknown[])[1] === "buy")).toBe(true);
    expect(limitOrder).toHaveBeenCalled();
  });

  it("every order undersized → the tick fails (the run surfaces SIZE_TOO_SMALL)", async () => {
    registerStrategy("t-tiny", () => ({
      name: "t-tiny", init: async () => {}, onStop: async () => [],
      onTick: async () => [{ type: "place_order", side: "buy", price: "108.5", size: "0.02", orderType: "limit" }],
    } as never));
    const { a, limitOrder } = adapter();
    await expect(runBot(a, config("t-tiny"), undefined, () => {}, undefined, "headless", false)).rejects.toThrow(/below the venue minimum order value/);
    expect(limitOrder).not.toHaveBeenCalled();
  });
});

describe("HIP-4 describeCoin (19)", () => {
  it("#14881 → outcome 1488 side 1 with its names", () => {
    const a = new HyperliquidOutcomeAdapter({} as never);
    (a as unknown as Record<string, unknown>)._outcomeMeta = { outcomes: [{ outcome: 1488, name: "Buffalo Bills", description: "", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" }], questions: [] };
    expect(a.describeCoin("#14881")).toEqual({ outcome: 1488, side: 1, name: "Buffalo Bills", sideName: "No" });
    expect(a.describeCoin("#99990")).toBeNull();
    expect(a.describeCoin("BTC")).toBeNull();
  });
});
