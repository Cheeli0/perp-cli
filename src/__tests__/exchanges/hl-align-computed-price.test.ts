import { describe, it, expect } from "vitest";
import { hlAlignPriceToGrid, hlRequirePriceOnGrid } from "../../exchanges/hyperliquid.js";

describe("hlAlignPriceToGrid (computed prices → HL grid, passive direction)", () => {
  it("ETH (szDecimals 4): 6 significant figures are cut to 5, buy down / sell up", () => {
    expect(hlAlignPriceToGrid("2515.37", 4, 6, "down")).toBe("2515.3");
    expect(hlAlignPriceToGrid("2515.37", 4, 6, "up")).toBe("2515.4");
  });

  it("already on the grid → unchanged", () => {
    expect(hlAlignPriceToGrid("2515.3", 4, 6, "down")).toBe("2515.3");
    expect(hlAlignPriceToGrid("108000", 5, 6, "up")).toBe("108000");
  });

  it("decimal cap from szDecimals (perps: 6 − szDecimals)", () => {
    // szDecimals 0 (e.g. a 0.3 USD coin): up to 6 decimals but 5 significant figures
    expect(hlAlignPriceToGrid("0.3401678", 0, 6, "down")).toBe("0.34016");
    // szDecimals 5 → at most 1 decimal
    expect(hlAlignPriceToGrid("98765.43", 5, 6, "up")).toBe("98766");
  });

  it("every result passes the refusal check used by limitOrder", () => {
    for (const [px, sz] of [["2515.37", 4], ["0.3401678", 0], ["98765.43", 5], ["9.99996", 2], ["107.2345", 2]] as const) {
      for (const dir of ["down", "up"] as const) {
        const aligned = hlAlignPriceToGrid(px, sz, 6, dir);
        expect(hlRequirePriceOnGrid(aligned, sz, 6, "price")).toBe(aligned);
        if (dir === "down") expect(Number(aligned)).toBeLessThanOrEqual(Number(px));
        else expect(Number(aligned)).toBeGreaterThanOrEqual(Number(px));
      }
    }
  });

  it("refuses non-numeric input", () => {
    expect(() => hlAlignPriceToGrid("abc", 4, 6, "down")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});
