/**
 * Funding rates sent as JSON numbers carry float noise (live Lighter /funding-rates:
 * `"rate":0.00009599999999999999`; `market prices` printed -0.000047999999999999994).
 * They are written as plain decimals at a double's exact precision; missing rates throw.
 */
import { describe, it, expect } from "vitest";
import { venueRateField, venueRateString } from "../utils/numeric.js";

describe("venueRateString", () => {
  it.each([
    [0.00009599999999999999, "0.000096"],
    [-0.000047999999999999994, "-0.000048"],
    [0.00008800000000000001, "0.000088"],
    [1.2e-7, "0.00000012"],
    [0.0001, "0.0001"],
    [0, "0"],
    [12.5, "12.5"],
    [1500, "1500"],
    [-3e-9, "-0.000000003"],
  ])("%s → %s", (n, s) => {
    expect(venueRateString(n)).toBe(s);
  });

  it("non-finite → EXCHANGE_ERROR", () => {
    expect(() => venueRateString(NaN)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
  });
});

describe("venueRateField", () => {
  it("numbers are cleaned, numeric strings kept verbatim", () => {
    expect(venueRateField(-0.000047999999999999994, "rate", "lighter")).toBe("-0.000048");
    expect(venueRateField("0.0000125000", "fundingRate", "hyperliquid")).toBe("0.0000125000");
  });

  it.each([undefined, null, "", "abc", Infinity])("%s → EXCHANGE_ERROR (never \"0\")", (v) => {
    expect(() => venueRateField(v, "fundingRate", "aster")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
  });
});
