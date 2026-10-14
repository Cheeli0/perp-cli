/**
 * kind:"allMarkets" with `canonicals` (blind dogfood round 3): one subscription works across venues
 * whose directory symbols differ (aster BTCUSDT / BTCUSD1, arcus BTC-USD, lighter-rh USDG, HIP-3
 * "<dex>:<BASE>"). Unknown canonicals and mixed filters reject INVALID_PARAMS before anything is sent.
 */
import { describe, expect, it } from "vitest";
import { createVenueStream } from "../../ws/stream.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { lighterRh } from "../../ws/codecs/lighter.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";
import type { AllMarketsTarget, MarketUpdate, StreamControl, VenueCodec, VenueStreamOptions } from "../../ws/types.js";
import type { WsError } from "../../ws/errors.js";
import { ARCUS_ROUTES, ASTER_ROUTES, HL_ROUTES, LIGHTER_RH_ROUTES, fakeFetch, fakeTransport, fixtureFrames, flush } from "./helpers.js";

async function run(codec: VenueCodec, routes: Record<string, unknown>, frames: unknown[], target: AllMarketsTarget, opts: VenueStreamOptions = {}) {
  const t = fakeTransport();
  const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, ...opts });
  const sub = stream.subscribe(target);
  const events: Array<MarketUpdate | StreamControl> = [];
  sub.on(e => events.push(e as MarketUpdate | StreamControl));
  await flush(30);
  const ws = t.last();
  ws.open();
  for (const f of frames) ws.message(f);
  const symbols = new Set(events.filter((e): e is MarketUpdate => e.type === "market").map(m => m.symbol));
  const errors = events.filter(e => e.type === "error");
  return { stream, sub, t, symbols, errors };
}

const ASTER_FRAMES = [{ id: 1, result: null }, { id: 2, result: null }, ...fixtureFrames("aster", "markPrice-arr"), ...fixtureFrames("aster", "ticker-arr")];

describe("allMarkets canonicals", () => {
  it("aster: BTC → every quote (BTCUSDT + BTCUSD1), no other market", async () => {
    const r = await run(aster, ASTER_ROUTES, ASTER_FRAMES, { kind: "allMarkets", canonicals: ["BTC"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTCUSDT", "BTCUSD1"]));
  });

  it("arcus: BTC → BTC-USD", async () => {
    const control = fixtureFrames("arcus", "control");
    const r = await run(arcus, ARCUS_ROUTES, [control[0], ...fixtureFrames("arcus", "markets"), control[1]], { kind: "allMarkets", canonicals: ["BTC", "ETH"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTC-USD", "ETH-USD"]));
  });

  it("lighter-rh: USDG quote collapses → BTC", async () => {
    const r = await run(lighterRh, LIGHTER_RH_ROUTES, fixtureFrames("lighter-rh", "market_stats-all"), { kind: "allMarkets", canonicals: ["BTC"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTC"]));
  });

  it("hyperliquid: native BTC and HIP-3 \"xyz:TSLA\" (dex prefix rule; BTC does not pull in HIP-3 markets)", async () => {
    const r = await run(hyperliquid, HL_ROUTES, fixtureFrames("hyperliquid", "allDexsAssetCtxs"),
      { kind: "allMarkets", canonicals: ["BTC", "xyz:TSLA"] }, { hip3Dexes: ["xyz"] });
    expect(r.errors).toEqual([]);
    expect(r.symbols).toEqual(new Set(["BTC", "xyz:TSLA"]));
  });

  it("same wire subscription as a plain allMarkets (ref-counted, one subscribe sent)", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(aster, { transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null });
    stream.subscribe({ kind: "allMarkets" });
    stream.subscribe({ kind: "allMarkets", canonicals: ["BTC"] });
    await flush(30);
    t.last().open();
    expect(t.sockets).toHaveLength(1);
    expect(t.last().sentJson()).toEqual([
      { method: "SUBSCRIBE", params: ["!markPrice@arr@1s"], id: 1 },
      { method: "SUBSCRIBE", params: ["!ticker@arr"], id: 2 },
    ]);
  });
});

describe("allMarkets canonicals: errors", () => {
  async function reject(codec: VenueCodec, routes: Record<string, unknown>, target: AllMarketsTarget, opts: VenueStreamOptions = {}) {
    const t = fakeTransport();
    const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, ...opts });
    const err = await stream.subscribe(target).ready.then(() => null, (e: unknown) => e as WsError);
    return { err, t };
  }

  it("an unknown canonical → INVALID_PARAMS before anything is sent", async () => {
    const { err, t } = await reject(arcus, ARCUS_ROUTES, { kind: "allMarkets", canonicals: ["BTC", "DOGE"] });
    expect(err?.structured).toMatchObject({ code: "INVALID_PARAMS", message: "arcus: no market with canonical(s) DOGE" });
    expect(t.sockets).toHaveLength(0);
  });

  it.each([
    ["case", aster, ASTER_ROUTES, "btc", ["BTC"], {}],
    ["HIP-3 base without the dex prefix", hyperliquid, HL_ROUTES, "TSLA", ["xyz:TSLA"], { hip3Dexes: ["xyz"] }],
  ] as Array<[string, VenueCodec, Record<string, unknown>, string, string[], VenueStreamOptions]>)("%s → did-you-mean suggestions", async (_n, codec, routes, c, want, opts) => {
    const { err } = await reject(codec, routes, { kind: "allMarkets", canonicals: [c] }, opts);
    expect(err?.structured.code).toBe("INVALID_PARAMS");
    expect(err?.message).toContain(`did you mean ${want.join(" / ")} for ${c}`);
    expect(err?.structured.details).toEqual({ suggestions: { [c]: want } });
  });

  it.each([
    ["symbols and canonicals together", { kind: "allMarkets", symbols: ["BTCUSDT"], canonicals: ["BTC"] }, "not both"],
    ["empty canonicals", { kind: "allMarkets", canonicals: [] }, "non-empty array"],
    ["canonicals not strings", { kind: "allMarkets", canonicals: [1] }, "non-empty array"],
  ])("%s → INVALID_PARAMS", async (_n, target, text) => {
    const { err, t } = await reject(aster, ASTER_ROUTES, target as AllMarketsTarget);
    expect(err?.structured.code).toBe("INVALID_PARAMS");
    expect(err?.message).toContain(text);
    expect(t.sockets).toHaveLength(0);
  });
});
