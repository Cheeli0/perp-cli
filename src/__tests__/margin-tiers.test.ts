/**
 * Notional-tiered leverage caps.
 *
 * `ExchangeMarketInfo.maxLeverage` is only the TOP tier. Hyperliquid publishes
 * `marginTables` in the SAME metaAndAssetCtxs response the adapter already
 * fetches (zero extra calls), and 36 of 233 symbols step down above a notional
 * threshold — BTC is 40x up to $150M and 20x above. A pre-trade check that reads
 * the flat value alone waves through orders the venue then rejects, and the
 * "exceeds max" warning was tautological because leverage defaulted FROM
 * maxLeverage.
 */
import { describe, it, expect } from "vitest";
import { maxLeverageForNotional } from "../exchanges/interface.js";
import type { ExchangeMarketInfo } from "../exchanges/interface.js";

const base: ExchangeMarketInfo = {
  symbol: "BTC", markPrice: "100000", indexPrice: "100000", fundingRate: "0",
  volume24h: "0", openInterest: "0", maxLeverage: 40,
  sizeDecimals: 5, stepSize: "0.00001", fundingHours: 1,
  // SSOT Rule #2: unpublished = null (required field), never omitted.
  marginTiers: null,
};

// Real shape from POST /info {"type":"meta"} table 56 ("tiered 40x").
const btc: ExchangeMarketInfo = {
  ...base,
  marginTiers: [
    { lowerBound: 0, maxLeverage: 40 },
    { lowerBound: 150_000_000, maxLeverage: 20 },
  ],
};

describe("maxLeverageForNotional", () => {
  it("returns the top tier below the threshold", () => {
    expect(maxLeverageForNotional(btc, 1_000_000)).toBe(40);
  });

  it("steps down at the threshold", () => {
    expect(maxLeverageForNotional(btc, 150_000_000)).toBe(20);
  });

  it("stays stepped down above the threshold", () => {
    expect(maxLeverageForNotional(btc, 500_000_000)).toBe(20);
  });

  it("uses the flat cap when the venue publishes no tiers (marginTiers: null)", () => {
    // Pacifica / Lighter / Aster do not supply tiers — they must be unaffected.
    expect(maxLeverageForNotional(base, 500_000_000)).toBe(40);
  });

  it("falls back to the flat cap for an empty tier list", () => {
    expect(maxLeverageForNotional({ ...base, marginTiers: [] }, 1)).toBe(40);
  });

  // Contract change (interface.ts maxLeverageForNotional): a non-finite notional is a caller
  // bug — it throws instead of silently returning the top-tier (most permissive) cap.
  it("throws for a non-finite notional rather than returning the most permissive cap", () => {
    expect(() => maxLeverageForNotional(btc, Number.NaN)).toThrow(/notional must be finite/);
    expect(() => maxLeverageForNotional(btc, Number.POSITIVE_INFINITY)).toThrow(/notional must be finite/);
  });

  it("handles a three-tier ladder", () => {
    const m: ExchangeMarketInfo = {
      ...base, maxLeverage: 50,
      marginTiers: [
        { lowerBound: 0, maxLeverage: 50 },
        { lowerBound: 1_000_000, maxLeverage: 20 },
        { lowerBound: 10_000_000, maxLeverage: 5 },
      ],
    };
    expect(maxLeverageForNotional(m, 999_999)).toBe(50);
    expect(maxLeverageForNotional(m, 1_000_000)).toBe(20);
    expect(maxLeverageForNotional(m, 9_999_999)).toBe(20);
    expect(maxLeverageForNotional(m, 10_000_000)).toBe(5);
  });
});
