/**
 * Hyperliquid codec (§6.1). All markets = ONE `allDexsAssetCtxs` subscription (every dex), filtered
 * client-side by opts.hip3Dexes. Its ctx arrays are POSITIONAL (no coin): index i = meta{dex}.universe[i]
 * — the directory loads meta per selected dex and every frame is length-checked (mismatch →
 * WS_PROTOCOL_ERROR for that dex, never mis-assigned). kind:"market" uses `activeAssetCtx{coin}`.
 * An unknown coin in a subscribe makes HL drop the socket (no error frame) → coins are validated
 * against the directory before sending (closesOnBadSubscribe).
 *
 * Docs: hyperliquid.gitbook.io …/api/websocket/subscriptions; Phase 0 fixtures in
 * src/__tests__/fixtures/ws/hyperliquid/.
 */

import { badShape, fetchJson } from "../directory.js";
import { WsError } from "../errors.js";
import { VENUE_STATIC } from "../venue-static.js";
import type { CodecDirectory, DecodedEvent, MarketDirectoryEntry, MarketPatch, VenueCodec, WireSub } from "../types.js";
import {
  badFieldsError, capabilities, compact, isObj, nextHour, parseFrame, protocolError, readDec, unrecognised, type Obj,
} from "./common.js";

const S = VENUE_STATIC.hyperliquid;
const ALL = "allDexsAssetCtxs";
const PER_COIN_STALE_MS = 10_000;

interface HlDex {
  /** Universe names by position; null = delisted (not a market, skipped by documented rule). */
  names: Array<string | null>;
}
interface HlData {
  /** "" = native dex. Only the selected dexes. */
  dexes: Map<string, HlDex>;
}

function data(dir: CodecDirectory): HlData {
  return dir.data as HlData;
}

function universeOf(v: unknown, dex: string): Array<{ name: string; delisted: boolean }> & { collateralToken?: unknown } {
  if (!isObj(v) || !Array.isArray(v.universe)) throw badShape("hyperliquid", `meta${dex ? `{dex:${dex}}` : ""} has no universe array`);
  const out = v.universe.map((u: unknown) => {
    if (!isObj(u) || typeof u.name !== "string") throw badShape("hyperliquid", `meta${dex ? `{dex:${dex}}` : ""} universe entry has no name`);
    return { name: u.name, delisted: u.isDelisted === true };
  });
  return Object.assign(out, { collateralToken: v.collateralToken });
}

function patchFromCtx(symbol: string, ctx: Obj, recvTs: number, bad: string[]): MarketPatch {
  return compact({
    symbol,
    venueTs: null, // ctx frames carry no timestamp
    mark: readDec(ctx, "markPx", bad),
    index: readDec(ctx, "oraclePx", bad),
    rate: readDec(ctx, "funding", bad),
    openInterest: readDec(ctx, "openInterest", bad),
    volume24hNotional: readDec(ctx, "dayNtlVlm", bad),
    nextFundingTime: nextHour(recvTs), // hourly settlement (venue-definition)
  }) as MarketPatch;
}

function subscriptionKey(sub: unknown): string | null {
  if (!isObj(sub)) return null;
  if (sub.type === ALL) return ALL;
  if (sub.type === "activeAssetCtx" && typeof sub.coin === "string") return `activeAssetCtx:${sub.coin}`;
  return null;
}

export const hyperliquid: VenueCodec = {
  venue: "hyperliquid",
  capabilities: capabilities({
    testnet: true,
    fields: {
      mark: true, index: true, bestBid: false, bestAsk: false, last: false, predictedRate: false,
      nextFundingTime: true, fundingInterval: true, openInterest: true, volume24hNotional: true,
    },
    notes: {
      bestBid: "Not in asset ctxs; use the bbo channel (Phase 2)",
      bestAsk: "Not in asset ctxs; use the bbo channel (Phase 2)",
      last: "Not in asset ctxs",
      predictedRate: "HL publishes no predicted rate; `rate` (ctx.funding) is the accruing current-hour rate",
      nextFundingTime: "Hourly settlement rule (venue-definition)",
      openInterest: "Base units, one side",
    },
  }),
  url: (n) => S.wsUrl[n],
  restUrl: (n) => S.restUrl[n],
  secretKeys: [],
  secretUrlPatterns: [],
  ping: S.ping,
  limits: S.limits,
  closesOnBadSubscribe: true,
  staleAfterMs: S.staleAfterMs,
  openInterest: { unit: "base", sides: "one" },
  refresh: null,

  async loadDirectory(ctx) {
    const info = (body: Obj) => fetchJson(ctx.fetch, "hyperliquid", `${ctx.restUrl}/info`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let hip3: string[] = [];
    if (ctx.hip3Dexes === "all" || ctx.hip3Dexes.length > 0) {
      const raw = await info({ type: "perpDexs" });
      if (!Array.isArray(raw)) throw badShape("hyperliquid", "perpDexs is not an array");
      const names = raw.filter(isObj).map(d => d.name).filter((n): n is string => typeof n === "string");
      if (ctx.hip3Dexes === "all") hip3 = names;
      else {
        const unknown = ctx.hip3Dexes.filter(d => !names.includes(d));
        if (unknown.length > 0) {
          throw new WsError("INVALID_PARAMS", `hyperliquid: unknown HIP-3 dex(es) ${unknown.join(", ")}`, {
            exchange: "hyperliquid", remediation: `Known dexes: ${names.join(", ")}`,
          });
        }
        hip3 = ctx.hip3Dexes.slice();
      }
    }
    const [spot, ...metas] = await Promise.all([
      info({ type: "spotMeta" }),
      info({ type: "meta" }),
      ...hip3.map(dex => info({ type: "meta", dex })),
    ]);
    const tokens = new Map<number, string>();
    if (isObj(spot) && Array.isArray(spot.tokens)) {
      for (const t of spot.tokens) if (isObj(t) && typeof t.index === "number" && typeof t.name === "string") tokens.set(t.index, t.name);
    }
    const dexes = new Map<string, HlDex>();
    const entries: MarketDirectoryEntry[] = [];
    ["", ...hip3].forEach((dex, i) => {
      const uni = universeOf(metas[i], dex);
      const ct = uni.collateralToken;
      const quoteName = typeof ct === "number" ? tokens.get(ct) : undefined;
      const quote = quoteName === undefined ? null : quoteName;
      dexes.set(dex, { names: uni.map(u => (u.delisted ? null : u.name)) });
      for (const u of uni) {
        if (u.delisted) continue;
        const base = dex === "" ? u.name : u.name.slice(u.name.indexOf(":") + 1);
        const d = dex === "" ? null : dex;
        entries.push({
          venue: "hyperliquid", dex: d, symbol: u.name, venueSymbol: u.name, base, quote,
          canonical: ctx.canonicalize("hyperliquid", { venueSymbol: u.name, dex: d, base, quote }),
          rateIntervalHours: 1, settlementIntervalHours: 1, source: "rest:/info",
        });
      }
    });
    return { entries, data: { dexes } satisfies HlData };
  },

  fundingMeta: () => ({
    rateKind: "accruing", rateSource: "ws", rateIntervalHours: 1, settlementIntervalHours: 1,
    intervalSource: "venue-definition", intervalAsOf: null, marketClosed: null,
  }),

  wiresFor(target, _dir, staleOverrideMs): WireSub[] {
    if (target.kind === "allMarkets") {
      return [{ key: ALL, staleAfterMs: staleOverrideMs === null ? S.staleAfterMs : staleOverrideMs, params: { type: ALL } }];
    }
    return [{
      key: `activeAssetCtx:${target.symbol}`,
      staleAfterMs: staleOverrideMs === null ? PER_COIN_STALE_MS : staleOverrideMs,
      params: { type: "activeAssetCtx", coin: target.symbol },
    }];
  },
  encodeSubscribe: (w) => JSON.stringify({ method: "subscribe", subscription: w.params }),
  encodeUnsubscribe: (w) => JSON.stringify({ method: "unsubscribe", subscription: w.params }),

  decode(text, dir, recvTs): DecodedEvent[] {
    const p = parseFrame(text);
    if (!p.ok) return [p.ev];
    const f = p.v;
    if (!isObj(f) || typeof f.channel !== "string") return [unrecognised("hyperliquid")];
    switch (f.channel) {
      case "pong":
        return [{ t: "pong" }];
      case "subscriptionResponse": {
        if (!isObj(f.data)) return [unrecognised("hyperliquid")];
        return [{ t: "ack", wire: subscriptionKey(f.data.subscription), reqId: null, unsubscribe: f.data.method === "unsubscribe" }];
      }
      case "error": {
        const text = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
        // The error echoes the rejected request ("…request: {json}") → fatal for that channel.
        const wire = rejectedWire(text);
        return [{ t: "error", code: "WS_PROTOCOL_ERROR", message: `hyperliquid error: ${text}`, wire, fatal: wire !== null, remediation: null }];
      }
      case ALL:
        return decodeAll(f, data(dir), recvTs);
      case "activeAssetCtx": {
        if (!isObj(f.data) || typeof f.data.coin !== "string" || !isObj(f.data.ctx)) return [protocolError("hyperliquid activeAssetCtx frame without coin/ctx")];
        const wire = `activeAssetCtx:${f.data.coin}`;
        const bad: string[] = [];
        const out: DecodedEvent[] = [{ t: "market", wire, patches: [patchFromCtx(f.data.coin, f.data.ctx, recvTs, bad)] }];
        if (bad.length > 0) out.push(badFieldsError("hyperliquid", wire, [{ symbol: f.data.coin, fields: bad }]));
        return out;
      }
      default:
        return [unrecognised("hyperliquid")];
    }
  },
};

function rejectedWire(text: string): string | null {
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    const req = JSON.parse(text.slice(at)) as unknown;
    return isObj(req) && req.method === "subscribe" ? subscriptionKey(req.subscription) : null;
  } catch {
    return null;
  }
}

function decodeAll(f: Obj, d: HlData, recvTs: number): DecodedEvent[] {
  if (!isObj(f.data) || !Array.isArray(f.data.ctxs)) return [protocolError(`hyperliquid ${ALL} frame without data.ctxs`, ALL)];
  const out: DecodedEvent[] = [];
  const patches: MarketPatch[] = [];
  const badRows: Array<{ symbol: string; fields: string[] }> = [];
  const seen = new Set<string>();
  for (const pair of f.data.ctxs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !Array.isArray(pair[1])) {
      out.push(protocolError(`hyperliquid ${ALL}: malformed [dex, ctxs] entry`, ALL));
      continue;
    }
    const dex = pair[0];
    const sel = d.dexes.get(dex);
    if (sel === undefined) continue; // dex not selected by opts.hip3Dexes (client-side filter, by design)
    seen.add(dex);
    const ctxs = pair[1] as unknown[];
    if (ctxs.length !== sel.names.length) {
      out.push(protocolError(
        `hyperliquid ${ALL}: dex "${dex}" has ${ctxs.length} ctxs but the directory has ${sel.names.length} markets — not assigned (recreate the stream to reload meta)`,
        ALL,
      ));
      continue;
    }
    ctxs.forEach((ctx, i) => {
      const name = sel.names[i];
      if (name === null) return; // delisted (meta isDelisted) — not a market
      if (!isObj(ctx)) { badRows.push({ symbol: name, fields: ["ctx"] }); return; }
      const bad: string[] = [];
      patches.push(patchFromCtx(name, ctx, recvTs, bad));
      if (bad.length > 0) badRows.push({ symbol: name, fields: bad });
    });
  }
  for (const dex of d.dexes.keys()) {
    if (!seen.has(dex)) out.push(protocolError(`hyperliquid ${ALL}: selected dex "${dex}" missing from the frame`, ALL));
  }
  if (badRows.length > 0) out.push(badFieldsError("hyperliquid", ALL, badRows));
  return [{ t: "market", wire: ALL, patches }, ...out];
}
