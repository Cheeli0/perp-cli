/**
 * Pacifica codec (§6.1). All markets = `prices` (one subscription, every ~3 s). funding = last
 * settled hourly rate, next_funding = predicted (Phase 0: == REST funding_rate history). open_interest
 * is base units; volume_24h USD. No bid/ask in `prices` (bbo channel, Phase 2).
 * An unknown symbol is acked with no data and no error frame → symbols are validated first.
 *
 * Docs: pacifica.gitbook.io/docs/api-documentation/api/websocket; fixtures in
 * src/__tests__/fixtures/ws/pacifica/.
 */

import { badShape, fetchJson } from "../directory.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { DecodedEvent, MarketDirectoryEntry, MarketPatch, VenueCodec, WireSub } from "../types.js";
import { badFieldsError, capabilities, compact, isObj, parseFrame, readDec, readTs, unrecognised } from "./common.js";

const S = VENUE_STATIC.pacifica;
const PRICES = "prices";

function sourceKey(d: unknown): string | null {
  if (!isObj(d) || typeof d.source !== "string") return null;
  return typeof d.symbol === "string" ? `${d.source}:${d.symbol}` : d.source;
}

export const pacifica: VenueCodec = {
  venue: "pacifica",
  capabilities: capabilities({
    testnet: true,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: false, predictedRate: true,
      nextFundingTime: false, fundingInterval: true, openInterest: true, volume24hNotional: true,
    },
    notes: {
      bestBid: "`prices` has no bid/ask; use the bbo channel (Phase 2)",
      bestAsk: "`prices` has no bid/ask; use the bbo channel (Phase 2)",
      last: "Not in `prices`",
      nextFundingTime: "Not in `prices`",
      openInterest: "Base units",
    },
  }),
  url: (n) => S.wsUrl[n],
  restUrl: (n) => S.restUrl[n],
  secretKeys: [],
  secretUrlPatterns: [/PF-API-KEY=[^&\s"']+/gi],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: false,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: "base", sides: null },
  refresh: null,

  async loadDirectory(ctx) {
    const raw = await fetchJson(ctx.fetch, "pacifica", `${ctx.restUrl}/info`);
    if (!isObj(raw) || !Array.isArray(raw.data)) throw badShape("pacifica", "GET /info has no data array");
    const entries: MarketDirectoryEntry[] = [];
    for (const m of raw.data) {
      if (!isObj(m) || typeof m.symbol !== "string") throw badShape("pacifica", "GET /info market without symbol");
      const base = m.symbol; // Pacifica perp symbols are the base asset (BTC, kBONK, …)
      const quote = "USDC"; // venue collateral / quote (venue definition)
      entries.push({
        venue: "pacifica", dex: null, symbol: m.symbol, venueSymbol: m.symbol, base, quote,
        canonical: ctx.canonicalize("pacifica", { venueSymbol: m.symbol, dex: null, base, quote }),
        rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/api/v1/info",
      });
    }
    return { entries, data: null };
  },

  fundingMeta: () => ({
    rateKind: "lastSettled", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
    intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
  }),

  wiresFor(_target, _dir, staleOverrideMs): WireSub[] {
    return [{ key: PRICES, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { source: PRICES } }];
  },
  encodeSubscribe: (w) => JSON.stringify({ method: "subscribe", params: w.params }),
  encodeUnsubscribe: (w) => JSON.stringify({ method: "unsubscribe", params: w.params }),

  decode(text): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f) || typeof f.channel !== "string") return [unrecognised("pacifica")];
    switch (f.channel) {
      case "pong":
        return [{ t: "pong" }];
      case "subscribe":
      case "unsubscribe":
        return [{ t: "ack", wire: sourceKey(f.data), reqId: null, unsubscribe: f.channel === "unsubscribe" }];
      case PRICES: {
        if (!Array.isArray(f.data)) return [unrecognised("pacifica")];
        const patches: MarketPatch[] = [];
        const badRows: Array<{ symbol: string; fields: string[] }> = [];
        const out: DecodedEvent[] = [];
        for (const r of f.data) {
          if (!isObj(r) || typeof r.symbol !== "string") { badRows.push({ symbol: "?", fields: ["symbol"] }); continue; }
          const bad: string[] = [];
          patches.push(compact({
            symbol: r.symbol,
            venueTs: (() => { const t = readTs(r, "timestamp", bad); return t === undefined ? null : t; })(),
            mark: readDec(r, "mark", bad),
            index: readDec(r, "oracle", bad),
            rate: readDec(r, "funding", bad),
            predictedRate: readDec(r, "next_funding", bad),
            openInterest: readDec(r, "open_interest", bad),
            volume24hNotional: readDec(r, "volume_24h", bad),
          }) as MarketPatch);
          if (bad.length > 0) badRows.push({ symbol: r.symbol, fields: bad });
        }
        if (badRows.length > 0) out.push(badFieldsError("pacifica", PRICES, badRows));
        return [{ t: "market", wire: PRICES, patches }, ...out];
      }
      default:
        return [unrecognised("pacifica")];
    }
  },
};
