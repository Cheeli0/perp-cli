/**
 * Pre-release QA sweep (0.15.0) — `arb scan --basis` paired unrelated assets that share a ticker
 * (BB on Lighter 8.4985 vs Aster 0.0091; MEME on HL 0.000527 vs Aster 0.01176) because it matched
 * raw symbols across four hard-coded venues. It now uses the perp-perp scan's grouping
 * (fetchAllFundingRates: canonical symbol, median price-outlier drop) over every verified
 * market-data venue, and the chosen cheap / rich pair must agree within MAX_PRICE_DEVIATION_PCT.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../funding/history.js", () => ({ getHistoricalAverages: () => new Map() }));

import { handleBasisScan } from "../commands/arb.js";
import { listVenues } from "../exchanges/venue.js";
import type { VenueFundingRate, VenueId } from "../exchanges/venue-types.js";
import "../exchanges/venues/index.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

const HOURLY = { kind: "perHours", hours: 1 } as const;
const row = (venue: VenueId, symbol: string, canonical: string | null, mark: string): VenueFundingRate => ({
  venue, venueSymbol: symbol, symbol, canonical, rate: "0.00001", basis: HOURLY, markPrice: mark, nextFundingTime: null,
});

function venuesReturn(rows: Partial<Record<VenueId, VenueFundingRate[]>>) {
  for (const v of listVenues()) {
    const r = rows[v.id];
    vi.spyOn(v.publicData, "fetchFundingRates").mockImplementation(async () => {
      if (r === undefined) throw new Error(`${v.id} offline`);
      return r;
    });
  }
}

async function scan(minBasis = "0", symbol?: string) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
  await handleBasisScan(() => true, { minBasis, symbol });
  return { data: JSON.parse(out[out.length - 1]).data as Array<{ symbol: string; prices: Record<string, number>; buyOn: string; sellOn: string; pctDiff: number }>, err };
}

describe("arb scan --basis", () => {
  it("never pairs the same ticker on unrelated assets (BB 8.4985 vs 0.0091)", async () => {
    venuesReturn({
      lighter: [row("lighter", "BB", "BB", "8.4985"), row("lighter", "BTC", "BTC", "83000")],
      aster: [row("aster", "BB", "BB", "0.00911904"), row("aster", "BTC", "BTC", "83050")],
    });
    const { data } = await scan();
    expect(data.map((o) => o.symbol)).toEqual(["BTC"]);
    expect(data[0]).toMatchObject({ buyOn: "lighter", sellOn: "aster", prices: { lighter: 83000, aster: 83050 } });
  });

  it("an outlier venue is dropped and the rest of the group still compares (MEME)", async () => {
    venuesReturn({
      hyperliquid: [row("hyperliquid", "MEME", "MEME", "0.000527")],
      lighter: [row("lighter", "MEME", "MEME", "0.000529")],
      pacifica: [row("pacifica", "MEME", "MEME", "0.000528")],
      aster: [row("aster", "MEME", "MEME", "0.01176")],
    });
    const { data } = await scan();
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0].prices).sort()).toEqual(["hyperliquid", "lighter", "pacifica"]);
  });

  it("the chosen pair must agree within MAX_PRICE_DEVIATION_PCT even when the median filter keeps both", async () => {
    // median 103.5: each venue within 5% of it, but the extremes are 6.8% apart.
    venuesReturn({
      hyperliquid: [row("hyperliquid", "XYZ", "XYZ", "100")],
      lighter: [row("lighter", "XYZ", "XYZ", "103.5")],
      pacifica: [row("pacifica", "XYZ", "XYZ", "107")],
    });
    const { data, err } = await scan();
    expect(data).toEqual([]);
    expect(err.join("\n")).toMatch(/\[basis-scan\] excluded XYZ hyperliquid↔pacifica: mark gap 6\.8% > 5%/);
  });

  it("an unclassified ticker (canonical null) never pairs", async () => {
    venuesReturn({
      lighter: [row("lighter", "OIL", null, "94")],
      aster: [row("aster", "OIL", null, "95")],
    });
    expect((await scan()).data).toEqual([]);
  });

  it("covers every verified market-data venue, not the former four", async () => {
    venuesReturn({
      ondo: [row("ondo", "AAPL", "AAPL", "341.1")],
      arcus: [row("arcus", "AAPL", "AAPL", "341.3")],
      "lighter-rh": [row("lighter-rh", "AAPL", "AAPL", "341.4")],
    });
    const { data } = await scan();
    expect(Object.keys(data[0].prices).sort()).toEqual(["arcus", "lighter-rh", "ondo"]);
  });

  it("a failed venue is reported on stderr, never silently absent", async () => {
    venuesReturn({ lighter: [row("lighter", "BTC", "BTC", "83000")] });
    const { err } = await scan();
    expect(err.some((e) => /\[basis-scan\] aster fetch failed: aster offline/.test(e))).toBe(true);
  });
});
