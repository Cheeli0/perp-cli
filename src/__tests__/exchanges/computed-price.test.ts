/**
 * Prices that are COMPUTED (average, mid, notional / size) are printed without binary float
 * noise; a venue-reported fill price is read only from fill fields (never the sent price).
 */
import { describe, it, expect } from "vitest";
import { formatComputedPrice } from "../../exchanges/precision.js";
import { reportedAvgFillPrice } from "../../exchanges/ioc-outcome.js";
import { PerpError } from "../../errors.js";

describe("formatComputedPrice", () => {
  it("drops float noise seen live (HL positions markPrice, Ondo avgPrice)", () => {
    expect(formatComputedPrice(2727.2000000000003)).toBe("2727.2");
    expect(formatComputedPrice(2727.2999999999997)).toBe("2727.3");
    expect(formatComputedPrice(2723.8199999999997)).toBe("2723.82");
    expect(formatComputedPrice(128.172 / 0.047)).toBe("2727.0638"); // 8 significant digits
  });

  it("rounds to the market tick's decimals when the tick is given", () => {
    expect(formatComputedPrice(120.73500000000001, "0.0001")).toBe("120.735");
    expect(formatComputedPrice(2723.8199999999997, "0.1")).toBe("2723.8");
    expect(formatComputedPrice(100123.4, "1")).toBe("100123");
  });

  it("keeps small and large magnitudes as plain decimals (no exponent, no padding)", () => {
    expect(formatComputedPrice(0.000012345678912)).toBe("0.000012345679");
    expect(formatComputedPrice(100123)).toBe("100123");
    expect(formatComputedPrice(123456789.123)).toBe("123456789");
    expect(formatComputedPrice(0)).toBe("0");
  });

  it("a non-finite value throws (never 'NaN' / '0')", () => {
    expect(() => formatComputedPrice(NaN)).toThrow(PerpError);
    expect(() => formatComputedPrice(1 / 0)).toThrow(/not a finite number/);
  });
});

describe("reportedAvgFillPrice", () => {
  it("reads the fill price: Aster avgPrice, Hyperliquid statuses[0].filled.avgPx, OrderResult.avgPrice", () => {
    expect(reportedAvgFillPrice({ price: "121.315", avgPrice: "120.735", executedQty: "0.05" })).toBe("120.735");
    expect(reportedAvgFillPrice({ response: { data: { statuses: [{ filled: { totalSz: "0.05", avgPx: "2723.83" } }] } } })).toBe("2723.83");
    expect(reportedAvgFillPrice({ venue: "ondo", avgPrice: "2723.82", filledSize: "0.01" })).toBe("2723.82");
  });

  it("null when the venue reports none — never the order's own price", () => {
    expect(reportedAvgFillPrice({ orderId: "m1", price: "60000" })).toBeNull();
    expect(reportedAvgFillPrice({ avgPrice: "0.0000", price: "121.3" })).toBeNull(); // Aster: nothing executed
    expect(reportedAvgFillPrice({ avgPrice: null })).toBeNull();
    expect(reportedAvgFillPrice({ response: { data: { statuses: [{ resting: { oid: 1 } }] } } })).toBeNull();
    expect(reportedAvgFillPrice(null)).toBeNull();
    expect(reportedAvgFillPrice("filled")).toBeNull();
  });
});
