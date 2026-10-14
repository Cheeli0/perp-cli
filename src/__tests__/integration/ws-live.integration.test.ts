/**
 * perp-cli/ws gated live check (plan ws-0.14.4 Phase 1 / 4): public channels on the six 0.14.4
 * venues, mainnet. Opt-in: PERP_WS_LIVE=1 pnpm test:integration -- ws-live
 * Read-only public data; one socket per venue for ≤ 30 s.
 */
import { describe, expect, it } from "vitest";
import { arcus, aster, createVenueStream, hyperliquid, lighter, lighterRh, pacifica } from "../../ws/node.js";
import type { BboUpdate, MarketUpdate, StreamControl, VenueCodec } from "../../ws/types.js";

const LIVE = process.env.PERP_WS_LIVE === "1";
const BBO_SYMBOL: Record<string, string> = { hyperliquid: "BTC", pacifica: "BTC", lighter: "BTC", "lighter-rh": "BTC", aster: "BTCUSDT", arcus: "BTC-USD" };

describe.skipIf(!LIVE)("perp-cli/ws live public channels (opt-in: PERP_WS_LIVE=1)", () => {
  it.each([hyperliquid, pacifica, lighter, lighterRh, aster, arcus].map(c => [c.venue, c] as [string, VenueCodec]))(
    "%s: ≥ 1 MarketUpdate within 30 s, plus bbo; no protocol errors",
    async (venue, codec) => {
      const stream = createVenueStream(codec);
      const markets: MarketUpdate[] = [];
      const bbos: BboUpdate[] = [];
      const errors: Array<Extract<StreamControl, { type: "error" }>> = [];
      const all = stream.subscribe({ kind: "allMarkets" });
      const bbo = stream.subscribe({ kind: "market", symbol: BBO_SYMBOL[venue], channels: ["bbo"] });
      all.on(e => { if (e.type === "market") markets.push(e); if (e.type === "error") errors.push(e); });
      bbo.on(e => { if (e.type === "bbo") bbos.push(e); if (e.type === "error") errors.push(e); });
      const deadline = Date.now() + 30_000;
      // (Aster's !ticker@arr may arrive before the markPrice stream: wait for a mark)
      while (Date.now() < deadline && (!markets.some(x => x.mark !== null) || bbos.length === 0)) await new Promise(r => setTimeout(r, 250));
      await stream.close();
      expect(markets.length, `${venue}: market updates`).toBeGreaterThan(0);
      expect(bbos.length, `${venue}: bbo updates`).toBeGreaterThan(0);
      expect(errors.filter(e => e.code === "WS_PROTOCOL_ERROR").map(e => e.message), venue).toEqual([]);
      const m = markets.find(x => x.mark !== null);
      expect(m, `${venue}: a market with a mark`).toBeDefined();
      expect(m!.funding.rateKind).not.toBeNull();
    },
    40_000,
  );
});
