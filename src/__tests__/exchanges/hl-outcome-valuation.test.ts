/**
 * HIP-4 outcome tokens in the shared spot valuation path (portfolio, bot equity).
 * Live 2026-10-13: HL spot held "+14881" (outcome 1488 side 1, quote USDC); allMids "#14881": "0.899595".
 * The token was "no market price — excluded" → bot equity unknown. It is now valued at its outcome
 * mid in the outcome's quote token, only when that quote is a venue spot quote asset; never 0.
 */
import { describe, expect, it, vi } from "vitest";
import { HyperliquidOutcomeAdapter } from "../../exchanges/hyperliquid-outcome.js";
import { HyperliquidSpotAdapter } from "../../exchanges/hyperliquid-spot.js";
import { spotMarketsForValuation, valueSpotBalances } from "../../exchanges/spot-factory.js";
import { getVenue } from "../../exchanges/venue.js";
import type { SpotAdapter, SpotBalance } from "../../exchanges/spot-interface.js";
import "../../exchanges/venues/index.js";

const meta = {
  outcomes: [
    { outcome: 1488, name: "template:sportsTournamentParticipant", description: "participant:Buffalo Bills", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" },
    { outcome: 7, name: "x", description: "", sideSpecs: [{ name: "Yes" }, { name: "No" }] },
  ],
  questions: [],
};

function outcomeAdapter(opts: { mids: unknown; metas?: unknown[] }) {
  const a = new HyperliquidOutcomeAdapter({ isTestnet: false } as never);
  const metas = [...(opts.metas ?? [meta])];
  const info = vi.fn(async (body: Record<string, unknown>) => {
    if (body.type === "outcomeMeta") return metas.length > 1 ? metas.shift() : metas[0];
    if (body.type === "allMids") return opts.mids;
    throw new Error(`unexpected ${JSON.stringify(body)}`);
  });
  (a as unknown as { _infoPost: typeof info })._infoPost = info;
  return { a, info };
}

describe("HyperliquidOutcomeAdapter.getBalanceCoinPrices", () => {
  it("prices +<enc> at allMids #<enc> with the outcome's quoteToken; non-outcome coins are not returned", async () => {
    const { a } = outcomeAdapter({ mids: { "#14880": "0.100405", "#14881": "0.899595", HYPE: "42" } });
    expect(await a.getBalanceCoinPrices(["+14881", "HYPE", "+1.5"])).toEqual([{ coin: "+14881", quoteToken: "USDC", mid: "0.899595" }]);
  });

  it("no mid / zero mid → mid null; outcome without quoteToken, unknown outcome or unknown side → quoteToken null", async () => {
    const { a, info } = outcomeAdapter({ mids: { "#14880": "0", "#71": "0.5" } });
    expect(await a.getBalanceCoinPrices(["+14880", "+14881", "+71", "+99990", "+14889"])).toEqual([
      { coin: "+14880", quoteToken: "USDC", mid: null },
      { coin: "+14881", quoteToken: "USDC", mid: null },
      { coin: "+71", quoteToken: null, mid: "0.5" },
      { coin: "+99990", quoteToken: null, mid: null },
      { coin: "+14889", quoteToken: null, mid: null },
    ]);
    // the unknown outcome 9999 made it re-read outcomeMeta once (init + 1)
    expect(info.mock.calls.filter(c => c[0].type === "outcomeMeta")).toHaveLength(2);
  });

  it("an outcome deployed after init is found by the outcomeMeta re-read", async () => {
    const later = { ...meta, outcomes: [...meta.outcomes, { outcome: 2000, name: "n", description: "", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" }] };
    const { a } = outcomeAdapter({ mids: { "#20000": "0.3" }, metas: [meta, later] });
    await a.init();
    expect(await a.getBalanceCoinPrices(["+20000"])).toEqual([{ coin: "+20000", quoteToken: "USDC", mid: "0.3" }]);
  });

  it("a malformed allMids is an EXCHANGE_ERROR (never an empty price list)", async () => {
    const { a } = outcomeAdapter({ mids: ["x"] });
    await expect(a.getBalanceCoinPrices(["+14881"])).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("HyperliquidSpotAdapter.getHoldingPrices", () => {
  it("asks the outcome adapter only for +<digits> tokens; markPrice null when the quote is unknown", async () => {
    const spot = new HyperliquidSpotAdapter({ isTestnet: false } as never);
    const prices = vi.spyOn(HyperliquidOutcomeAdapter.prototype, "getBalanceCoinPrices").mockResolvedValue([
      { coin: "+14881", quoteToken: "USDC", mid: "0.9" }, { coin: "+71", quoteToken: null, mid: "0.5" },
    ]);
    try {
      expect(await spot.getHoldingPrices(["UBTC"])).toEqual([]);
      expect(prices).not.toHaveBeenCalled();
      expect(await spot.getHoldingPrices(["UBTC", "+14881", "+71"])).toEqual([
        { token: "+14881", quoteToken: "USDC", markPrice: "0.9" }, { token: "+71", quoteToken: null, markPrice: null },
      ]);
      expect(prices).toHaveBeenCalledWith(["+14881", "+71"]);
    } finally { prices.mockRestore(); }
  });
});

describe("spotMarketsForValuation + valueSpotBalances (portfolio / bot equity path)", () => {
  const def = getVenue("hyperliquid");
  const bal = (token: string, total: string): SpotBalance => ({ token, total, available: total, held: "0", shared: false });
  const spotWith = (quoteToken: string | null) => {
    const getHoldingPrices = vi.fn(async (tokens: readonly string[]) => tokens.map(token => ({ token, quoteToken, markPrice: "0.9" })));
    return {
      spot: { name: "hyperliquid", getSpotMarkets: async () => [{ symbol: "HYPE/USDC", baseToken: "HYPE", quoteToken: "USDC", markPrice: "42", volume24h: null, sizeDecimals: 2, priceDecimals: 4 }], getHoldingPrices } as unknown as SpotAdapter,
      getHoldingPrices,
    };
  };
  const balances = [bal("USDC", "5"), bal("HYPE", "1"), bal("+14881", "10")];

  it("values a USDC-quoted outcome token at its mid; only held non-market, non-quote tokens are asked for", async () => {
    const { spot, getHoldingPrices } = spotWith("USDC");
    const markets = await spotMarketsForValuation(def, spot, balances, "mainnet");
    expect(getHoldingPrices).toHaveBeenCalledWith(["+14881"]);
    const warn = vi.fn();
    expect(valueSpotBalances(def, "mainnet", balances, markets, warn).map(b => [b.token, b.valueUsd])).toEqual([["USDC", 5], ["HYPE", 42], ["+14881", 9]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an outcome quoted in a non-quote asset (or unknown quote) stays unpriced — excluded + warned, never 0", async () => {
    for (const q of ["USDH", null]) {
      const { spot } = spotWith(q);
      const warn = vi.fn();
      const valued = valueSpotBalances(def, "mainnet", balances, await spotMarketsForValuation(def, spot, balances, "mainnet"), warn);
      expect(valued.map(b => b.token)).toEqual(["USDC", "HYPE"]);
      expect(warn.mock.calls[0][0]).toMatch(/\+14881: no market price/);
    }
  });

  it("no unlisted holdings → getHoldingPrices is not called", async () => {
    const { spot, getHoldingPrices } = spotWith("USDC");
    await spotMarketsForValuation(def, spot, [bal("HYPE", "1")], "mainnet");
    expect(getHoldingPrices).not.toHaveBeenCalled();
  });
});
