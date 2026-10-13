/**
 * Live mainnet 2026-10-12: funding-arb never entered with $13 accounts — hasEnoughBalance
 * required available ≥ notional × 1.5 whatever the leverage, i.e. $16.5 for an $11 leg that
 * needs ~$3 of margin at 5x. The check is now margin at the venue's market leverage × buffer.
 */
import { describe, it, expect, vi } from "vitest";
import { ARB_MARGIN_BUFFER, hasEnoughBalance, marketLeverageOf, requiredArbMargin } from "../rebalance.js";

const snaps = [
  { exchange: "pacifica", equity: 13, available: 13, marginUsed: 0, unrealizedPnl: 0 },
  { exchange: "hyperliquid", equity: 13, available: 13, marginUsed: 0, unrealizedPnl: 0 },
] as never;

describe("leverage-aware arb margin check", () => {
  it("margin = notional / leverage × buffer (1.5)", () => {
    expect(ARB_MARGIN_BUFFER).toBe(1.5);
    expect(requiredArbMargin(11, 5)).toBeCloseTo(3.3, 10);
    expect(requiredArbMargin(11, 1)).toBeCloseTo(16.5, 10);
  });

  it("an $11 leg at 3x / 5x fits a $13 account; at 1x it does not", () => {
    expect(hasEnoughBalance(snaps, "pacifica", 11, 5)).toBe(true);
    expect(hasEnoughBalance(snaps, "hyperliquid", 11, 3)).toBe(true);
    expect(hasEnoughBalance(snaps, "hyperliquid", 11, 1)).toBe(false);
  });

  it("unknown leverage (null) → the 1x requirement, never less", () => {
    expect(requiredArbMargin(11, null)).toBeCloseTo(16.5, 10);
    expect(hasEnoughBalance(snaps, "pacifica", 11, null)).toBe(false);
  });

  it("no snapshot for the exchange → false", () => {
    expect(hasEnoughBalance(snaps, "aster", 1, 10)).toBe(false);
  });

  it("marketLeverageOf prefers the per-symbol read, else the settings row, else null", async () => {
    expect(await marketLeverageOf({ marketLeverage: vi.fn(async () => 7) }, "BTC")).toBe(7);
    expect(await marketLeverageOf({ getMarketSettings: async () => [{ symbol: "BTC-PERP", leverage: 4 }] }, "BTC")).toBe(4);
    expect(await marketLeverageOf({ getMarketSettings: async () => [{ symbol: "ETH", leverage: 4 }] }, "BTC")).toBeNull();
    expect(await marketLeverageOf({}, "BTC")).toBeNull();
  });

  it("a failed leverage read throws (the caller skips the entry)", async () => {
    await expect(marketLeverageOf({ marketLeverage: async () => { throw new Error("429"); } }, "BTC")).rejects.toThrow("429");
  });
});
