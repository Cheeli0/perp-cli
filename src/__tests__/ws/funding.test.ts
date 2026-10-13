/** perp-cli/ws funding comparator, toHourly/toApr, defaultCanonicalize and the exact decimal shift. */
import { describe, expect, it } from "vitest";
import { createFundingComparator, toApr, toHourly } from "../../ws/funding.js";
import { defaultCanonicalize } from "../../ws/canonical.js";
import { mulDecimalInt, shiftDecimal, toDec } from "../../ws/dec.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { pacifica } from "../../ws/codecs/pacifica.js";
import { lighter } from "../../ws/codecs/lighter.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";
import type {
  ConnectionState, MarketDirectoryEntry, MarketUpdate, RateKind, StreamControl, VenueCodec, VenueId, VenueStream,
} from "../../ws/types.js";

const NOW = 1_000_000;

function fakeStream(codec: VenueCodec, entries: Array<Partial<MarketDirectoryEntry> & { symbol: string; base: string }>) {
  const cbs = new Set<(e: MarketUpdate | StreamControl) => void>();
  const cb = { emit: (e: MarketUpdate | StreamControl) => { for (const f of cbs) f(e); } };
  let state: ConnectionState = { status: "live", since: 0, sockets: 1 };
  const dir: MarketDirectoryEntry[] = entries.map(e => ({
    venue: codec.venue, dex: null, venueSymbol: e.symbol, quote: "USD", canonical: null, rateIntervalHours: 1,
    settlementIntervalHours: 1, source: "rest:/x", ...e,
  }));
  const stream = {
    venue: codec.venue, network: "mainnet", capabilities: codec.capabilities, staleAfterMs: codec.staleAfterMs,
    get state() { return state; },
    subscribe: () => ({ on: (f: (e: MarketUpdate | StreamControl) => void) => { cbs.add(f); return () => undefined; }, unsubscribe: async () => undefined, ready: Promise.resolve(), status: "active" }),
    onState: () => () => undefined,
    markets: async () => dir,
    close: async () => undefined,
  } as unknown as VenueStream;
  return {
    stream,
    setState(s: ConnectionState) { state = s; cb.emit({ type: "state", venue: codec.venue, state: s }); },
    push(symbol: string, f: { rate: string | null; kind: RateKind | null; predicted?: string | null; interval?: number | null; asOf?: number; canonical?: string | null; quote?: string | null }) {
      const e = dir.find(d => d.symbol === symbol)!;
      const asOf = f.asOf ?? NOW;
      const u: MarketUpdate = {
        type: "market", schema: 1, venue: codec.venue as VenueId, dex: e.dex, symbol, venueSymbol: symbol,
        quote: f.quote === undefined ? e.quote : f.quote,
        canonical: f.canonical === undefined ? defaultCanonicalize(codec.venue, { venueSymbol: symbol, dex: e.dex, base: e.base, quote: e.quote }) : f.canonical,
        mark: "1", index: null, bestBid: null, bestAsk: null, last: null,
        funding: {
          rate: f.rate, rateKind: f.kind, rateSource: "ws", rateIntervalHours: f.interval === undefined ? 1 : f.interval,
          settlementIntervalHours: 1, intervalSource: "venue-definition", nextFundingTime: null,
          predictedRate: f.predicted === undefined ? null : f.predicted, marketClosed: null,
        },
        openInterest: { value: null, unit: null, sides: null }, volume24hNotional: null, venueTs: null, recvTs: asOf, source: "ws",
        changed: [], asOf: { rate: asOf, ...(f.predicted !== undefined ? { predictedRate: asOf } : {}) },
      };
      cb.emit(u);
    },
  };
}

async function setup() {
  const hl = fakeStream(hyperliquid, [{ symbol: "BTC", base: "BTC", quote: "USDC" }, { symbol: "xyz:TSLA", base: "TSLA", dex: "xyz" }]);
  const pac = fakeStream(pacifica, [{ symbol: "BTC", base: "BTC", quote: "USDC" }, { symbol: "TSLA", base: "TSLA", quote: "USDC" }]);
  const lit = fakeStream(lighter, [{ symbol: "BTC", base: "BTC", quote: "USDC" }]);
  const ast = fakeStream(aster, [{ symbol: "BTCUSDT", base: "BTC", quote: "USDT" }, { symbol: "BTCUSD1", base: "BTC", quote: "USD1" }, { symbol: "BTCEUR", base: "BTC", quote: "EUR" }]);
  const arc = fakeStream(arcus, [{ symbol: "BTC-USD", base: "BTC", quote: "USD" }]);
  const feed = () => {
  hl.push("BTC", { rate: "0.00001", kind: "accruing" });
  pac.push("BTC", { rate: "0.000004", kind: "lastSettled", predicted: "0.000003" });
  lit.push("BTC", { rate: "-0.000001", kind: "lastSettled", predicted: "0.000002" });
  ast.push("BTCUSDT", { rate: "0.00008", kind: "accruing", interval: 8 });
  ast.push("BTCUSD1", { rate: "0.00006", kind: "accruing", interval: 8 });
  ast.push("BTCEUR", { rate: "0.1", kind: "accruing", interval: 8 });
  arc.push("BTC-USD", { rate: "0.0000125", kind: "lastSettled", predicted: "0.000011" });
  };
  return { hl, pac, lit, ast, arc, feed, streams: [hl, pac, lit, ast, arc].map(s => s.stream) };
}

const leg = (rows: ReturnType<ReturnType<typeof createFundingComparator>["rows"]>, c: string, venue: string, symbol?: string) =>
  rows.find(r => r.canonical === c)!.legs.find(l => l.venue === venue && (symbol === undefined || l.symbol === symbol))!;

describe("createFundingComparator", () => {
  it('default "current": each leg\'s rate; mixed kinds flagged; non-USD quote not merged', async () => {
    const s = await setup();
    const c = createFundingComparator({ streams: s.streams, clock: () => NOW });
    s.feed();
    const rows = c.rows();
    const btc = rows.find(r => r.canonical === "BTC")!;
    expect(btc.mixedKinds).toBe(true);
    expect(btc.legs.map(l => `${l.venue}:${l.symbol}`)).toEqual([
      "arcus:BTC-USD", "aster:BTCUSD1", "aster:BTCUSDT", "hyperliquid:BTC", "lighter:BTC", "pacifica:BTC",
    ]);
    expect(leg(rows, "BTC", "lighter")).toMatchObject({ rate: "-0.000001", rateKind: "lastSettled", kindUnavailable: false, fundingVerified: true, stale: false });
    expect(btc.legs.some(l => l.symbol === "BTCEUR")).toBe(false);
    c.close();
  });

  it('"next": accruing when published, else predicted; lastSettled-only venues flagged, not substituted', async () => {
    const s = await setup();
    const cn = createFundingComparator({ streams: s.streams, kind: "next", clock: () => NOW });
    s.feed();
    const rows = cn.rows();
    expect(leg(rows, "BTC", "hyperliquid")).toMatchObject({ rate: "0.00001", rateKind: "accruing" });
    expect(leg(rows, "BTC", "aster", "BTCUSDT")).toMatchObject({ rate: "0.00008", rateKind: "accruing" });
    expect(leg(rows, "BTC", "pacifica")).toMatchObject({ rate: "0.000003", rateKind: "predicted" });
    expect(leg(rows, "BTC", "lighter")).toMatchObject({ rate: "0.000002", rateKind: "predicted" });
    expect(leg(rows, "BTC", "arcus")).toMatchObject({ rate: "0.000011", rateKind: "predicted" });
    // a venue that publishes only lastSettled (no accruing, no predicted) → flagged, rate null
    const only = fakeStream({ ...pacifica, capabilities: { ...pacifica.capabilities, fields: { ...pacifica.capabilities.fields, predictedRate: false } } }, [{ symbol: "BTC", base: "BTC", quote: "USDC" }]);
    const c2 = createFundingComparator({ streams: [s.hl.stream, only.stream], kind: "next", clock: () => NOW });
    only.push("BTC", { rate: "0.000004", kind: "lastSettled" });
    s.hl.push("BTC", { rate: "0.00001", kind: "accruing" });
    expect(c2.rows()).toEqual([]); // minVenues 2 counts only legs with a rate
    const c3 = createFundingComparator({ streams: [s.hl.stream, only.stream], kind: "next", minVenues: 1, clock: () => NOW });
    only.push("BTC", { rate: "0.000004", kind: "lastSettled" });
    s.hl.push("BTC", { rate: "0.00001", kind: "accruing" });
    const r3 = c3.rows();
    expect(leg(r3, "BTC", "pacifica")).toMatchObject({ rate: null, rateKind: null, kindUnavailable: true });
  });

  it('"lastSettled" / "accruing" / "predicted": a leg without that kind has rate null', async () => {
    const s = await setup();
    const cs = createFundingComparator({ streams: s.streams, kind: "lastSettled", clock: () => NOW });
    const ca = createFundingComparator({ streams: s.streams, kind: "accruing", clock: () => NOW });
    const cp = createFundingComparator({ streams: s.streams, kind: "predicted", clock: () => NOW });
    s.feed();
    const settled = cs.rows();
    expect(leg(settled, "BTC", "hyperliquid")).toMatchObject({ rate: null, kindUnavailable: true });
    expect(leg(settled, "BTC", "pacifica")).toMatchObject({ rate: "0.000004", rateKind: "lastSettled" });
    expect(settled.find(r => r.canonical === "BTC")!.mixedKinds).toBe(false);
    const acc = ca.rows();
    expect(leg(acc, "BTC", "arcus")).toMatchObject({ rate: null, kindUnavailable: true });
    const pred = cp.rows();
    expect(leg(pred, "BTC", "hyperliquid")).toMatchObject({ rate: null, kindUnavailable: true });
    expect(leg(pred, "BTC", "lighter")).toMatchObject({ rate: "0.000002", rateKind: "predicted" });
  });

  it("stale: stream not live, or now − asOf > 2 × venue staleAfterMs (Arcus 3×), or an explicit threshold", async () => {
    const s = await setup();
    const c1 = createFundingComparator({ streams: s.streams, clock: () => NOW });
    const c2 = createFundingComparator({ streams: s.streams, clock: () => NOW, staleAfterMs: 1_000 });
    s.feed();
    s.hl.push("BTC", { rate: "0.00001", kind: "accruing", asOf: NOW - 61_000 }); // HL 30 s × 2
    s.arc.push("BTC-USD", { rate: "0.0000125", kind: "lastSettled", asOf: NOW - 44_000 }); // Arcus 15 s × 3 = 45 s
    s.pac.setState({ status: "stale", since: 0, silentMs: 11_000, channel: "prices" });
    let rows = c1.rows();
    expect(leg(rows, "BTC", "hyperliquid").stale).toBe(true);
    expect(leg(rows, "BTC", "arcus").stale).toBe(false);
    expect(leg(rows, "BTC", "pacifica").stale).toBe(true);
    expect(leg(rows, "BTC", "lighter").stale).toBe(false);
    rows = c2.rows();
    expect(leg(rows, "BTC", "arcus").stale).toBe(true);
  });

  it("custom canonicalize and include are honoured; subscribe notifies with changed canonicals", async () => {
    const s = await setup();
    const c = createFundingComparator({
      streams: s.streams, clock: () => NOW, minVenues: 1, include: ["btc-any"],
      canonicalize: (_v, m) => (m.base === "BTC" ? "btc-any" : null),
    });
    s.feed();
    await Promise.resolve();
    await Promise.resolve();
    const seen: string[][] = [];
    c.subscribe((_rows, changed) => seen.push(changed));
    s.hl.push("BTC", { rate: "0.00002", kind: "accruing" });
    await Promise.resolve();
    expect(seen).toEqual([["btc-any"]]);
    const rows = c.rows();
    expect(rows.map(r => r.canonical)).toEqual(["btc-any"]);
    expect(rows[0].legs.some(l => l.symbol === "BTCEUR")).toBe(true); // custom canonicalize merges it
  });
});

describe("toHourly / toApr", () => {
  it("normalize by the rate interval; null in → null out", () => {
    expect(toHourly("0.00008", 8)).toBeCloseTo(0.00001, 12);
    expect(toApr("0.00001", 1)).toBeCloseTo(0.0876, 10);
    expect(toApr(null, 1)).toBeNull();
    expect(toApr("0.1", null)).toBeNull();
    expect(toHourly("0.1", 0)).toBeNull();
  });
});

describe("defaultCanonicalize", () => {
  it("HIP-3 → <dex>:<BASE>; USD-like quotes collapse; other / unknown quotes → null", () => {
    expect(defaultCanonicalize("hyperliquid", { venueSymbol: "xyz:TSLA", dex: "xyz", base: "TSLA", quote: "USDC" })).toBe("xyz:TSLA");
    expect(defaultCanonicalize("aster", { venueSymbol: "BTCUSDT", dex: null, base: "BTC", quote: "USDT" })).toBe("BTC");
    expect(defaultCanonicalize("aster", { venueSymbol: "BTCUSD1", dex: null, base: "BTC", quote: "USD1" })).toBe("BTC");
    expect(defaultCanonicalize("lighter-rh", { venueSymbol: "BTC", dex: null, base: "BTC", quote: "USDG" })).toBe("BTC");
    expect(defaultCanonicalize("aster", { venueSymbol: "BTCEUR", dex: null, base: "BTC", quote: "EUR" })).toBeNull();
    expect(defaultCanonicalize("aster", { venueSymbol: "X", dex: null, base: "X", quote: null })).toBeNull();
  });
});

describe("Dec helpers", () => {
  it("shiftDecimal is exact (percent → fraction)", () => {
    expect(shiftDecimal("0.0002", -2)).toBe("0.000002");
    expect(shiftDecimal("-0.0001", -2)).toBe("-0.000001");
    expect(shiftDecimal("0.0629", -2)).toBe("0.000629");
    expect(shiftDecimal("12.5", -2)).toBe("0.125");
    expect(shiftDecimal("0.0000", -2)).toBe("0");
    expect(shiftDecimal("1e-7", -2)).toBe("0.000000001");
    expect(shiftDecimal("150", -2)).toBe("1.5");
    expect(shiftDecimal("abc", -2)).toBeUndefined();
  });
  it("mulDecimalInt is exact", () => {
    expect(mulDecimalInt("291.492488", 196, -6)).toBe("0.057132527648");
    expect(mulDecimalInt("291.492488", 0, -6)).toBe("0");
    expect(mulDecimalInt("-1.5", 3, 0)).toBe("-4.5");
    expect(mulDecimalInt("100", 10000, -6)).toBe("1");
    expect(mulDecimalInt("1e3", 1, 0)).toBeUndefined();
    expect(mulDecimalInt("1", 1.5, 0)).toBeUndefined();
  });
  it("toDec keeps strings verbatim, numbers via String, rejects garbage", () => {
    expect(toDec("0.10")).toBe("0.10");
    expect(toDec(1.5)).toBe("1.5");
    expect(toDec(null)).toBeNull();
    expect(toDec("")).toBeUndefined();
    expect(toDec({})).toBeUndefined();
    expect(toDec(Number.NaN)).toBeUndefined();
  });
});
