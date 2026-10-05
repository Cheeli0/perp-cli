/**
 * Arcus alignment with docs.arcus.xyz (openapi / rate-limits / changelog):
 *  - modifyOrder sends the order's new TOTAL size (filled + new open), signed `q` too;
 *    new open ≤ 0 → cancel; MODIFY_SIZE_ALREADY_FILLED → the order's read-back (cancelled) state
 *  - modify signed identity switch (UNVERIFIED): "idOnly" (openapi, default) vs "idAndClientId"
 *  - Unix-ns nonces, withdraw ≤ 6 decimals checked before signing
 *  - rejection / setLeverage / 429 mapping, l2OrderBook weight, openOrders pagination in cancel-all
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import "../../exchanges/venues/index.js";
import { ArcusAdapter } from "../../exchanges/arcus/adapter.js";
import { ArcusClient } from "../../exchanges/arcus/client.js";
import { ARCUS_MODIFY_SIGNED_IDENTITY, modifyPayload } from "../../exchanges/arcus/signing.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";
import { PerpError } from "../../errors.js";

const OWNER = "0x00000000000000000000000000000000000000aa" as const;
const MARKET = { marketId: 7, marketDisplayName: "TSLA-USD", baseAsset: "TSLA", stepSize: "0.01", tickSize: "0.01", tickTiers: null };

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => JSON.stringify(body) };
}

let fetchMock: ReturnType<typeof vi.fn>;
let signed: string[];
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  signed = [];
});

function adapter(): ArcusAdapter {
  const def = getVenue("arcus");
  const a = Object.create(ArcusAdapter.prototype) as ArcusAdapter & Record<string, unknown>;
  Object.assign(a, {
    venue: def, network: "testnet", caps: requireCapabilities(def),
    account: { owner: OWNER, sub: 0 },
    client: new ArcusClient("testnet", {
      apiKeyHex: "ab".repeat(32), ownerAddress: OWNER,
      sign: async (m: Uint8Array) => { signed.push(Buffer.from(m).toString("utf8")); return new Uint8Array(64); },
    }),
    market: vi.fn(async () => MARKET),
  });
  return a;
}

function order(over: Record<string, unknown> = {}) {
  return {
    orderId: "o1", clientId: "cid1", marketId: 7, marketDisplayName: "TSLA-USD", side: "BUY", status: "PARTIALLY_FILLED",
    price: "100", originalSize: "1", filledSize: "0.3", remainingSize: "0.7", timeInForce: "GTC",
    goodTilTime: "1800000000000000", reduceOnly: false, updatedAt: 1, ...over,
  };
}

const amend = (a: ArcusAdapter, size: string) =>
  a.amendOrder({ symbol: "TSLA", ref: { kind: "orderId", value: "o1" }, price: "101", size, tif: null, forceTif: false });

describe("Arcus modifyOrder total-size semantics", () => {
  it("sends quantity = filled + new open and signs the same total quantums", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, order()))
      .mockResolvedValueOnce(reply(202, { orderId: "o1", status: "ACK" }));
    const r = await amend(adapter(), "0.5");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v1/modifyOrder");
    expect(body.quantity).toBe("0.8");
    expect(body.orderId).toBe("o1");
    expect(body.clientId).toBeUndefined();
    const payload = JSON.parse(signed[0]);
    expect(payload.q).toBe(80);
    expect(payload.op).toBe(3);
    expect(r.execution.notes.join(" ")).toContain("total size 0.8 = filled 0.3 + new open 0.5");
  });

  it("a modify ACK is read back: final once the order shows the new price and total size", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(reply(200, order()))
      .mockResolvedValueOnce(reply(202, { orderId: "o1", status: "ACK" }))
      .mockResolvedValueOnce(reply(200, order({ status: "OPEN" }))) // not applied yet (old price / size)
      .mockResolvedValueOnce(reply(200, order({ status: "PARTIALLY_FILLED", price: "101", originalSize: "0.8", remainingSize: "0.5" })));
    const p = amend(adapter(), "0.5");
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(r).toMatchObject({ status: "partiallyFilled", finality: "final", orderId: "o1", filledSize: "0.3" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("new open size 0 cancels the order instead of modifying", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, order()))
      .mockResolvedValueOnce(reply(200, { orderId: "o1", status: "CANCELED" }));
    const r = await amend(adapter(), "0");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v1/cancelOrder");
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes("modifyOrder"))).toBe(false);
    expect(r).toMatchObject({ status: "cancelled", finality: "final", orderId: "o1" });
  });

  it.each([
    ["HTTP 422 body", () => reply(422, { error: "rejected", rejectionReason: "MODIFY_SIZE_ALREADY_FILLED" })],
    ["200 ERROR body", () => reply(200, { orderId: "o1", status: "ERROR", rejectionReason: "MODIFY_SIZE_ALREADY_FILLED" })],
  ])("MODIFY_SIZE_ALREADY_FILLED (%s) → read-back cancelled result", async (_l, rej) => {
    fetchMock
      .mockResolvedValueOnce(reply(200, order()))
      .mockResolvedValueOnce(rej())
      .mockResolvedValueOnce(reply(200, order({ status: "CANCELED", filledSize: "0.9", remainingSize: "0" })));
    const r = await amend(adapter(), "0.5");
    expect(r).toMatchObject({ status: "cancelled", filledSize: "0.9", orderId: "o1" });
    expect(r.execution.notes.join(" ")).toContain("MODIFY_SIZE_ALREADY_FILLED");
  });
});

describe("Arcus modify signed identity (UNVERIFIED switch)", () => {
  const f = { address: OWNER, accountIndex: 0, clientId: "cid1", ctNs: 1n, goodTilNs: 2n, marketId: 7, priceTicks: 3n, quantums: 4n, reduceOnly: false, side: "buy" as const, tif: "GTT" as const };
  it("defaults to the openapi variant: id only", () => {
    expect(ARCUS_MODIFY_SIGNED_IDENTITY).toBe("idOnly");
    const p = JSON.parse(modifyPayload(f, "o1"));
    expect(p.id).toBe("o1");
    expect(p.c).toBeUndefined();
  });
  it("authentication-page variant: id + the resting order's c", () => {
    const p = JSON.parse(modifyPayload(f, "o1", "idAndClientId"));
    expect(p).toMatchObject({ id: "o1", c: "cid1" });
    expect(modifyPayload(f, "o1", "idAndClientId")).toBe(
      '{"ad":"0x00000000000000000000000000000000000000aa","ai":0,"c":"cid1","ct":1,"g":2,"id":"o1","m":7,"op":3,"p":3,"q":4,"r":0,"s":0,"t":0,"v":1}');
  });
});

describe("Arcus error mapping", () => {
  it.each([
    ["POST_ONLY_WOULD_CROSS", "ORDER_REJECTED"],
    ["REDUCE_ONLY_WOULD_INCREASE", "INVALID_PARAMS"],
    ["POSITION_TPSL_ALREADY_EXISTS", "DUPLICATE_ORDER"],
    ["OPEN_ORDER_CAP_EXCEEDED", "RISK_VIOLATION"],
    ["MISSING_MARK_PRICE", "PRICE_STALE"],
    ["MODIFY_TPSL_NOT_SUPPORTED", "CAPABILITY_UNSUPPORTED"],
    ["MODIFY_ZERO_SIZE", "INVALID_PARAMS"],
    ["MODIFY_SUPERSEDED_BY_CANCEL", "ORDER_REJECTED"],
  ])("rejectionReason %s → %s", async (reason, code) => {
    fetchMock.mockResolvedValueOnce(reply(422, { error: "rejected", rejectionReason: reason }));
    const err = await adapter()["client"].postScheme2("cancelAllOrders", {}).catch(e => e) as PerpError;
    expect(err.structured.code).toBe(code);
    expect(err.structured.details?.rejectionReason).toBe(reason);
  });

  it.each([
    ["UNDERCOLLATERALIZED", "MARGIN_INSUFFICIENT"],
    ["HAS_OPEN_POSITION", "INVALID_PARAMS"],
  ])("setLeverage 422 rejectReason %s → %s", async (reason, code) => {
    fetchMock.mockResolvedValueOnce(reply(422, { leverage: 5, status: "REJECTED", rejectReason: reason }));
    const err = await adapter().applyLeverage("TSLA", 3, "isolated").catch(e => e) as PerpError;
    expect(err.structured.code).toBe(code);
    expect(err.structured.remediation).toBeTruthy();
  });

  it("429 on an order write carries retryAfterMs and reason", async () => {
    fetchMock.mockResolvedValueOnce(reply(429, { error: "rate limited", reason: "account_empty", retryAfterMs: 850 }, { "retry-after": "1" }));
    const err = await adapter()["client"].postScheme2("cancelAllOrders", {}).catch(e => e) as PerpError;
    expect(err.structured.code).toBe("RATE_LIMITED");
    expect(err.structured.details).toMatchObject({ retryAfterMs: 850, reason: "account_empty" });
  });

  it("429 on a read without reason uses Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(reply(429, { error: "rate limited" }, { "retry-after": "2" }));
    const err = await adapter()["client"].get("/v1/markets", "markets").catch(e => e) as PerpError;
    expect(err.structured.details).toMatchObject({ retryAfterMs: 2000 });
  });
});

describe("Arcus withdraw / nonces / weights", () => {
  it("rejects amounts with more than 6 decimals before signing", async () => {
    const a = adapter();
    const masterSigner = vi.fn();
    Object.assign(a, { masterSigner });
    await expect(a.withdraw("1.0000001", OWNER)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(masterSigner).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("withdraw nonce is a Unix-ns decimal string", async () => {
    const a = adapter();
    const signTypedData = vi.fn(async () => "0x" + "11".repeat(32) + "22".repeat(32) + "1b");
    Object.assign(a, { masterSigner: async () => ({ getAddress: () => OWNER, signTypedData }) });
    fetchMock.mockResolvedValueOnce(reply(200, { status: "ok" }));
    const before = BigInt(Date.now()) * 1_000_000n;
    await a.withdraw("2.5", OWNER);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.nonce).toMatch(/^\d{19}$/);
    expect(BigInt(body.nonce) >= before).toBe(true);
  });

  it("l2OrderBook weight = 2 + floor(50/20) = 4", () => {
    expect(getVenue("arcus").rateLimit.weights?.l2OrderBook).toBe(4);
  });
});

describe("Arcus cancel-all pages openOrders past 1000 rows", () => {
  it("follows `to` = oldest createdAt and dedupes the overlap", async () => {
    const row = (i: number) => order({ orderId: `o${i}`, createdAt: 1_800_000_000_000_000 + i });
    const page1 = Array.from({ length: 1000 }, (_, i) => row(2000 - i));       // o2000 … o1001
    const page2 = [row(1001), row(1000), row(999)];                             // overlap o1001
    fetchMock
      .mockResolvedValueOnce(reply(200, { orders: page1 }))
      .mockResolvedValueOnce(reply(200, { orders: page2 }))
      .mockResolvedValueOnce(reply(200, { status: "CANCEL_ALL_ACKNOWLEDGED" }));
    const r = await adapter().cancelAllV2(null);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("to")).toBe(String(1_800_000_000_000_000 + 1001));
    expect(r.cancelled).toHaveLength(1002);
  });
});

describe("Arcus minimum order notional (GET /markets minOrderNotional)", () => {
  // docs.arcus.xyz: "Flat minimum order notional (`quantity` × `price`, decimal USD) on
  // position-opening orders. Reduce-only orders (including TPSLs) are exempt."
  type LegFn = (m: unknown, p: Record<string, unknown>) => { size: string; quantums: bigint };
  const leg = (m: Record<string, unknown>, p: Record<string, unknown>) =>
    (adapter() as unknown as { leg: LegFn }).leg(m, { side: "buy", tif: "GTC", orderType: "LIMIT", clientId: "c", tpsl: null, ...p });
  const M = { ...MARKET, minOrderNotional: "5", minOrderSize: "0.01", maxOrderSize: "10000" };

  it("a position-opening order below the market minimum → SIZE_TOO_SMALL before anything is signed", () => {
    let err: unknown;
    try { leg(M, { size: "0.04", price: "100", reduceOnly: false }); } catch (e) { err = e; }   // $4
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured.code).toBe("SIZE_TOO_SMALL");
    expect((err as PerpError).message).toMatch(/notional 4 .* below the market minimum 5 USD/);
    expect(signed).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exactly the minimum passes (exact decimal math), and the minimum is read from the market, not hardcoded", () => {
    expect(leg(M, { size: "0.05", price: "100", reduceOnly: false }).size).toBe("0.05");          // $5.00
    expect(leg(M, { size: "0.07", price: "71.43", reduceOnly: false }).size).toBe("0.07");        // $5.0001
    expect(() => leg(M, { size: "0.07", price: "71.42", reduceOnly: false })).toThrow(/below the market minimum/); // $4.9994
    expect(() => leg({ ...M, minOrderNotional: "10" }, { size: "0.05", price: "100", reduceOnly: false })).toThrow(/minimum 10 USD/);
    // null = the venue published no minimum for this market → no local check.
    expect(leg({ ...M, minOrderNotional: null }, { size: "0.01", price: "1", reduceOnly: false }).size).toBe("0.01");
  });

  it("reduce-only orders (incl. TP/SL legs) are exempt", () => {
    expect(leg(M, { size: "0.01", price: "100", reduceOnly: true }).size).toBe("0.01");
    expect(leg(M, { size: "0.01", price: "100", reduceOnly: true, orderType: "MARKET", tif: "IOC", tpsl: { type: "STOP_LOSS", stopPrice: "99" } }).size).toBe("0.01");
  });

  it("the size is floored to the step BEFORE the check (the notional of what would be sent)", () => {
    expect(() => leg(M, { size: "0.059", price: "99", reduceOnly: false })).toThrow(/notional 4\.95 \(0\.05 × 99\)/);
  });
});

describe("Arcus getOrderStatus finality (status read path)", () => {
  const status = async (venueStatus: string) => {
    fetchMock.mockResolvedValueOnce(reply(200, order({ status: venueStatus })));
    return adapter().getOrderStatus("TSLA", { kind: "orderId", value: "o1" });
  };

  it("a resting order read back from the venue is final: OPEN → open, PARTIALLY_FILLED → partiallyFilled", async () => {
    expect(await status("OPEN")).toMatchObject({ status: "open", finality: "final", orderId: "o1" });
    expect(await status("PARTIALLY_FILLED")).toMatchObject({ status: "partiallyFilled", finality: "final", filledSize: "0.3" });
  });

  it("terminal states are final; a merely acknowledged order stays pending", async () => {
    expect(await status("FILLED")).toMatchObject({ status: "filled", finality: "final" });
    expect(await status("ACK")).toMatchObject({ status: "accepted", finality: "pending" });
  });
});

describe("Arcus getMarketSettings (GET /v1/leverages)", () => {
  it("one row per market: effective leverage + margin mode, symbol from the market id", async () => {
    const a = adapter() as ArcusAdapter & Record<string, unknown>;
    a.symbolOf = vi.fn(async (id: number) => (id === 7 ? "TSLA" : "BTC"));
    fetchMock.mockResolvedValueOnce(reply(200, { address: OWNER, accountIndex: 0, leverages: [
      { marketId: 1, marketDisplayName: "BTC-USD", leverage: 10, isolated: false, marginMode: "CROSS" },
      { marketId: 7, marketDisplayName: "TSLA-USD", leverage: 3, isolated: true, marginMode: "ISOLATED" },
    ] }));
    const rows = await (a as unknown as { getMarketSettings(): Promise<unknown> }).getMarketSettings();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/leverages?");
    expect(rows).toEqual([
      { symbol: "BTC", leverage: 10, marginMode: "cross" },
      { symbol: "TSLA", leverage: 3, marginMode: "isolated" },
    ]);
  });

  it("an entry without a readable leverage / margin mode throws", async () => {
    const a = adapter() as ArcusAdapter & Record<string, unknown>;
    a.symbolOf = vi.fn(async () => "BTC");
    fetchMock.mockResolvedValueOnce(reply(200, { leverages: [{ marketId: 1, marginMode: "CROSS" }] }));
    await expect((a as unknown as { getMarketSettings(): Promise<unknown> }).getMarketSettings()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});
