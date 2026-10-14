/**
 * Pre-release QA sweep (0.15.0), review L7 — the bot engine's EnrichedSnapshot.openInterest was a
 * hard-coded "0" (never read from the venue). It is null (unknown); OI consumers treat null as
 * "no OI signal" explicitly instead of computing on a fake 0.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../bot/conditions.js", async (orig) => ({
  ...(await orig<typeof import("../bot/conditions.js")>()),
  getMarketSnapshot: vi.fn(async () => ({ price: 100, high24h: 0, low24h: 0, volume24h: 0, fundingRate: 0, volatility24h: 0, rsi: NaN, spreadPct: 0 })),
}));

import { getEnrichedSnapshot } from "../bot/engine.js";
import { LiquidationMmStrategy } from "../bot/strategies/liquidation-mm.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

describe("bot snapshot open interest", () => {
  it("is null (unknown), not \"0\" — for a symbol and for ALL", async () => {
    const adapter = { name: "x", getOrderbook: async () => ({ bids: [], asks: [] }), getKlines: async () => [] } as unknown as ExchangeAdapter;
    expect((await getEnrichedSnapshot(adapter, "BTC", () => {})).snapshot.openInterest).toBeNull();
    expect((await getEnrichedSnapshot(adapter, "ALL", () => {})).snapshot.openInterest).toBeNull();
  });

  it("liquidation-mm says once that cascade detection is off without OI", async () => {
    const s = new LiquidationMmStrategy();
    const logs: string[] = [];
    const ctx = { config: {}, state: new Map<string, unknown>(), log: (m: string) => logs.push(m), tick: 0, symbol: "BTC", adapter: {} } as never;
    const snap = { price: 100, openInterest: null, klines: [], orderbook: { bids: [["99", "1"]], asks: [["101", "1"]] }, volatility24h: 0 } as never;
    await s.init(ctx, snap);
    await s.onTick(ctx, snap);
    await s.onTick(ctx, snap);
    expect(logs.filter((l) => /open interest unknown/i.test(l))).toHaveLength(1);
    expect(ctx).toBeDefined();
  });
});
