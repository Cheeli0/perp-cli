/**
 * Client order ids on Hyperliquid (cloid), Aster (newClientOrderId) and Lighter / Lighter RH
 * cancel by client order index.
 *  - HL exchange-endpoint: order `c` "an optional 128 bit hex string, e.g.
 *    0x1234567890abcdef1234567890abcdef"; `cancelByCloid` {cancels:[{asset, cloid}]}; info
 *    orderStatus `oid` "u64 … or 16-byte hex string representing the client order id".
 *  - Aster V3 futures New Order `newClientOrderId` ^[\.A-Z\:/a-z0-9_-]{1,36}$; Query / Cancel
 *    Order: "Either `orderId` or `origClientOrderId` must be sent."
 *  - lighter-go L2CancelOrderTxInfo `Index // Client Order Index or Order Index of the order to cancel`.
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { AsterAdapter } from "../../exchanges/aster.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { getVenue } from "../../exchanges/venue.js";
import { newVenueClientOrderId } from "../../exchanges/trading-v2.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

const CLOID = "0x1234567890abcdef1234567890abcdef";
const slippage = { bps: 50, source: "default" as const };

function hl() {
  const a = new HyperliquidAdapter(undefined, false);
  const sent: Array<Record<string, unknown>> = [];
  const h = a as unknown as Record<string, unknown>;
  h.ensureSigner = () => {};
  h.getAssetIndex = async () => 110_005; // a HIP-3 global asset id: addressed the same way
  h.getSzDecimals = () => 2;
  h.computeProtectionPrice = async () => ({ referencePrice: "100", protectionPrice: "100.5", appliedBps: 50 });
  h._orderAction = async (orders: unknown[]) => ({ type: "order", orders, grouping: "na" });
  h._invalidateAccountCache = async () => {};
  h._signAndSendAction = vi.fn(async (action: Record<string, unknown>) => {
    sent.push(action);
    if (action.type === "cancelByCloid") return { status: "ok", response: { type: "cancelByCloid", data: { statuses: ["success"] } } };
    return { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 9, cloid: CLOID } }] } } };
  });
  return { a, sent };
}

describe("Hyperliquid cloid", () => {
  it("--auto-id generator: 0x + 32 lowercase hex", () => {
    expect(newVenueClientOrderId(getVenue("hyperliquid"))).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("limit order sends `c` as the last wire key and reports the cloid", async () => {
    const { a, sent } = hl();
    const raw = await a.limitOrder("BTC", "buy", "100", "1", { tif: "GTC", clientOrderId: CLOID }) as Record<string, unknown>;
    const wire = (sent[0].orders as Array<Record<string, unknown>>)[0];
    expect(Object.keys(wire)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
    expect(wire.c).toBe(CLOID);
    expect(raw.clientOrderId).toBe(CLOID);
  });

  it("without a cloid the wire carries no `c` key", async () => {
    const { a, sent } = hl();
    await a.limitOrder("BTC", "buy", "100", "1", { tif: "GTC" });
    expect("c" in (sent[0].orders as Array<Record<string, unknown>>)[0]).toBe(false);
  });

  it.each(["my-id", "0x1234", "0X1234567890ABCDEF1234567890ABCDEF", `${CLOID}00`])("invalid cloid %s → INVALID_PARAMS, nothing sent", async (bad) => {
    const { a, sent } = hl();
    await expect(a.limitOrder("BTC", "buy", "100", "1", { clientOrderId: bad })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    await expect(a.marketOrder("BTC", "buy", "1", { reduceOnly: false, slippage, clientOrderId: bad })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    await expect(a.cancelByCloid("BTC", bad)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(sent).toHaveLength(0);
  });

  it("cancel c:<cloid> sends cancelByCloid {asset, cloid} and proves it by statuses[0] success", async () => {
    const { a, sent } = hl();
    Object.defineProperty(a, "name", { value: "hyperliquid" });
    const r = await toTradingV2(a, "mainnet").cancelByRef("BTC", { kind: "clientOrderId", value: CLOID });
    expect(sent[0]).toEqual({ type: "cancelByCloid", cancels: [{ asset: 110_005, cloid: CLOID }] });
    expect(r.cancelled).toEqual([{ kind: "clientOrderId", value: CLOID }]);
  });

  it("cancelByCloid per-entry error → ORDER_REJECTED", async () => {
    const { a } = hl();
    (a as unknown as Record<string, unknown>)._signAndSendAction = async () => ({ status: "ok", response: { type: "cancelByCloid", data: { statuses: [{ error: "Order was never placed, already canceled, or filled." }] } } });
    await expect(a.cancelByCloid("BTC", CLOID)).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("status c:<cloid> queries orderStatus with the cloid string; the row's coin / oid / cloid are reported", async () => {
    const queryOrder = vi.fn(async () => ({
      status: "order",
      order: { order: { coin: "xyz:NVDA", oid: 77, cloid: CLOID, origSz: "1.0", sz: "0.4" }, status: "open", statusTimestamp: 1 },
    }));
    const a = { name: "hyperliquid", queryOrder } as unknown as ExchangeAdapter;
    const r = await toTradingV2(a, "mainnet").getOrderStatus("", { kind: "clientOrderId", value: CLOID });
    expect(queryOrder).toHaveBeenCalledWith(CLOID);
    expect(r).toMatchObject({ symbol: "xyz:NVDA", orderId: "77", clientOrderId: CLOID, status: "partiallyFilled", filledSize: "0.6" });
  });

  it("status of an unknown cloid → ORDER_NOT_FOUND", async () => {
    const a = { name: "hyperliquid", queryOrder: async () => ({ status: "unknownOid" }) } as unknown as ExchangeAdapter;
    await expect(toTradingV2(a, "mainnet").getOrderStatus("", { kind: "clientOrderId", value: CLOID }))
      .rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
  });

  it("queryOrder refuses a non-cloid string before any request", async () => {
    const a = new HyperliquidAdapter(undefined, false);
    (a as unknown as Record<string, unknown>)._address = "0xabc";
    const f = vi.spyOn(globalThis, "fetch");
    await expect(a.queryOrder("nope")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
});

function aster() {
  const a = new AsterAdapter(undefined, false);
  const posted: Array<Record<string, unknown>> = [];
  const h = a as unknown as Record<string, unknown>;
  h._resolveSigner = () => ({ tier: "pk", signer: {}, signerAddress: "0xs", userAddress: "0xu" });
  h.computeProtectionPrice = async () => ({ referencePrice: "100", protectionPrice: "100.5", appliedBps: 50 });
  h._symbolPriceFilters = async () => ({ tickSize: "0.1" });
  h._builderParams = async () => ({});
  h._signedPostEip712 = vi.fn(async (_p: string, params: Record<string, unknown>) => {
    posted.push(params);
    return { status: "FILLED", executedQty: "1", orderId: 1, clientOrderId: params.newClientOrderId ?? "venueGenerated" };
  });
  return { a, h, posted };
}

describe("Aster newClientOrderId", () => {
  it("market and limit orders send newClientOrderId", async () => {
    const { a, posted } = aster();
    await a.marketOrder("BTC", "buy", "1", { reduceOnly: false, slippage, clientOrderId: "my.id:1/a_b-c" });
    await a.limitOrder("BTC", "buy", "100.1", "1", { tif: "GTC", clientOrderId: "lim1" });
    expect(posted[0].newClientOrderId).toBe("my.id:1/a_b-c");
    expect(posted[1].newClientOrderId).toBe("lim1");
  });

  it("without a client id nothing is added", async () => {
    const { a, posted } = aster();
    await a.limitOrder("BTC", "buy", "100.1", "1", { tif: "GTC" });
    expect("newClientOrderId" in posted[0]).toBe(false);
  });

  it.each(["has space", "x".repeat(37), "", "a#b"])("invalid id %j → INVALID_PARAMS, nothing sent", async (bad) => {
    const { a, posted } = aster();
    await expect(a.limitOrder("BTC", "buy", "100.1", "1", { clientOrderId: bad })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    await expect(a.cancelOrderByClientId("BTC", bad)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(posted).toHaveLength(0);
  });

  it("the venue's echoed clientOrderId is reported only when one was sent", async () => {
    const { a } = aster();
    Object.defineProperty(a, "name", { value: "aster" });
    const v2 = toTradingV2(a, "mainnet");
    (a as unknown as Record<string, unknown>).getMarkets = async () => [{ symbol: "BTC", stepSize: "0.001" }];
    const lot = await import("../../exchanges/precision.js");
    vi.spyOn(lot, "lotStepOf").mockResolvedValue("0.001");
    const base = { symbol: "BTC", side: "buy" as const, type: "limit" as const, size: "1", price: "100.1", triggerPrice: null, triggerSource: null, tif: "GTC" as const, reduceOnly: false, slippage: null, tpsl: null };
    const withId = await v2.placeOrder({ ...base, clientOrderId: "abc1" });
    const without = await v2.placeOrder({ ...base, clientOrderId: null });
    expect(withId.clientOrderId).toBe("abc1");
    expect(without.clientOrderId).toBeNull();
  });

  it("cancel c:<id> sends DELETE with origClientOrderId and proves CANCELED by the echoed clientOrderId", async () => {
    const { a, h } = aster();
    Object.defineProperty(a, "name", { value: "aster" });
    const del = vi.fn(async () => ({ status: "CANCELED", orderId: 5, clientOrderId: "abc1" }));
    h._signedDeleteEip712 = del;
    const r = await toTradingV2(a, "mainnet").cancelByRef("BTC", { kind: "clientOrderId", value: "abc1" });
    expect((del.mock.calls[0] as unknown[])[1]).toEqual({ symbol: "BTCUSDT", origClientOrderId: "abc1" });
    expect(r.cancelled).toEqual([{ kind: "clientOrderId", value: "abc1" }]);
  });

  it("cancel c:<id> refused with -2011 → ORDER_REJECTED", async () => {
    const { a, h } = aster();
    const { PerpError } = await import("../../errors.js");
    h._signedDeleteEip712 = async () => { throw new PerpError("EXCHANGE_ERROR", "x", { venueCode: -2011 }); };
    await expect(a.cancelOrderByClientId("BTC", "abc1")).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("status c:<id> reads GET /fapi/v3/order by origClientOrderId", async () => {
    const { a, h } = aster();
    Object.defineProperty(a, "name", { value: "aster" });
    const get = vi.fn(async () => ({ orderId: 5, clientOrderId: "abc1", status: "PARTIALLY_FILLED", executedQty: "0.4", avgPrice: "100.2" }));
    h._signedGetEip712 = get;
    const r = await toTradingV2(a, "mainnet").getOrderStatus("BTC", { kind: "clientOrderId", value: "abc1" });
    expect((get.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(["/fapi/v3/order", { symbol: "BTCUSDT", origClientOrderId: "abc1" }]);
    expect(r).toMatchObject({ orderId: "5", clientOrderId: "abc1", status: "partiallyFilled", finality: "final", filledSize: "0.4", avgPrice: "100.2" });
  });

  it("status of an unknown id (-2013 NO_SUCH_ORDER) → ORDER_NOT_FOUND", async () => {
    const { a, h } = aster();
    const { PerpError } = await import("../../errors.js");
    h._signedGetEip712 = async () => { throw new PerpError("EXCHANGE_ERROR", "Order does not exist.", { venueCode: -2013 }); };
    await expect(a.queryOrderRow("BTC", { kind: "clientOrderId", value: "abc1" })).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
  });
});

describe("Lighter cancel by client order index", () => {
  function lighter(row: Record<string, unknown>) {
    const cancelOrder = vi.fn(async () => ({ tx_hash: "0xh" }));
    const a = {
      name: "lighter",
      orderStatusRow: vi.fn(async () => row),
      cancelOrder,
      awaitTxExecuted: vi.fn(async () => {}),
      cancelOutcome: vi.fn(async () => "cancelled"),
    } as unknown as ExchangeAdapter;
    return { a, cancelOrder };
  }

  it("resolves the index to the order id, cancels it per order, reports the client reference", async () => {
    const { a, cancelOrder } = lighter({ order_id: "281474976710700", client_order_index: 424242, status: "open" });
    const r = await toTradingV2(a, "mainnet").cancelByRef("ETH", { kind: "clientOrderId", value: "424242" });
    expect(cancelOrder).toHaveBeenCalledWith("ETH", "281474976710700");
    expect(r.cancelled).toEqual([{ kind: "clientOrderId", value: "424242" }]);
  });

  it("an order the venue lists no longer active → the per-order path's ORDER_NOT_FOUND, nothing cancelled", async () => {
    const { PerpError } = await import("../../errors.js");
    const { a, cancelOrder } = lighter({ order_id: "281474976710700", client_order_index: 424242, status: "filled" });
    cancelOrder.mockRejectedValueOnce(new PerpError("ORDER_NOT_FOUND", "not among the open orders"));
    await expect(toTradingV2(a, "mainnet").cancelByRef("ETH", { kind: "clientOrderId", value: "424242" }))
      .rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
  });
});
