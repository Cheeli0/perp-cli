/**
 * perp-cli/ws lifecycle regressions (Phase 1 review): overflow release, HL bad-subscribe attribution,
 * idle after the last channel drops, reconnect-attempt accounting, terminal subscribe, ack timeout and
 * venue error mapping, close during directory load, redaction coverage, comparator listener isolation,
 * iterator semantics, snapshot coalescing and malformed labelled-REST rows.
 * Imports only the public entry so the same tests can run against a built bundle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aster, createFundingComparator, createVenueStream, hyperliquid, pacifica } from "../../ws/index.js";
import type { MarketUpdate, StreamControl } from "../../ws/index.js";
import { ASTER_ROUTES, HL_ROUTES, PACIFICA_ROUTES, fakeFetch, fakeTransport, fixtureFrames, flush } from "./helpers.js";

const PRICES = fixtureFrames("pacifica", "prices")[0];
const HL_ACK_ALL = fixtureFrames("hyperliquid", "control")[0];
const hlAck = (coin: string) => ({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "activeAssetCtx", coin } } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_791_900_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("buffer overflow", () => {
  it("releases the wire (unsubscribe sent, stream idle) and settles a pending ready", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, buffer: { size: 2 } });
    const sub = stream.subscribe({ kind: "allMarkets" });
    sub[Symbol.asyncIterator]();
    await flush(30);
    t.last().open(); // queued controls: connecting, live (= buffer size)
    t.last().message("garbage"); // third control → overflow
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "STREAM_OVERFLOW" } });
    expect(t.last().sentJson().at(-1)).toEqual({ method: "unsubscribe", params: { source: "prices" } });
    expect(stream.state.status).toBe("idle");
    expect(sub.status).toBe("rejected");
  });
});

describe("hyperliquid bad-subscribe attribution", () => {
  it("a fast drop right after the resubscribe on reconnect keeps active subscriptions", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const all = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(HL_ACK_ALL);
    await all.ready;
    t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    t.last().open(); // resubscribe sent now
    t.last().serverClose(1006); // drops within the window
    expect(all.status).toBe("active");
    expect(stream.state.status).toBe("reconnecting");
  });

  it("a first-connect blip does not reject allMarkets", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const all = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().serverClose(1006);
    expect(all.status).toBe("pending");
    expect(stream.state.status).toBe("reconnecting");
  });

  it("two new unacked channels at the drop → ambiguous → ordinary reconnect, nobody rejected", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const all = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(HL_ACK_ALL);
    const a = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    const b = stream.subscribe({ kind: "market", symbol: "ETH", channels: ["market"] });
    await flush(30);
    t.last().serverClose(1006);
    expect([all.status, a.status, b.status]).toEqual(["active", "pending", "pending"]);
  });

  it("when the blamed subscription was the last channel, the stream goes idle and stops reconnecting", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const btc = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    await flush(30);
    t.last().open();
    t.last().message(hlAck("BTC"));
    await btc.ready;
    const eth = stream.subscribe({ kind: "market", symbol: "ETH", channels: ["market"] });
    await flush(30);
    await btc.unsubscribe();
    t.last().serverClose(1006);
    await expect(eth.ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(stream.state.status).toBe("idle");
    const sockets = t.sockets.length;
    vi.advanceTimersByTime(120_000);
    expect(t.sockets.length).toBe(sockets);
  });
});

describe("reconnect accounting and terminal state", () => {
  it("accept-then-drop venues still exhaust maxAttempts; a later subscribe rejects with the close reason", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, {
      transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, reconnect: { maxAttempts: 2, baseMs: 10, maxMs: 10 },
    });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    for (let i = 0; i < 3; i++) {
      t.last().open();
      t.last().serverClose(1006);
      vi.advanceTimersByTime(10);
    }
    expect(stream.state).toMatchObject({ status: "closed", reason: { code: "EXCHANGE_UNREACHABLE" } });
    expect(t.sockets).toHaveLength(3);
    expect(sub.status).toBe("rejected");
    const late = stream.subscribe({ kind: "allMarkets" });
    await expect(late.ready).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
  });

  it("a data frame resets the attempt count", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, {
      transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, reconnect: { maxAttempts: 1, baseMs: 10, maxMs: 10 },
    });
    stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    for (let i = 0; i < 4; i++) {
      t.last().open();
      t.last().message(PRICES);
      t.last().serverClose(1006);
      vi.advanceTimersByTime(10);
    }
    expect(stream.state.status).toBe("connecting");
  });
});

describe("acknowledgement", () => {
  it("no ack and no data within staleAfterMs → pending subscription fails with WS_PROTOCOL_ERROR", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    vi.advanceTimersByTime(10_001);
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "WS_PROTOCOL_ERROR" } });
  });

  it("aster {error, id} fails the subscription that request belongs to", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(aster, { transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    const id = (t.last().sentJson()[0] as { id: number }).id;
    t.last().message({ error: { code: 2, msg: "Invalid request" }, id });
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "WS_PROTOCOL_ERROR" } });
  });

  it("a hyperliquid error frame echoing our subscribe fails that subscription", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    await flush(30);
    t.last().open();
    t.last().message({ channel: "error", data: `Error parsing JSON into valid websocket request: ${t.last().sent[0]}` });
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "WS_PROTOCOL_ERROR" } });
  });
});

describe("close during directory load", () => {
  it("no labelled-REST refresh timer is started after close()", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const inner = fakeFetch(ASTER_ROUTES);
    const fetch = (async (url: string, init?: { method?: string; body?: string }) => { await gate; return inner(url, init); }) as typeof inner;
    const t = fakeTransport();
    const stream = createVenueStream(aster, { transport: t.factory, fetch, visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await stream.close();
    release();
    await flush(30);
    expect(vi.getTimerCount()).toBe(0); // no interval left behind
    const calls = inner.calls.length;
    vi.advanceTimersByTime(3 * 3_600_000);
    await flush(30);
    expect(inner.calls.length).toBe(calls);
    expect(t.sockets).toHaveLength(0);
    expect(sub.status === "closed" || sub.status === "rejected").toBe(true);
  });
});

describe("redaction coverage", () => {
  it.each([
    ['token: "SECRET1"', "SECRET1"],
    ["signature='SECRET2'", "SECRET2"],
    ['{"auth":["SECRET3"]}', "SECRET3"],
    ['{"auth":{"t":"SECRET4"}}', "SECRET4"],
    ["Authorization: Bearer SECRET5", "SECRET5"],
    ['{"api-key":"SECRET6"}', "SECRET6"],
    ["x-api-key=SECRET7", "SECRET7"],
    ["wss://x/stream?a=1&listenKey%3DSECRET8", "SECRET8"],
    ["secret = SECRET9", "SECRET9"],
  ])("%s", async (frame, secret) => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const ev: unknown[] = [];
    stream.subscribe({ kind: "allMarkets" }).on(e => ev.push(e));
    await flush(30);
    t.last().open();
    t.last().message(frame);
    t.last().message({ channel: "surprise", data: frame });
    const errors = ev.filter(e => (e as StreamControl).type === "error");
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(ev)).not.toContain(secret);
  });
});

describe("funding comparator listeners", () => {
  it("a throwing listener does not skip the others and is reported via onControl", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const reported: unknown[] = [];
    const c = createFundingComparator({ streams: [stream], minVenues: 1, onControl: e => reported.push(e) });
    let second = 0;
    c.subscribe(() => { throw new Error("boom"); });
    c.subscribe(() => { second++; });
    await flush(30);
    t.last().open();
    t.last().message(PRICES);
    await flush(5);
    expect(second).toBe(1);
    expect(reported).toContainEqual({ type: "listener-error", message: expect.stringContaining("boom") });
  });
});

describe("iterator", () => {
  it("events before the iterator is created are buffered; for-await…break unsubscribes and clears", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(PRICES);
    const seen: string[] = [];
    for await (const e of sub) {
      seen.push(e.type);
      if (e.type === "market") break;
    }
    expect(seen).toEqual(["state", "state", "market"]);
    expect(sub.status).toBe("closed");
    expect(t.last().sentJson().at(-1)).toEqual({ method: "unsubscribe", params: { source: "prices" } });
    const it2 = sub[Symbol.asyncIterator]();
    expect(await it2.next()).toEqual({ value: undefined, done: true });
  });

  it("a coalesced row that contained a snapshot stays a snapshot", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const sub = stream.subscribe({ kind: "allMarkets" });
    const it = sub[Symbol.asyncIterator]();
    await flush(30);
    t.last().open();
    t.last().message(PRICES); // snapshot
    t.last().message(PRICES); // ws, coalesced into the same rows
    const rows: MarketUpdate[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await it.next();
      if ((r.value as MarketUpdate).type === "market") rows.push(r.value as MarketUpdate);
    }
    expect(rows.length).toBe(4);
    expect(rows.every(r => r.source === "snapshot")).toBe(true);
  });
});

describe("aster labelled REST", () => {
  it("malformed fundingInfo rows are reported (count + error event), not dropped silently", async () => {
    const routes = {
      ...ASTER_ROUTES,
      "GET https://fapi.asterdex.com/fapi/v3/fundingInfo": [
        { symbol: "BTCUSDT", fundingIntervalHours: 8 }, { symbol: "ETHUSDT", fundingIntervalHours: "8" }, { nope: 1 },
      ],
    };
    const t = fakeTransport();
    const stream = createVenueStream(aster, { transport: t.factory, fetch: fakeFetch(routes), visibility: null });
    const ev: StreamControl[] = [];
    stream.subscribe({ kind: "allMarkets" }).on(e => { if (e.type === "error") ev.push(e); });
    await flush(30);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ code: "EXCHANGE_ERROR", fatal: false });
    expect(ev[0].type === "error" && ev[0].message).toMatch(/2 malformed row\(s\) \(ETHUSDT, \?\)/);
  });
});

describe("ack timers across reconnects", () => {
  it("pending sub → drop before ack → reconnect delay > staleAfterMs → still pending; resolves when a later socket acks", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(aster, {
      transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null, staleAfterMs: 400,
      reconnect: { maxAttempts: null, baseMs: 100, maxMs: 2000 },
    });
    const sub = stream.subscribe({ kind: "allMarkets" });
    const errors: StreamControl[] = [];
    sub.on(e => { if (e.type === "error") errors.push(e); });
    await flush(30);
    t.last().open(); // subscribes sent, ack timers armed (400 ms)
    t.last().serverClose(1006); // outage before any ack
    for (let i = 0; i < 6; i++) { // handshakes keep failing; backoff grows past 400 ms
      vi.advanceTimersByTime(2_000);
      t.last().serverClose(1006);
    }
    vi.advanceTimersByTime(5_000);
    expect(sub.status).toBe("pending");
    expect(errors).toEqual([]);
    expect(stream.state.status).toBe("connecting");
    t.last().open();
    for (const m of t.last().sentJson() as Array<{ id: number }>) t.last().message({ id: m.id, result: null });
    await expect(sub.ready).resolves.toBeUndefined();
  });
});

describe("hyperliquid ambiguous drop isolation", () => {
  it("two new channels dropped together are re-probed one at a time; the bad one is blamed next time", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const all = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(HL_ACK_ALL);
    const btc = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    const eth = stream.subscribe({ kind: "market", symbol: "ETH", channels: ["market"] });
    await flush(30);
    t.last().serverClose(1006); // ambiguous: two new unacked channels
    vi.advanceTimersByTime(1_000);
    t.last().open();
    const coins = () => (t.last().sentJson() as Array<{ subscription: { type: string; coin?: string } }>).map(m => m.subscription.coin ?? m.subscription.type);
    expect(coins()).toEqual(["allDexsAssetCtxs", "BTC"]); // only one suspect in flight
    t.last().message(HL_ACK_ALL);
    t.last().message(hlAck("BTC"));
    expect(coins()).toEqual(["allDexsAssetCtxs", "BTC", "ETH"]); // next suspect after the first acked
    t.last().serverClose(1006); // the venue drops on ETH
    await expect(eth.ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect([all.status, btc.status]).toEqual(["active", "active"]);
    expect(stream.state.status).toBe("reconnecting");
  });
});

describe("subscription held without a consumer", () => {
  it("a flapping connection never overflows it; the iterator then reports the discarded count first", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, {
      transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, buffer: { size: 3 },
      reconnect: { maxAttempts: null, baseMs: 10, maxMs: 10 },
    });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    for (let i = 0; i < 20; i++) { t.last().serverClose(1006); vi.advanceTimersByTime(10); } // 40+ state events
    expect(sub.status).toBe("pending");
    const it = sub[Symbol.asyncIterator]();
    const first = (await it.next()).value as StreamControl;
    expect(first).toMatchObject({ type: "error", code: "STREAM_OVERFLOW", fatal: false });
    const rest: StreamControl[] = [];
    for (let i = 0; i < 2; i++) rest.push((await it.next()).value as StreamControl);
    expect(rest.map(e => e.type)).toEqual(["state", "state"]);
    expect(sub.status).toBe("pending");
  });
});

describe("suspect probing continues when the probe goes away", () => {
  async function ambiguous() {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const all = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(HL_ACK_ALL);
    const btc = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    const eth = stream.subscribe({ kind: "market", symbol: "ETH", channels: ["market"] });
    await flush(30);
    t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    t.last().open();
    t.last().message(HL_ACK_ALL);
    const coins = () => (t.last().sentJson() as Array<{ method: string; subscription: { type: string; coin?: string } }>)
      .filter(m => m.method === "subscribe").map(m => m.subscription.coin ?? m.subscription.type);
    expect(coins()).toEqual(["allDexsAssetCtxs", "BTC"]);
    return { t, all, btc, eth, coins };
  }

  it("unsubscribing the in-flight probe sends the next suspect", async () => {
    const { btc, coins } = await ambiguous();
    await btc.unsubscribe();
    expect(coins()).toEqual(["allDexsAssetCtxs", "BTC", "ETH"]);
  });

  it("an ack-timeout drop of the probe sends the next suspect", async () => {
    const { btc, coins } = await ambiguous();
    vi.advanceTimersByTime(10_001); // per-coin staleAfterMs 10 s
    await expect(btc.ready).rejects.toMatchObject({ structured: { code: "WS_PROTOCOL_ERROR" } });
    expect(coins()).toEqual(["allDexsAssetCtxs", "BTC", "ETH"]);
  });

  it("a fatal error frame for the probe sends the next suspect", async () => {
    const { t, btc, coins } = await ambiguous();
    const req = t.last().sent.find(m => m.includes("\"BTC\""))!;
    t.last().message({ channel: "error", data: `Error parsing JSON into valid websocket request: ${req}` });
    await expect(btc.ready).rejects.toMatchObject({ structured: { code: "WS_PROTOCOL_ERROR" } });
    expect(coins()).toEqual(["allDexsAssetCtxs", "BTC", "ETH"]);
  });
});

describe("options validation", () => {
  it.each([0, -1, 1.5, Number.NaN])("buffer.size %s → INVALID_PARAMS", (size) => {
    const t = fakeTransport();
    expect(() => createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, buffer: { size } }))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});
