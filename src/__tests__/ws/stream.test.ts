/**
 * perp-cli/ws connection core + stream (plan ws-0.14.4 Phase 1): state machine with fake timers,
 * staleness from message timestamps, visibility re-evaluation, backoff + new-connection budget,
 * resubscribe with snapshot re-emit, ref-counted wire subs, budgets, redaction, buffering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVenueStream } from "../../ws/stream.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { pacifica } from "../../ws/codecs/pacifica.js";
import { aster } from "../../ws/codecs/aster.js";
import { HANDSHAKE_REMEDIATION } from "../../ws/connection.js";
import type { ConnectionState, MarketUpdate, StreamControl, StreamLog } from "../../ws/types.js";
import { ASTER_ROUTES, HL_ROUTES, PACIFICA_ROUTES, fakeFetch, fakeTransport, fixtureFrames, flush } from "./helpers.js";

const PRICES = fixtureFrames("pacifica", "prices")[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_791_900_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("state machine", () => {
  it("connecting → live → stale (message timestamps) → reconnecting → live (resubscribed, snapshot) → closed", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const states: ConnectionState[] = [];
    stream.onState(s => states.push(s));
    const ev: Array<MarketUpdate | StreamControl> = [];
    stream.subscribe({ kind: "allMarkets" }).on(e => ev.push(e as MarketUpdate | StreamControl));
    await flush(30);
    expect(stream.state.status).toBe("connecting");
    t.last().open();
    expect(stream.state.status).toBe("live");
    t.last().message(PRICES);
    expect((ev.find(e => e.type === "market") as MarketUpdate).source).toBe("snapshot");

    vi.advanceTimersByTime(11_000); // > staleAfterMs 10 s since the last message
    expect(stream.state).toMatchObject({ status: "stale", channel: "prices" });
    vi.advanceTimersByTime(10_000); // > 2× → forced reconnect
    expect(stream.state).toMatchObject({ status: "reconnecting", attempt: 1, inMs: 500 });
    expect((stream.state as Extract<ConnectionState, { status: "reconnecting" }>).reason.message).toMatch(/No message on prices/);
    expect(t.sockets[0].closedWith).not.toBeNull();

    vi.advanceTimersByTime(500);
    expect(t.sockets).toHaveLength(2);
    expect(stream.state.status).toBe("connecting");
    t.last().open();
    expect(t.last().sentJson()).toEqual([{ method: "subscribe", params: { source: "prices" } }]); // resubscribed
    t.last().message(PRICES);
    const markets = ev.filter((e): e is MarketUpdate => e.type === "market");
    expect(markets.at(-1)!.source).toBe("snapshot"); // re-emitted as snapshot after reconnect
    t.last().message(PRICES);
    expect((ev.filter(e => e.type === "market") as MarketUpdate[]).at(-1)!.source).toBe("ws");

    await stream.close();
    expect(stream.state).toMatchObject({ status: "closed", reason: { code: "CLIENT_CLOSE" } });
    expect(states.map(s => s.status)).toEqual(["connecting", "live", "stale", "reconnecting", "connecting", "live", "closed"]);
    expect(ev.filter(e => e.type === "state").map(e => (e as Extract<StreamControl, { type: "state" }>).state.status))
      .toEqual(["connecting", "live", "stale", "reconnecting", "connecting", "live", "closed"]);
  });

  it("stale → live again when the silent channel resumes", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(PRICES);
    vi.advanceTimersByTime(11_000);
    expect(stream.state.status).toBe("stale");
    t.last().message(PRICES);
    expect(stream.state.status).toBe("live");
  });

  it("a visibilitychange re-evaluates staleness at once and sends a liveness ping", async () => {
    let now = 1_000_000;
    let hidden = true;
    let fire: () => void = () => undefined;
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, {
      transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), clock: () => now,
      visibility: { hidden: () => hidden, onChange: (cb) => { fire = cb; return () => undefined; } },
    });
    stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(PRICES);
    now += 15_000; // throttled tab: no timer ran, but 15 s passed
    expect(stream.state.status).toBe("live");
    hidden = false;
    fire();
    expect(stream.state).toMatchObject({ status: "stale", channel: "prices", silentMs: 15_000 });
    expect(t.last().sentJson().at(-1)).toEqual({ method: "ping" });
  });

  it("handshake failure before open → EXCHANGE_UNREACHABLE with the Origin/CORS remediation", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().serverClose(1006);
    expect(stream.state).toMatchObject({
      status: "reconnecting",
      reason: { code: "EXCHANGE_UNREACHABLE", wsCode: 1006, remediation: HANDSHAKE_REMEDIATION },
    });
  });

  it("reconnect attempts exhausted → closed with reason; subscriptions end with a fatal error", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, {
      transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, reconnect: { maxAttempts: 1, baseMs: 100, maxMs: 100 },
    });
    const sub = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().serverClose(1006);
    vi.advanceTimersByTime(100);
    t.last().serverClose(1006);
    expect(stream.state).toMatchObject({ status: "closed", reason: { code: "EXCHANGE_UNREACHABLE" } });
    await expect(sub.ready).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    expect(sub.status).toBe("rejected");
  });

  it("missed pong → forced reconnect", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, staleAfterMs: 1_000_000 });
    stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    vi.advanceTimersByTime(20_000);
    expect(t.last().sentJson().at(-1)).toEqual({ method: "ping" });
    t.last().message({ channel: "pong" });
    vi.advanceTimersByTime(20_000);
    expect(stream.state.status).toBe("live"); // pong arrived → another ping
    vi.advanceTimersByTime(20_000);
    expect(stream.state).toMatchObject({ status: "reconnecting", reason: { message: expect.stringMatching(/No pong/) } });
  });
});

describe("new-connection budget", () => {
  it("reconnect storm: hyperliquid opens ≤ 30 connections per minute (delayed, never skipped)", async () => {
    const t = fakeTransport();
    const factory = (url: string) => {
      const ws = t.factory(url);
      setTimeout(() => (ws as ReturnType<typeof t.last>).serverClose(1006), 0);
      return ws;
    };
    const stream = createVenueStream(hyperliquid, {
      transport: factory, fetch: fakeFetch(HL_ROUTES), visibility: null, reconnect: { maxAttempts: null, baseMs: 1, maxMs: 1 },
    });
    stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    vi.advanceTimersByTime(59_000);
    expect(t.sockets.length).toBe(30);
    vi.advanceTimersByTime(2_000);
    expect(t.sockets.length).toBeGreaterThan(30);
    expect(t.sockets.length).toBeLessThanOrEqual(60);
    await stream.close();
  });
});

describe("wire subscriptions", () => {
  it("two subscriptions on one wire → one wire sub; unsubscribe only when the last leaves; then idle", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    const a = stream.subscribe({ kind: "allMarkets" });
    const b = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    await flush(30);
    t.last().open();
    expect(t.last().sentJson()).toEqual([{ method: "subscribe", params: { source: "prices" } }]);
    t.last().message({ channel: "subscribe", data: { source: "prices" } });
    await expect(Promise.all([a.ready, b.ready])).resolves.toBeDefined();
    const bEvents: MarketUpdate[] = [];
    b.on(e => { if (e.type === "market") bEvents.push(e); });
    t.last().message(PRICES);
    expect(bEvents.map(e => e.symbol)).toEqual(["BTC"]);
    await a.unsubscribe();
    expect(t.last().sent).toHaveLength(1);
    await b.unsubscribe();
    expect(t.last().sentJson().at(-1)).toEqual({ method: "unsubscribe", params: { source: "prices" } });
    expect(stream.state.status).toBe("idle");
    expect(a.status).toBe("closed");
  });

  it("over budget → SUBSCRIPTION_LIMIT before any send", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null, budget: { maxSubscriptions: 2 } });
    stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    stream.subscribe({ kind: "market", symbol: "ETH", channels: ["market"] });
    await flush(30);
    t.last().open();
    const sent = t.last().sent.length;
    const third = stream.subscribe({ kind: "market", symbol: "SOL", channels: ["market"] });
    await expect(third.ready).rejects.toMatchObject({ structured: { code: "SUBSCRIPTION_LIMIT", details: { needed: 3, allowed: 2 } } });
    expect(t.last().sent.length).toBe(sent);
  });

  it("channels other than market → CAPABILITY_UNSUPPORTED in this release", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    await expect(stream.subscribe({ kind: "market", symbol: "BTC", channels: ["bbo"] }).ready).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
  });

  it("hyperliquid drops the socket right after a subscribe → that subscription gets INVALID_PARAMS, others reconnect", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    const all = stream.subscribe({ kind: "allMarkets" });
    await flush(30);
    t.last().open();
    t.last().message(fixtureFrames("hyperliquid", "control")[0]); // ack allDexsAssetCtxs
    await expect(all.ready).resolves.toBeUndefined();
    vi.advanceTimersByTime(5_000);
    const coin = stream.subscribe({ kind: "market", symbol: "BTC", channels: ["market"] });
    await flush(30);
    t.last().serverClose(1006);
    await expect(coin.ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(all.status).toBe("active");
    expect(stream.state.status).toBe("reconnecting");
    vi.advanceTimersByTime(1_000);
    t.last().open();
    expect(t.last().sentJson()).toEqual([{ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } }]);
  });
});

describe("redaction", () => {
  it("secrets never reach an error event, a log line or a CloseReason", async () => {
    const t = fakeTransport();
    const logs: StreamLog[] = [];
    const stream = createVenueStream(aster, { transport: t.factory, fetch: fakeFetch(ASTER_ROUTES), visibility: null, logger: l => logs.push(l) });
    const ev: unknown[] = [];
    stream.subscribe({ kind: "allMarkets" }).on(e => ev.push(e));
    stream.onState(s => ev.push(s));
    await flush(30);
    t.last().open();
    const secrets = ["LKSECRETa1b2c3d4e5f6g7h8i9j0", "TOKSECRET-xyz", "0xSIGSECRET", "HMACSECRETdeadbeef"];
    t.last().message({ listenKey: secrets[0], token: secrets[1], signature: secrets[2], hmac: secrets[3] });
    t.last().message(`{"auth":"${secrets[1]}", "broken`);
    t.last().message({ error: { code: 1, msg: `bad request {\\"listenKey\\":\\"${secrets[0]}\\"} token=${secrets[1]}` }, id: 7 });
    t.last().message({ stream: "!markPrice@arr@1s", data: "nope?listenKey=" + secrets[0] });
    t.last().serverClose(1008, `wss://fstream.asterdex.com/ws/${secrets[0]} expired, signature: ${secrets[2]}`);
    const dump = JSON.stringify({ ev, logs, state: stream.state });
    expect(ev.filter(e => (e as { type?: string }).type === "error").length).toBeGreaterThanOrEqual(4);
    for (const s of secrets) expect(dump).not.toContain(s);
    expect(dump).toContain("<redacted>");
  });
});

describe("runtime", () => {
  it("no transport and no global WebSocket → INVALID_PARAMS with the perp-cli/ws/node remediation", () => {
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    delete g.WebSocket;
    try {
      expect(() => createVenueStream(hyperliquid, { fetch: fakeFetch({}) })).toThrow(expect.objectContaining({
        structured: expect.objectContaining({ code: "INVALID_PARAMS", remediation: "import from perp-cli/ws/node or pass transport" }),
      }));
    } finally {
      if (saved !== undefined) g.WebSocket = saved;
    }
  });
});

describe("buffering", () => {
  it("iterator coalesces market state by symbol; control events overflow → STREAM_OVERFLOW (fatal)", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null, buffer: { size: 2 } });
    const sub = stream.subscribe({ kind: "allMarkets" });
    const it = sub[Symbol.asyncIterator]();
    await flush(30);
    t.last().open();
    for (let i = 0; i < 5; i++) t.last().message(PRICES);
    // 2 state controls (connecting, live) already queued; 4 coalesced market rows
    const got: Array<MarketUpdate | StreamControl> = [];
    for (let i = 0; i < 6; i++) got.push((await it.next()).value as MarketUpdate | StreamControl);
    expect(got.filter(e => e.type === "market")).toHaveLength(4);
    t.last().message("garbage-1");
    t.last().message("garbage-2");
    t.last().message("garbage-3");
    const rest: Array<MarketUpdate | StreamControl> = [];
    for (;;) { const r = await it.next(); if (r.done) break; rest.push(r.value as MarketUpdate | StreamControl); }
    expect(rest.at(-1)).toMatchObject({ type: "error", code: "STREAM_OVERFLOW", fatal: true });
    expect(sub.status).toBe("closed");
  });
});
