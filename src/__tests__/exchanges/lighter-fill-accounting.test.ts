/**
 * Lighter fill accounting — money-safety regression (live testnet E2E 2026-10-02, step
 * t-alo-cross): a post-only buy crossing the ask was reported "partiallyFilled 0.089" while the
 * venue said canceled-post-only, filled 0.000. The venue zeroes `rs` (remaining) when it cancels
 * an order, so is − rs (size − remaining) reads a cancelled order as fully filled. Fills come
 * only from the venue's filled fields: event_info status "filled" (→ the whole order) or the
 * accountOrders row's `filled_base_amount`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../../exchanges/venues/index.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { LighterAdapter, lighterTakerFilledBase, lighterEventFilledBase, lighterRowOutcomeOf, lighterEventInfo, lighterEventOrderId, lighterModifyOutcomeOf, lighterOrderIdOf } from "../../exchanges/lighter.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

afterEach(() => vi.useRealTimers());

async function run<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

// GET /api/v1/accountInactiveOrders (testnet, account 537, market 4097 SOL), read 2026-10-02 —
// the t-alo-cross order: `perp trade limit SOL buy 123.624 0.089 --tif ALO`.
const ALO_CROSS_ROW = {
  order_index: 1125899905387659, client_order_index: 179091657978136, order_id: "1125899905387659",
  client_order_id: "179091657978136", market_index: 4097, market_kind: "perps", owner_account_index: 537,
  initial_base_amount: "0.089", price: "123.624", nonce: 281474975255691, remaining_base_amount: "0.000",
  is_ask: false, base_size: 0, base_price: 123624, filled_base_amount: "0.000", filled_quote_amount: "0.000000",
  side: "", type: "limit", time_in_force: "post-only", reduce_only: false, trigger_price: "0.000",
  order_expiry: 1793335779889, status: "canceled-post-only", trigger_status: "na", trigger_time: 0,
  parent_order_index: 0, parent_order_id: "0", order_flags: 0, block_height: 30062, timestamp: 1790916574,
  created_at: 1790916574, updated_at: 1790916574, transaction_time: 1790916579935497, order_version: 0,
};
// The same order's taker `to` as the adapter read it from /tx event_info (the tx has since been
// pruned from testnet /tx; is 89 / rs 0 / st 5 reproduces the reported "filled 0.089" = is − rs).
const ALO_CROSS_TO = { i: 1125899905387659, u: 179091657978136, a: 537, is: 89, p: 123624, rs: 0, ia: 0, ot: 0, f: 2, ro: 0, tp: 0, e: 1793335779889, st: 5 };
// GET /api/v1/tx (testnet, type 14 CreateOrder) — a taker fully filled: st 3, is 100, rs 0, trade t.s 100.
const FILLED_EVENT = '{"ms":0,"m":4095,"t":{"p":268989,"s":100,"tf":280,"mf":0,"itf":0,"itfci":0,"imf":0,"imfci":0},"mo":{"i":281474976710657,"u":179063628209702,"a":9,"is":20000,"p":268989,"rs":19900,"ia":1,"ot":0,"f":2,"ro":0,"tp":0,"e":1793055482098,"st":2,"ts":0,"t0":0,"t1":0,"c0":0,"ifci":0,"itf":0,"imf":0,"of":0,"mn":0},"to":{"i":562949953421306,"u":179063628990001,"a":7,"is":100,"p":270334,"rs":0,"ia":0,"ot":0,"f":0,"ro":0,"tp":0,"e":0,"st":3,"ts":0,"t0":0,"t1":0,"c0":0,"ifci":0,"itf":0,"imf":0,"of":0,"mn":0},"ae":""}';

describe("event_info never yields size − remaining", () => {
  it("a cancelled order (rs zeroed) has no fill in event_info → null", () => {
    expect(lighterEventFilledBase(ALO_CROSS_TO)).toBeNull();
    expect(lighterTakerFilledBase(JSON.stringify({ to: ALO_CROSS_TO, ae: "" }), 89)).toBeNull();
    // every non-filled status, whatever rs says
    for (const st of [2, 4, 5, 6, 9, 10, 12]) expect(lighterEventFilledBase({ is: 89, rs: 0, st })).toBeNull();
    expect(lighterEventFilledBase({ is: 89, rs: 40, st: 2 })).toBeNull();
  });
  it("status 3 filled → the whole order; initial size ≠ sent → null", () => {
    expect(lighterTakerFilledBase(FILLED_EVENT, 100)).toBe(100);
    expect(lighterTakerFilledBase(FILLED_EVENT, 99)).toBeNull();
  });
  it("accountOrders row: the venue's filled_base_amount; missing / malformed → null (never '0')", () => {
    expect(lighterRowOutcomeOf(ALO_CROSS_ROW, "1125899905387659")).toEqual({
      status: "cancelled", final: true, venueStatus: "canceled-post-only", filledSize: "0.000", orderId: "1125899905387659", source: "accountOrders",
    });
    expect(lighterRowOutcomeOf({ ...ALO_CROSS_ROW, filled_base_amount: undefined }, "x")).toBeNull();
    expect(lighterRowOutcomeOf({ ...ALO_CROSS_ROW, filled_base_amount: "" }, "x")).toBeNull();
    expect(lighterRowOutcomeOf({ ...ALO_CROSS_ROW, filled_base_amount: "abc" }, "x")).toBeNull();
    expect(lighterRowOutcomeOf({ ...ALO_CROSS_ROW, filled_base_amount: "0.040" }, "x")?.status).toBe("partiallyFilled");
  });
});

function ltAdapter(eventTo: Record<string, unknown> | string, rows: unknown[] | Error) {
  const a = Object.create(LighterAdapter.prototype) as LighterAdapter & Record<string, unknown>;
  a.name = "lighter";
  a._testnet = false;
  a._marketDecimals = new Map([["SOL", { size: 3, price: 3 }]]);
  a.ensureSigner = vi.fn();
  a.ensureMarketMap = vi.fn();
  a.getNextNonce = vi.fn().mockResolvedValue(1);
  a.getMarketIndex = vi.fn().mockReturnValue(4097);
  a.toTicks = vi.fn().mockReturnValue({ baseAmount: 89, priceTicks: 123624 });
  a.signOrder = vi.fn().mockResolvedValue({ txType: 14, txInfo: "{}", txHash: "4951" });
  a.sendTx = vi.fn().mockResolvedValue({ code: 200, tx_hash: "4951" });
  const eventInfo = typeof eventTo === "string" ? eventTo : JSON.stringify({ to: eventTo, ae: "" });
  a.restGet = vi.fn().mockResolvedValue({ hash: "4951", status: 2, executed_at: 1790916579935, event_info: eventInfo });
  a.getOrdersByClientIndex = rows instanceof Error ? vi.fn().mockRejectedValue(rows) : vi.fn().mockResolvedValue(rows);
  return a;
}

const COI = 179091657978136;

describe("t-alo-cross: crossing post-only → cancelled, filled 0 (the live failure)", () => {
  it("limitOrder ALO resolves from accountOrders filled_base_amount, not is − rs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter(ALO_CROSS_TO, [ALO_CROSS_ROW]);
    const raw = await run(a.limitOrder("SOL", "buy", "123.624", "0.089", { tif: "ALO", clientOrderIndex: COI })) as Record<string, unknown>;
    expect(a.getOrdersByClientIndex).toHaveBeenCalledWith([COI]);
    expect(raw.orderOutcome).toEqual({
      status: "cancelled", final: true, venueStatus: "canceled-post-only", filledSize: "0.000", orderId: "1125899905387659", source: "accountOrders",
    });
    const adapter = {
      name: "lighter", limitOrder: vi.fn().mockResolvedValue(raw),
      getMarkets: vi.fn().mockResolvedValue([{ symbol: "SOL", stepSize: "0.001", sizeDecimals: 3 }]),
    } as unknown as ExchangeAdapter;
    const r = await toTradingV2(adapter, "testnet").placeOrder({
      symbol: "SOL", side: "buy", type: "limit", size: "0.089", price: "123.624", triggerPrice: null, triggerSource: null,
      tif: "ALO", reduceOnly: false, clientOrderId: String(COI), slippage: null, tpsl: null,
    });
    expect(r).toMatchObject({ status: "cancelled", finality: "final", orderId: "1125899905387659", filledSize: "0.000" });
  });

  it("accountOrders unreadable → no outcome (pending), never a guessed fill", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ltAdapter(ALO_CROSS_TO, new Error("HTTP 500"));
    const raw = await run(a.limitOrder("SOL", "buy", "123.624", "0.089", { tif: "ALO", clientOrderIndex: COI })) as Record<string, unknown>;
    expect(raw.orderOutcome).toBeUndefined();
    expect(a.getOrdersByClientIndex).toHaveBeenCalledTimes(4); // bounded
    err.mockRestore();
  });

  it("a cancelled order that did fill partly → partiallyFilled with the venue's filled amount", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter({ ...ALO_CROSS_TO, f: 1, st: 4 }, [{ ...ALO_CROSS_ROW, time_in_force: "good-till-time", status: "canceled", filled_base_amount: "0.030" }]);
    const raw = await run(a.limitOrder("SOL", "buy", "123.624", "0.089", { tif: "GTC", clientOrderIndex: COI })) as Record<string, unknown>;
    expect(raw.orderOutcome).toMatchObject({ status: "partiallyFilled", filledSize: "0.030", venueStatus: "canceled" });
  });

  it("event_info status filled → filled with the whole size, no accountOrders read", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter({ ...ALO_CROSS_TO, f: 1, st: 3 }, []);
    const raw = await run(a.limitOrder("SOL", "buy", "123.624", "0.089", { tif: "GTC", clientOrderIndex: COI })) as Record<string, unknown>;
    expect(raw.orderOutcome).toMatchObject({ status: "filled", filledSize: "0.089", source: "event_info" });
    expect(a.getOrdersByClientIndex).not.toHaveBeenCalled();
  });
});

describe("IOC: a cancelled remainder is never reported as filled", () => {
  const ioc = (a: LighterAdapter & Record<string, unknown>) =>
    run(a.limitOrder("SOL", "buy", "123.624", "0.089", { tif: "IOC", clientOrderIndex: COI })) as Promise<Record<string, unknown>>;

  it("partial IOC (event st canceled, rs 0) → iocOutcome from filled_base_amount", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter({ ...ALO_CROSS_TO, f: 0, st: 10 }, [{ ...ALO_CROSS_ROW, time_in_force: "immediate-or-cancel", status: "canceled-not-enough-liquidity", filled_base_amount: "0.040" }]);
    const raw = await ioc(a);
    expect(raw.iocOutcome).toMatchObject({ filledSize: "0.04", filledBase: 40, sentBase: 89, final: true, source: "accountOrders" });
    expect(a.iocOutcomeOf(raw)).toEqual({ filledSize: "0.04", final: true });
  });

  it("zero-fill IOC (rs 0) → ORDER_REJECTED, not a full fill", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter({ ...ALO_CROSS_TO, f: 0, st: 10 }, [{ ...ALO_CROSS_ROW, time_in_force: "immediate-or-cancel", status: "canceled-not-enough-liquidity" }]);
    await expect(ioc(a)).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("no accountOrders row → outcome unknown (no iocOutcome), never is − rs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ltAdapter({ ...ALO_CROSS_TO, f: 0, st: 10 }, []);
    const raw = await ioc(a);
    expect(raw.iocOutcome).toBeUndefined();
    expect(a.iocOutcomeOf(raw)).toBeNull();
    err.mockRestore();
  });

  it("IOC reported filled (st 3) → the whole size from event_info", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter({ ...ALO_CROSS_TO, f: 0, st: 3 }, []);
    const raw = await ioc(a);
    expect(raw.iocOutcome).toMatchObject({ filledSize: "0.089", source: "event_info" });
    expect(a.getOrdersByClientIndex).not.toHaveBeenCalled();
  });
});

// Lighter RH testnet (E2E 2026-10-02, t-limit-gtc / t-orders-gtc-check / t-edit): the GTC TSLA
// buy 338.20 x 0.0326 has venue order id 32088147345014782 > 2^53. JSON.parse(event_info) rounded
// it, the adapter reported orderId null, the runner fell back to c:<clientOrderId> — which is
// not an `account orders` id and which edit refuses (amendByClientOrderId).
// GET /api/v1/accountInactiveOrders (api.rh-testnet.lighter.xyz, account 354, market 112), read 2026-10-02 (after the cancel):
const RH_GTC_ROW = {
  order_index: 32088147345014782, client_order_index: 179091661113978, order_id: "32088147345014782", client_order_id: "179091661113978",
  market_index: 112, owner_account_index: 354, initial_base_amount: "0.0326", price: "338.20", nonce: 281474976710654,
  remaining_base_amount: "0.0000", is_ask: false, base_size: 0, base_price: 33820, filled_base_amount: "0.0000",
  filled_quote_amount: "0.000000", side: "", type: "limit", time_in_force: "good-till-time", reduce_only: false,
  trigger_price: "0.00", order_expiry: 1793335811384, status: "canceled", trigger_status: "na", order_version: 0,
  created_at: 1790916574,
};
const RH_OPEN_ROW = { ...RH_GTC_ROW, status: "open", remaining_base_amount: "0.0326" };
const RH_EVENT = '{"ms":0,"m":112,"to":{"i":32088147345014782,"u":179091661113978,"a":354,"is":326,"p":33820,"rs":326,"ia":0,"ot":0,"f":1,"ro":0,"tp":0,"e":1793335811384,"st":2},"ae":""}';

describe("Lighter RH: order ids above 2^53 stay exact", () => {
  it("lighterEventInfo keeps 16+ digit integers as exact strings", () => {
    const ei = lighterEventInfo(RH_EVENT)!;
    const to = ei.to as Record<string, unknown>;
    expect(to.i).toBe("32088147345014782");
    expect(lighterEventOrderId(to.i)).toBe("32088147345014782");
    expect(to.u).toBe(179091661113978); // ≤ 2^48 stays a number
    expect(String(JSON.parse(RH_EVENT).to.i)).not.toBe("32088147345014782"); // plain JSON.parse rounds it
  });

  it("GTC placement reports the id `account orders` lists (accountOrders order_id)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter(lighterEventInfo(RH_EVENT)!.to as Record<string, unknown>, [RH_OPEN_ROW]);
    a.name = "lighter-rh";
    a.getMarketIndex = vi.fn().mockReturnValue(112); // the row's market (a row of another market is not ours)
    a._marketDecimals = new Map([["TSLA", { size: 4, price: 2 }]]);
    a.restGet = vi.fn().mockResolvedValue({ hash: "64c2", status: 2, executed_at: 1, event_info: RH_EVENT });
    const raw = await run(a.limitOrder("TSLA", "buy", "338.20", "0.0326", { tif: "GTC", clientOrderIndex: 179091661113978 })) as Record<string, unknown>;
    expect(raw.orderOutcome).toMatchObject({ status: "open", orderId: "32088147345014782", filledSize: "0.0000" });
    expect((raw.orderOutcome as { orderId: string }).orderId).toBe(lighterOrderIdOf(RH_OPEN_ROW)); // = getOpenOrders orderId
  });

  it("a filled event keeps the exact id", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790916574_000);
    const a = ltAdapter("", []);
    a._marketDecimals = new Map([["TSLA", { size: 4, price: 2 }]]);
    a.restGet = vi.fn().mockResolvedValue({ hash: "64c2", status: 2, executed_at: 1, event_info: RH_EVENT.replace('"rs":326', '"rs":0').replace('"st":2', '"st":3') });
    const raw = await run(a.limitOrder("TSLA", "buy", "338.20", "0.0326", { tif: "GTC", clientOrderIndex: 179091661113978 })) as Record<string, unknown>;
    expect(raw.orderOutcome).toMatchObject({ status: "filled", orderId: "32088147345014782", filledSize: "0.0326", source: "event_info" });
  });

  it("modify outcome matches the big id exactly (never another order)", () => {
    const ev = lighterEventInfo(RH_EVENT.replace('"to"', '"no"').replace('"rs":326', '"rs":0').replace('"st":2', '"st":3'));
    const sent = { baseAmount: 326, priceTicks: 33820 };
    expect(lighterModifyOutcomeOf(ev, "32088147345014782", null, sent, 4)?.orderId).toBe("32088147345014782");
    expect(lighterModifyOutcomeOf(ev, "32088147345014780", null, sent, 4)).toBeNull(); // the rounded neighbour
  });
});
