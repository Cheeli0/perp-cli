/**
 * Arcus codec (§6.1, C1). All markets = ONE `markets` subscription: a full all-market snapshot
 * (`subscribed`, then `channel_data` every ~5 s and on funding apply). It carries markPrice (no
 * oraclePrices subscription needed), fundingRate = last applied (lastSettled; Phase 0: == REST
 * /v1/fundingRates latest), nextFundingRate = predicted, nextFundingAt in unix SECONDS, openInterest
 * base (one side), volume24hNotional USD (volume24h is base).
 * Errors are {type:"error", message} with no channel/id.
 *
 * Docs: docs.arcus.xyz/api-reference/market-data/markets; fixtures src/__tests__/fixtures/ws/arcus/.
 */

import { badShape, fetchJson } from "../directory.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { DecodedEvent, MarketDirectoryEntry, MarketPatch, VenueCodec, WireSub } from "../types.js";
import { badFieldsError, capabilities, compact, isObj, parseFrame, protocolError, readDec, readTs, unrecognised, type Obj } from "./common.js";

const S = VENUE_STATIC.arcus;
const MARKETS = "markets";

interface ArcusData {
  idToSymbol: Map<string, string>;
}

export const arcus: VenueCodec = {
  venue: "arcus",
  capabilities: capabilities({
    testnet: true,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: true, predictedRate: true,
      nextFundingTime: true, fundingInterval: true, openInterest: true, volume24hNotional: true,
    },
    notes: {
      bestBid: "Not in `markets`; use the bbo channel (Phase 2)",
      bestAsk: "Not in `markets`; use the bbo channel (Phase 2)",
      openInterest: "Base units, one side (~60 s venue cadence)",
    },
  }),
  url: (n) => S.wsUrl[n],
  restUrl: (n) => S.restUrl[n],
  secretKeys: [],
  secretUrlPatterns: [],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: false,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: "base", sides: "one" },
  refresh: null,

  async loadDirectory(ctx) {
    const raw = await fetchJson(ctx.fetch, "arcus", `${ctx.restUrl}/v1/markets`);
    if (!isObj(raw) || !Array.isArray(raw.markets)) throw badShape("arcus", "GET /v1/markets has no markets array");
    const entries: MarketDirectoryEntry[] = [];
    const idToSymbol = new Map<string, string>();
    for (const m of raw.markets) {
      if (!isObj(m) || typeof m.marketDisplayName !== "string" || typeof m.marketId !== "number" || typeof m.baseAsset !== "string") {
        throw badShape("arcus", "market without marketDisplayName/marketId/baseAsset");
      }
      const quote = typeof m.quoteAsset === "string" ? m.quoteAsset : null;
      idToSymbol.set(String(m.marketId), m.marketDisplayName);
      entries.push({
        venue: "arcus", dex: null, symbol: m.marketDisplayName, venueSymbol: m.marketDisplayName, base: m.baseAsset, quote,
        canonical: ctx.canonicalize("arcus", { venueSymbol: m.marketDisplayName, dex: null, base: m.baseAsset, quote }),
        rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/v1/markets",
      });
    }
    return { entries, data: { idToSymbol } satisfies ArcusData };
  },

  fundingMeta: () => ({
    rateKind: "lastSettled", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
    intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
  }),

  wiresFor(_target, _dir, staleOverrideMs): WireSub[] {
    return [{ key: MARKETS, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { channel: MARKETS } }];
  },
  encodeSubscribe: (w) => JSON.stringify({ type: "subscribe", channel: w.params.channel }),
  encodeUnsubscribe: (w) => JSON.stringify({ type: "unsubscribe", channel: w.params.channel }),

  decode(text, dir): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f) || typeof f.type !== "string") return [unrecognised("arcus")];
    switch (f.type) {
      case "connected":
        return [{ t: "ignore", what: "connected" }];
      case "pong":
        return [{ t: "pong" }];
      case "unsubscribed":
        return [{ t: "ack", wire: f.channel === MARKETS ? MARKETS : null, reqId: null, unsubscribe: true }];
      case "error":
        return [protocolError(`arcus error: ${typeof f.message === "string" ? f.message : JSON.stringify(f)}`)];
      case "subscribed":
      case "channel_data":
        if (f.channel !== MARKETS) return [unrecognised("arcus")];
        return decodeMarkets(f, dir.data as ArcusData);
      default:
        return [unrecognised("arcus")];
    }
  },
};

function decodeMarkets(f: Obj, d: ArcusData): DecodedEvent[] {
  if (!isObj(f.contents) || !isObj(f.contents.markets)) return [protocolError("arcus markets frame without contents.markets", MARKETS)];
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  for (const [id, m] of Object.entries(f.contents.markets)) {
    if (!isObj(m)) { badRows.push({ symbol: `#${id}`, fields: ["entry"] }); continue; }
    const known = d.idToSymbol.get(id);
    // Unknown id: emit under the frame's name so the stream reports it as "not in the directory".
    const symbol = known !== undefined ? known : typeof m.marketDisplayName === "string" ? m.marketDisplayName : `#${id}`;
    const bad: string[] = [];
    patches.push(compact({
      symbol,
      venueTs: null, // `markets` carries no frame timestamp
      mark: readDec(m, "markPrice", bad),
      index: readDec(m, "oraclePrice", bad),
      last: readDec(m, "lastTradePrice", bad),
      rate: readDec(m, "fundingRate", bad),
      predictedRate: readDec(m, "nextFundingRate", bad),
      nextFundingTime: readTs(m, "nextFundingAt", bad, 1000),
      openInterest: readDec(m, "openInterest", bad),
      volume24hNotional: readDec(m, "volume24hNotional", bad),
    }) as MarketPatch);
    if (bad.length > 0) badRows.push({ symbol, fields: bad });
  }
  const out: DecodedEvent[] = [{ t: "market", wire: MARKETS, patches }];
  if (badRows.length > 0) out.push(badFieldsError("arcus", MARKETS, badRows));
  return out;
}
