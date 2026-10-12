/**
 * Lighter limit IOC no-match must resolve venue-final (live testnet E2E 2026-10-02, step
 * t-ioc-nomatch: `trade limit SOL sell 128.025 0.091 --tif IOC` came back accepted / pending,
 * orderId null, "status cannot be queried per order"). /tx did not settle within the poll window,
 * so the adapter never read accountOrders; and the TradingV2 status poll had no Lighter query.
 * Fixture: the live accountOrders row of that order (client index 179092261145328).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../../exchanges/venues/index.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { placeAndConfirm } from "../../exchanges/trading-v2.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import type { LighterTestAdapter } from "../helpers/internals.js";

afterEach(() => vi.useRealTimers());

async function run<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

// GET /api/v1/accountOrders?account_index=537&client_order_indexes=179092261145328 (testnet), read 2026-10-02
const IOC_NOMATCH_ROW = {
  order_index: 844424931627108, client_order_index: 179092261145328, order_id: "844424931627108",
  client_order_id: "179092261145328", market_index: 4097, market_kind: "perps", owner_account_index: 537,
  initial_base_amount: "0.091", price: "128.025", nonce: 1495140, remaining_base_amount: "0.000", is_ask: true,
  base_size: 0, base_price: 128025, filled_base_amount: "0.000", filled_quote_amount: "0.000000", side: "",
  type: "limit", time_in_force: "immediate-or-cancel", reduce_only: false, trigger_price: "0.000", order_expiry: 0,
  status: "canceled-not-enough-liquidity", trigger_status: "na", trigger_time: 0, parent_order_index: 0,
  parent_order_id: "0", to_trigger_order_id_0: "0", to_trigger_order_id_1: "0", to_cancel_order_id_0: "0",
  integrator_fee_collector_index: "0", integrator_taker_fee: "0", integrator_maker_fee: "0", order_flags: 0,
  block_height: 30796, timestamp: 1790922610, created_at: 1790922610, updated_at: 1790922610,
  transaction_time: 1790922611803718, order_version: 0,
};
const COI = 179092261145328;
// sendTx ack of that order (the E2E envelope's venueRaw)
const SEND_ACK = { code: 200, message: "{\"ratelimit\": \"Ratelimit is off\"}", tx_hash: "c8812dd210321edc1b3dca64cf60733c9ff89b7eee090f2247a7de5276f50e5b036fa61c5a21d72e", predicted_execution_time_ms: 1790922611798 };

function ltAdapter(rows: unknown[]) {
  const a = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
  a.name = "lighter";
  a._testnet = true;
  a._accountIndex = 537;
  a._marketDecimals = new Map([["SOL", { size: 3, price: 3 }]]);
  a.ensureSigner = vi.fn();
  a.ensureMarketMap = vi.fn();
  a.getNextNonce = vi.fn().mockResolvedValue(1);
  a.getMarketIndex = vi.fn().mockReturnValue(4097);
  a.toTicks = vi.fn().mockReturnValue({ baseAmount: 91, priceTicks: 128025 });
  a.signOrder = vi.fn().mockResolvedValue({ txType: 14, txInfo: "{}", txHash: SEND_ACK.tx_hash });
  a.sendTx = vi.fn().mockResolvedValue(SEND_ACK);
  // /tx never settles within the poll window (not indexed yet)
  a.restGet = vi.fn().mockRejectedValue(new Error("HTTP 400 transaction not found"));
  a.getOrdersByClientIndex = vi.fn().mockResolvedValue(rows);
  return a;
}

describe("t-ioc-nomatch: limit IOC far from market", () => {
  it("/tx unsettled, accountOrders canceled-not-enough-liquidity filled 0 → ORDER_REJECTED (definite no-fill)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790922610_000);
    const a = ltAdapter([IOC_NOMATCH_ROW]);
    await expect(run(a.limitOrder("SOL", "sell", "128.025", "0.091", { tif: "IOC", clientOrderIndex: COI })))
      .rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
    expect(a.getOrdersByClientIndex).toHaveBeenCalledWith([COI]);
  });

  it("/tx unsettled and the row still open → no iocOutcome (never a guessed outcome)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790922610_000);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ltAdapter([{ ...IOC_NOMATCH_ROW, status: "open", remaining_base_amount: "0.091" }]);
    const raw = await run(a.limitOrder("SOL", "sell", "128.025", "0.091", { tif: "IOC", clientOrderIndex: COI })) as Record<string, unknown>;
    expect(raw.iocOutcome).toBeUndefined();
    err.mockRestore();
  });
});

describe("Lighter TradingV2 getOrderStatus (accountOrders)", () => {
  it("c:<clientOrderIndex> → the live row: cancelled, filled 0.000, final, the venue order id", async () => {
    const a = ltAdapter([IOC_NOMATCH_ROW]);
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").getOrderStatus("SOL", { kind: "clientOrderId", value: String(COI) });
    expect(r).toMatchObject({ status: "cancelled", finality: "final", orderId: "844424931627108", clientOrderId: String(COI), filledSize: "0.000" });
    expect(r.execution.notes).toContain('venue status "canceled-not-enough-liquidity"');
  });

  it("not listed → ORDER_NOT_FOUND; a failed read throws", async () => {
    const a = ltAdapter([]);
    const v2 = toTradingV2(a as unknown as ExchangeAdapter, "testnet");
    await expect(v2.getOrderStatus("SOL", { kind: "clientOrderId", value: String(COI) })).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    a.getOrdersByClientIndex = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    await expect(v2.getOrderStatus("SOL", { kind: "clientOrderId", value: String(COI) })).rejects.toThrow("HTTP 500");
  });

  it("order id → active orders, then inactive orders", async () => {
    const a = ltAdapter([]);
    a.restGetAuth = vi.fn()
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValueOnce({ code: 200, orders: [IOC_NOMATCH_ROW] });
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").getOrderStatus("SOL", { kind: "orderId", value: "844424931627108" });
    expect(r).toMatchObject({ status: "cancelled", finality: "final", filledSize: "0.000" });
    expect((a.restGetAuth as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual(["/accountActiveOrders", "/accountInactiveOrders"]);
  });

  it("an in-progress row → accepted / pending", async () => {
    const a = ltAdapter([{ ...IOC_NOMATCH_ROW, status: "in-progress" }]);
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").getOrderStatus("SOL", { kind: "clientOrderId", value: String(COI) });
    expect(r).toMatchObject({ status: "accepted", finality: "pending", filledSize: null });
  });
});

describe("placeAndConfirm: an unresolved Lighter IOC ack settles through the status poll", () => {
  it("adapter returned the bare ack → polled by c:<coi> → cancelled, filled 0, final, no remediation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790922610_000);
    const a = ltAdapter([IOC_NOMATCH_ROW]);
    a.limitOrder = vi.fn().mockResolvedValue({ ...SEND_ACK, clientOrderIndex: COI });
    (a as unknown as { getMarkets: unknown }).getMarkets = vi.fn().mockResolvedValue([{ symbol: "SOL", stepSize: "0.001", sizeDecimals: 3 }]);
    const v2 = toTradingV2(a as unknown as ExchangeAdapter, "testnet");
    const r = await run(placeAndConfirm(v2, requireCapabilities(getVenue("lighter")), {
      symbol: "SOL", side: "sell", type: "limit", size: "0.091", price: "128.025", triggerPrice: null, triggerSource: null,
      tif: "IOC", reduceOnly: false, clientOrderId: String(COI), slippage: null, tpsl: null,
    }));
    expect(r).toMatchObject({ status: "cancelled", finality: "final", filledSize: "0.000", orderId: "844424931627108", remediation: null });
  });
});
