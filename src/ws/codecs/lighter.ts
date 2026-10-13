/**
 * Lighter / Lighter RH codec (§6.1). All markets = `market_stats/all`: the first frame
 * (`subscribed/market_stats`) has every market, then `update/market_stats` ~1 s with ONLY the
 * changed markets (each entry complete) → merged per market.
 *
 * Units (Phase 0, the key correction): WS `funding_rate` (last settled) and `current_funding_rate`
 * (predicted) are PERCENT per 1 h → converted to a fraction by an exact 2-place decimal shift,
 * rateIntervalHours = settlementIntervalHours = 1. `open_interest` is USD notional (not base).
 * Errors arrive as {error:{code,message}} with no channel field (matched by the channel name in
 * the message). Spot markets (market_type "spot" in /api/v1/orderBooks) are not perps and skipped.
 *
 * Docs: apidocs.lighter.xyz/docs/websocket-reference; fixtures src/__tests__/fixtures/ws/lighter{,-rh}/.
 */

import { shiftDecimal } from "../dec.js";
import { badShape, fetchJson } from "../directory.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { DecodedEvent, Dec, MarketDirectoryEntry, MarketPatch, VenueCodec, WireSub } from "../types.js";
import {
  badFieldsError, capabilities, compact, isObj, nextHour, parseFrame, protocolError, readDec, unrecognised, venueError, type Obj,
} from "./common.js";

const ALL = "market_stats/all";

interface LighterData {
  idToSymbol: Map<string, string>;
  /** Non-perp market ids (spot) present in the venue's market list. */
  nonPerp: Set<string>;
}

/** best bid/ask: Lighter sends "" when that side of the book is empty (live, 2026-10-13) → null. */
function bookSide(o: Obj, key: string, bad: string[]): Dec | null | undefined {
  return o[key] === "" ? null : readDec(o, key, bad);
}

function percentToFraction(o: Obj, key: string, bad: string[]): Dec | null | undefined {
  const v = readDec(o, key, bad);
  if (v === undefined || v === null) return v;
  const f = shiftDecimal(v, -2);
  if (f === undefined) { bad.push(key); return undefined; }
  return f;
}

function makeLighter(venue: "lighter" | "lighter-rh", quote: string): VenueCodec {
  const S = VENUE_STATIC[venue];
  return {
    venue,
    capabilities: capabilities({
      testnet: S.wsUrl.testnet !== null,
      fields: {
        mark: true, index: true, bestBid: true, bestAsk: true, last: true, predictedRate: true,
        nextFundingTime: true, fundingInterval: true, openInterest: true, volume24hNotional: true,
      },
      notes: {
        rate: "WS funding is PERCENT per 1 h on the wire; emitted as a fraction per 1 h",
        nextFundingTime: "Hourly settlement rule (venue-definition)",
        openInterest: "USD notional (Phase 0), sides not stated by the venue",
        ...(S.wsUrl.testnet === null ? { "network:testnet": "Testnet WS answers HTTP 403 (CloudFront)" } : {}),
      },
    }),
    url: (n) => S.wsUrl[n],
    restUrl: (n) => S.restUrl[n],
    secretKeys: ["auth"],
    secretUrlPatterns: [],
    ping: S.ping,
    limits: S.limits,
    closesOnBadSubscribe: false,
    staleAfterMs: S.staleAfterMs,
    openInterest: { unit: "usd", sides: null },
    refresh: null,

    async loadDirectory(ctx) {
      const raw = await fetchJson(ctx.fetch, venue, `${ctx.restUrl}/api/v1/orderBooks`);
      if (!isObj(raw) || !Array.isArray(raw.order_books)) throw badShape(venue, "GET /api/v1/orderBooks has no order_books array");
      const entries: MarketDirectoryEntry[] = [];
      const idToSymbol = new Map<string, string>();
      const nonPerp = new Set<string>();
      for (const m of raw.order_books) {
        if (!isObj(m) || typeof m.symbol !== "string" || typeof m.market_id !== "number") {
          throw badShape(venue, "orderBooks entry without symbol/market_id");
        }
        const id = String(m.market_id);
        if (m.market_type !== "perp") { nonPerp.add(id); continue; }
        idToSymbol.set(id, m.symbol);
        entries.push({
          venue, dex: null, symbol: m.symbol, venueSymbol: m.symbol, base: m.symbol, quote,
          canonical: ctx.canonicalize(venue, { venueSymbol: m.symbol, dex: null, base: m.symbol, quote }),
          rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/api/v1/orderBooks",
        });
      }
      return { entries, data: { idToSymbol, nonPerp } satisfies LighterData };
    },

    fundingMeta: () => ({
      rateKind: "lastSettled", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
      intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
    }),

    wiresFor(_target, _dir, staleOverrideMs): WireSub[] {
      return [{ key: ALL, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { channel: ALL } }];
    },
    encodeSubscribe: (w) => JSON.stringify({ type: "subscribe", channel: w.params.channel }),
    encodeUnsubscribe: (w) => JSON.stringify({ type: "unsubscribe", channel: w.params.channel }),

    decode(text, dir, recvTs): DecodedEvent[] {
      const p = parseFrame(text);
      if (!p.ok) return [p.ev];
      const f = p.v;
      if (!isObj(f)) return [unrecognised(venue)];
      if (isObj(f.error)) return [decodeError(venue, f.error)];
      switch (f.type) {
        case "connected":
          return [{ t: "ignore", what: "connected" }];
        case "pong":
          return [{ t: "pong" }];
        case "unsubscribed":
          return [{ t: "ack", wire: channelToWire(f.channel), reqId: null, unsubscribe: true }];
        case "subscribed/market_stats":
        case "update/market_stats":
          if (f.channel !== "market_stats:all") return [unrecognised(venue)];
          return decodeStats(venue, f, dir.data as LighterData, recvTs);
        default:
          return [unrecognised(venue)];
      }
    },
  };
}

function channelToWire(ch: unknown): string | null {
  return typeof ch === "string" && ch === "market_stats:all" ? ALL : null;
}

function decodeError(venue: string, e: Obj): DecodedEvent {
  const code = typeof e.code === "number" ? e.code : null;
  const message = typeof e.message === "string" ? e.message : JSON.stringify(e);
  const wire = /market_stats[:/]all/.test(message) ? ALL : null;
  if (code === 20001) return venueError("WS_AUTH_FAILED", `${venue} error 20001: ${message}`, wire, wire !== null, "This channel needs an auth token (Phase 2)");
  if (code === 30005) return venueError("INVALID_PARAMS", `${venue} error 30005: ${message}`, wire, wire !== null, null);
  return protocolError(`${venue} error ${code === null ? "?" : code}: ${message}`, wire);
}

function decodeStats(venue: string, f: Obj, d: LighterData, recvTs: number): DecodedEvent[] {
  if (!isObj(f.market_stats)) return [protocolError(`${venue} ${ALL} frame without market_stats`, ALL)];
  const venueTs = typeof f.timestamp === "number" ? f.timestamp : null;
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  for (const [id, r] of Object.entries(f.market_stats)) {
    if (d.nonPerp.has(id)) continue; // spot market (not a perp)
    if (!isObj(r)) { badRows.push({ symbol: `#${id}`, fields: ["entry"] }); continue; }
    const known = d.idToSymbol.get(id);
    // Unknown id: emit under the frame's symbol so the stream reports it as "not in the directory".
    const symbol = known !== undefined ? known : typeof r.symbol === "string" ? r.symbol : `#${id}`;
    const bad: string[] = [];
    patches.push(compact({
      symbol,
      venueTs,
      mark: readDec(r, "mark_price", bad),
      index: readDec(r, "index_price", bad),
      bestBid: bookSide(r, "best_bid_price", bad),
      bestAsk: bookSide(r, "best_ask_price", bad),
      last: readDec(r, "last_trade_price", bad),
      rate: percentToFraction(r, "funding_rate", bad),
      predictedRate: percentToFraction(r, "current_funding_rate", bad),
      openInterest: readDec(r, "open_interest", bad),
      volume24hNotional: readDec(r, "daily_quote_token_volume", bad),
      nextFundingTime: nextHour(recvTs), // hourly settlement (venue-definition)
    }) as MarketPatch);
    if (bad.length > 0) badRows.push({ symbol, fields: bad });
  }
  const out: DecodedEvent[] = [{ t: "market", wire: ALL, patches }];
  if (badRows.length > 0) out.push(badFieldsError(venue, ALL, badRows));
  return out;
}

export const lighter: VenueCodec = makeLighter("lighter", "USDC");
/** Lighter RH: separate directory (different market ids); USDG collateral. */
export const lighterRh: VenueCodec = makeLighter("lighter-rh", "USDG");
