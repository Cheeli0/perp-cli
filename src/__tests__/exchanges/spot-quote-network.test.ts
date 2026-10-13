/**
 * Spot quote / transfer asset follows the selected network's collateral (live testnet E2E
 * 2026-10-02, Lighter RH s-transfer-in: "lighter-rh spot↔perp transfer only moves USDC (got USDG)"
 * — the CLI derived USDG, the RH MAINNET collateral, on testnet where the collateral is USDC).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../../exchanges/venues/index.js";
import { getVenue, listVenues } from "../../exchanges/venue.js";
import { defaultSpotQuote, findSpotQuoteBalance, getSpotAdapter, spotNetworkOf, spotPairSymbol, transferQuoteToSpot } from "../../exchanges/spot-factory.js";
import { setSharedApiNetwork } from "../../api/public/urls.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import type { SpotAdapter } from "../../exchanges/spot-interface.js";

afterEach(() => {
  setSharedApiNetwork("mainnet");
  vi.restoreAllMocks();
});

describe("network-keyed spot quote", () => {
  it("Lighter RH: USDG on mainnet, USDC on testnet (= networks.<net>.collateral)", () => {
    const rh = getVenue("lighter-rh");
    expect(defaultSpotQuote(rh, "mainnet")).toBe("USDG");
    expect(defaultSpotQuote(rh, "testnet")).toBe("USDC");
    expect(spotPairSymbol(rh, "testnet", "eth")).toBe("ETH/USDC");
    expect(findSpotQuoteBalance(rh, "testnet", [{ token: "USDG", total: "1", available: "1", held: "0", shared: false }, { token: "USDC", total: "2", available: "2", held: "0", shared: false }])?.total).toBe("2");
  });

  it("every Lighter-family spot quote is that network's collateral", () => {
    for (const def of listVenues().filter(v => v.family === "lighter" && v.spot !== null)) {
      for (const net of ["mainnet", "testnet"] as const) {
        expect(defaultSpotQuote(def, net)).toBe(def.networks[net]!.collateral[0]);
      }
    }
  });

  it("spot-transfer on Lighter RH testnet sends USDC (the adapter's own quote)", async () => {
    setSharedApiNetwork("testnet");
    const rh = getVenue("lighter-rh");
    const transferToSpot = vi.fn().mockResolvedValue({ ok: true });
    const fake = { name: "lighter-rh", transferToSpot, transferToPerp: vi.fn() } as unknown as SpotAdapter;
    vi.spyOn(rh.spot!, "createSpot").mockResolvedValue(fake);
    const perp = { name: "lighter-rh" } as unknown as ExchangeAdapter;
    const spot = await getSpotAdapter("lighter-rh", perp);
    expect(spotNetworkOf(spot!)).toBe("testnet");
    await expect(transferQuoteToSpot(spot!, 12.5)).resolves.toBe(true);
    expect(transferToSpot).toHaveBeenCalledWith("12.5", "USDC");
  });
});
