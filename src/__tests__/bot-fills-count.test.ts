/**
 * Live mainnet 2026-10-13: `perp -e aster strategy preset grid-conservative SOL --size 0.4 --headless`
 * placed 8 resting limit orders, none filled (positions [] all run), yet status / done reported
 * `"fills": 8` — the engine counted every accepted placement as a fill.
 * Now `fills` counts only orders the venue reported as (partly) filled (venue-final IOC outcome or
 * a TradingV2 OrderResult filledSize > 0); placements are counted separately (`ordersPlaced`).
 * DCA's --orders stop uses its own placement counter, so quick-dca still stops after N orders.
 */
import { describe, it, expect, vi } from "vitest";
import { executeActions, filledOf } from "../bot/engine.js";
import { asterIocOutcome } from "../exchanges/aster.js";
import { GridStrategy } from "../bot/strategies/grid-strategy.js";
import { DCAStrategy } from "../bot/strategies/dca-strategy.js";
import type { QuoteRules } from "../bot/quote-rules.js";
import type { StrategyAction, StrategyContext, EnrichedSnapshot } from "../bot/strategy-types.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

const rules: QuoteRules = { tickSize: "0.01", stepSize: "0.01", minSize: null, minNotional: null };
const rulesOf = async () => rules;

/** An Aster-like adapter: venue-final outcome via the real asterIocOutcome. */
function asterLike(limitResult: unknown, marketResult: unknown): ExchangeAdapter {
  return {
    name: "aster",
    limitOrder: vi.fn(async () => limitResult),
    marketOrder: vi.fn(async () => marketResult),
    cancelAllOrders: vi.fn(async () => ({})),
    iocOutcomeOf: (raw: unknown) => asterIocOutcome(raw),
  } as unknown as ExchangeAdapter;
}

const resting = { orderId: 1, status: "NEW", type: "LIMIT", timeInForce: "GTC", executedQty: "0" };
const marketFilled = { orderId: 2, status: "FILLED", type: "MARKET", timeInForce: "GTC", executedQty: "0.05" };
const limit = (side: "buy" | "sell", price: string): Extract<StrategyAction, { type: "place_order" }> => ({ type: "place_order", side, price, size: "0.05", orderType: "limit" });
const market: StrategyAction = { type: "place_order", side: "buy", price: "0", size: "0.05", orderType: "market" };

describe("executeActions fill counting", () => {
  it("resting limit orders are placements, never fills", async () => {
    const a = asterLike(resting, marketFilled);
    const r = await executeActions(a, "SOL", [limit("buy", "100"), limit("sell", "110")], () => {}, false, rulesOf, 105);
    expect(r).toEqual({ placed: 2, filled: 0 });
  });

  it("a market order the venue reports filled counts as a fill", async () => {
    const r = await executeActions(asterLike(resting, marketFilled), "SOL", [market], () => {}, false, rulesOf, 105);
    expect(r).toEqual({ placed: 1, filled: 1 });
  });

  it("an IOC that expired with nothing filled is not a fill", async () => {
    const expired = { status: "EXPIRED", type: "LIMIT", timeInForce: "IOC", executedQty: "0" };
    const r = await executeActions(asterLike(expired, marketFilled), "SOL", [{ ...limit("buy", "100"), tif: "IOC" }], () => {}, false, rulesOf, 105);
    expect(r).toEqual({ placed: 1, filled: 0 });
  });

  it("--dry-run: simulated placements, nothing filled, nothing sent", async () => {
    const a = asterLike(resting, marketFilled);
    const r = await executeActions(a, "SOL", [limit("buy", "100"), market, { type: "cancel_all" }], () => {}, true, rulesOf, 105);
    expect(r).toEqual({ placed: 2, filled: 0 });
    expect(a.limitOrder).not.toHaveBeenCalled();
    expect(a.marketOrder).not.toHaveBeenCalled();
  });
});

describe("filledOf", () => {
  const plain = { name: "arcus" } as unknown as ExchangeAdapter;
  it("TradingV2 OrderResult: filledSize reported → that size; null → unknown", () => {
    expect(filledOf(plain, { status: "partiallyFilled", filledSize: "0.02" })).toBe(0.02);
    expect(filledOf(plain, { status: "open", filledSize: "0" })).toBe(0);
    expect(filledOf(plain, { status: "accepted", filledSize: null })).toBeNull();
  });
  it("unrecognized result / adapter without an outcome → unknown (not a fill)", () => {
    expect(filledOf(plain, { orderId: "x" })).toBeNull();
    expect(filledOf(plain, null)).toBeNull();
  });
});

function ctx(adapter: ExchangeAdapter, config: Record<string, unknown>): StrategyContext {
  return { adapter, symbol: "SOL", config, state: new Map(), tick: 0, log: () => {} };
}
const snap = { price: 105 } as EnrichedSnapshot;

describe("strategies on verified fill counting", () => {
  it("grid-conservative: 8 resting grid orders → ordersPlaced 8, fills 0", async () => {
    const a = asterLike(resting, marketFilled);
    const g = new GridStrategy();
    const c = ctx(a, { grids: 8, size: 0.4, side: "neutral", range_mode: "auto", range_pct: 5, rebalance: true, rebalance_cooldown: 120 });
    await g.init(c, snap);
    const r = await executeActions(a, "SOL", await g.onTick(c, snap), () => {}, false, rulesOf, snap.price);
    expect(r).toEqual({ placed: 8, filled: 0 });
  });

  it("DCA --orders 2: stops after 2 placed orders regardless of the fill count", async () => {
    const a = asterLike(resting, { status: "NEW", type: "MARKET" }); // outcome not reported → not counted as a fill
    const d = new DCAStrategy();
    const c = ctx(a, { amount: 0.05, interval_sec: 0, total_orders: 2, side: "buy" });
    await d.init(c, snap);
    let placed = 0;
    let filled = 0;
    while (!d.isDone(c)) {
      const r = await executeActions(a, "SOL", await d.onTick(c, snap), () => {}, false, rulesOf, snap.price);
      placed += r.placed;
      filled += r.filled;
      c.tick++;
      if (c.tick > 10) throw new Error("DCA never finished");
    }
    expect({ placed, filled }).toEqual({ placed: 2, filled: 0 });
    expect(a.marketOrder).toHaveBeenCalledTimes(2);
  });
});
