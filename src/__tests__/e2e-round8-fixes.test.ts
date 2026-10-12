/**
 * Live testnet E2E round 8 (2026-10-02): Lighter / Lighter RH spot limit and spot cancel came back
 * finality "pending" (the CLI wrapped the raw sendTx ack) although the venue already had the
 * answer. They are now venue-final the same way as perps: /tx event_info, then the order's own
 * accountOrders row (status + filled_base_amount — never size − remaining).
 *
 * Fixture: GET /api/v1/accountInactiveOrders?account_index=537&market_id=4098 (testnet, read
 * 2026-10-02) — order 577023702256844774 ETH/USDC buy 2565.00 0.0050 (the round-8 s-limit, since
 * cancelled) and 577023702256844775 (the s-buy market IOC, filled).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { LighterAdapter } from "../exchanges/lighter.js";
import { ACCOUNT_ORDERS_FILL_SOURCE, LighterSpotAdapter } from "../exchanges/lighter-spot.js";
import { TX_EVENT_FILL_SOURCE, type SpotOrderResult } from "../exchanges/spot-interface.js";
import type { LighterSpotTestAdapter, LighterTestAdapter } from "./helpers/internals.js";

afterEach(() => { vi.restoreAllMocks(); });

const LIVE_LIMIT_ROW = {
  order_index: 577023702256844800, client_order_index: 145060049461890, order_id: "577023702256844774", client_order_id: "145060049461890",
  market_index: 4098, market_kind: "spot", owner_account_index: 537, initial_base_amount: "0.0050", price: "2565.00",
  remaining_base_amount: "0.0000", is_ask: false, filled_base_amount: "0.0000", filled_quote_amount: "0.000000",
  type: "limit", time_in_force: "good-till-time", status: "canceled", trigger_status: "na",
};
const LIVE_MARKET_ROW = {
  ...LIVE_LIMIT_ROW, order_id: "577023702256844775", client_order_index: 145060018847308, client_order_id: "145060018847308",
  price: "2727.00", filled_base_amount: "0.0050", filled_quote_amount: "13.500000", type: "market", time_in_force: "immediate-or-cancel", status: "filled",
};
const COI = LIVE_LIMIT_ROW.client_order_index;
const executedTx = (eventInfo: Record<string, unknown>) => ({ hash: "h", status: 2, executed_at: 1, event_info: JSON.stringify(eventInfo) });

function build(opts: { rows: Array<Record<string, unknown>>; tx?: Record<string, unknown> | Error; active?: Array<Record<string, unknown>>; inactive?: Array<Record<string, unknown>> }) {
  const lt = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
  lt.name = "lighter";
  lt._testnet = false;
  lt._accountIndex = 537;
  lt._apiKeyIndex = 6;
  const getOrdersByClientIndex = vi.fn(async () => opts.rows);
  lt.getOrdersByClientIndex = getOrdersByClientIndex;
  const signCancelOrder = vi.fn().mockReturnValue({ txType: 15, txInfo: "{}" });
  Object.defineProperty(lt, "signer", { value: { signCancelOrder } });
  // Short poll windows: one /tx read.
  lt.txPollAttempts = () => 1;

  const spot = new LighterSpotAdapter(lt as unknown as LighterAdapter) as unknown as LighterSpotTestAdapter;
  spot._initialized = true;
  (spot._spotMarketMap as Map<string, number>).set("ETH/USDC", 4098);
  (spot._spotBaseMap as Map<string, string>).set("ETH", "ETH/USDC");
  (spot._spotDecimals as Map<string, { size: number; price: number }>).set("ETH/USDC", { size: 4, price: 2 });
  (spot._spotMinSize as Map<string, { base: number; quote: number }>).set("ETH/USDC", { base: 0.005, quote: 10 });
  spot._restGet = vi.fn(async (path: string) => {
    if (path === "/tx") { if (opts.tx instanceof Error) throw opts.tx; return opts.tx ?? { hash: "h", status: 1 }; }
    throw new Error(`unexpected GET ${path}`);
  });
  spot._restGetAuth = vi.fn(async (path: string) => {
    if (path === "/accountActiveOrders") return { orders: opts.active ?? [] };
    if (path === "/accountInactiveOrders") return { orders: opts.inactive ?? [] };
    throw new Error(`unexpected auth GET ${path}`);
  });
  spot._getNextNonce = vi.fn(async () => 110);
  const placeOrder = vi.fn(async () => ({ code: 200, tx_hash: "h", clientOrderIndex: COI }));
  spot._placeOrder = placeOrder;
  spot._sendTx = vi.fn(async () => ({ code: 200, tx_hash: "c" }));
  return { spot, lt, placeOrder, getOrdersByClientIndex, signCancelOrder };
}

describe("Lighter spot limit → venue-final (was pending)", () => {
  it("GTC resting: accountOrders row by client index → final open with the VENUE order id (spot-orders / spot-cancel use it)", async () => {
    const { spot, placeOrder, getOrdersByClientIndex } = build({ rows: [{ ...LIVE_LIMIT_ROW, status: "open", remaining_base_amount: "0.0050" }], tx: executedTx({ to: { i: "577023702256844774", u: COI, is: 50, rs: 50, st: 2 }, ae: "" }) });
    const r = await spot.spotLimitOrder("ETH", "buy", "2565.00", "0.0050", { tif: "GTC" }) as SpotOrderResult;
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ marketIndex: 4098, baseAmount: 50, price: 256500, timeInForce: 1, orderType: 0 }));
    expect(getOrdersByClientIndex).toHaveBeenCalledWith([COI]);
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "577023702256844774", filledSize: "0.0000", receivedToken: null, remediation: null });
  });

  it("a crossing limit the event reports filled → final filled (is, from event_info)", async () => {
    const { spot, getOrdersByClientIndex } = build({ rows: [], tx: executedTx({ to: { i: "577023702256844774", u: COI, is: 50, rs: 0, st: 3 }, ae: "" }) });
    const r = await spot.spotLimitOrder("ETH", "buy", "2800.00", "0.0050") as SpotOrderResult;
    expect(r).toMatchObject({ status: "filled", finality: "final", filledSize: "0.0050", orderId: "577023702256844774" });
    expect(getOrdersByClientIndex).not.toHaveBeenCalled();
  });

  it("a venue-cancelled post-only with a partial fill → final partial from filled_base_amount (never is − rs)", async () => {
    const { spot, placeOrder } = build({ rows: [{ ...LIVE_LIMIT_ROW, status: "canceled-post-only", filled_base_amount: "0.0020" }], tx: executedTx({ to: { i: "577023702256844774", u: COI, is: 50, rs: 0, st: 5 }, ae: "" }) });
    const r = await spot.spotLimitOrder("ETH", "buy", "2565.00", "0.0050", { tif: "ALO" }) as SpotOrderResult;
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ timeInForce: 2 })); // was silently GTT (1)
    expect(r).toMatchObject({ status: "partial", finality: "final", filledSize: "0.0020" });
  });

  it("FOK → CAPABILITY_UNSUPPORTED before anything is sent", async () => {
    const { spot, placeOrder } = build({ rows: [] });
    await expect(spot.spotLimitOrder("ETH", "buy", "2565.00", "0.0050", { tif: "FOK" })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("tx app error → ORDER_REJECTED", async () => {
    const { spot } = build({ rows: [], tx: executedTx({ ae: "not enough balance" }) });
    await expect(spot.spotLimitOrder("ETH", "buy", "2565.00", "0.0050")).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("nothing readable (tx unindexed, no row) → the raw ack (the CLI reports pending, do NOT resubmit)", async () => {
    const { spot } = build({ rows: [], tx: new Error("transaction not found") });
    const r = await spot.spotLimitOrder("ETH", "buy", "2565.00", "0.0050") as Record<string, unknown>;
    expect(r.finality).toBeUndefined();
    expect(r.clientOrderIndex).toBe(COI);
  });

  it("IOC limit: zero fill (terminal row) → ORDER_REJECTED", async () => {
    const { spot } = build({ rows: [{ ...LIVE_LIMIT_ROW, status: "canceled-not-enough-liquidity", time_in_force: "immediate-or-cancel" }], tx: executedTx({ to: { u: COI, is: 50, rs: 0, st: 10 }, ae: "" }) });
    await expect(spot.spotLimitOrder("ETH", "buy", "2565.00", "0.0050", { tif: "IOC" })).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });
});

describe("Lighter spot cancel → venue-final (was pending)", () => {
  const openRow = { ...LIVE_LIMIT_ROW, status: "open", remaining_base_amount: "0.0050" };

  it("live row: canceled → final cancelled, filled 0.0000 (client index read)", async () => {
    const { spot, signCancelOrder, getOrdersByClientIndex } = build({ rows: [LIVE_LIMIT_ROW], active: [openRow], tx: executedTx({}) });
    const r = await spot.spotCancelOrder("ETH", "577023702256844774") as SpotOrderResult;
    expect(signCancelOrder).toHaveBeenCalledWith(expect.objectContaining({ marketIndex: 4098, orderIndex: COI }));
    expect(getOrdersByClientIndex).toHaveBeenCalledWith([COI]);
    expect(r).toMatchObject({ status: "cancelled", finality: "final", orderId: "577023702256844774", filledSize: "0.0000", remediation: null });
  });

  it("filled before the cancel landed → final filled with a note", async () => {
    const { spot } = build({ rows: [{ ...LIVE_LIMIT_ROW, status: "filled", filled_base_amount: "0.0050" }], active: [openRow], tx: executedTx({}) });
    const r = await spot.spotCancelOrder("ETH", "577023702256844774") as SpotOrderResult;
    expect(r).toMatchObject({ status: "filled", finality: "final", filledSize: "0.0050" });
    expect(r.remediation).toMatch(/filled before the cancel/);
  });

  it("no client index → the order's row among the latest inactive orders", async () => {
    const noCoi = { ...LIVE_LIMIT_ROW, client_order_index: 0, client_order_id: "0", order_id: "123456", order_index: 123456 };
    const { spot, getOrdersByClientIndex } = build({ rows: [], active: [{ ...noCoi, status: "open" }], inactive: [noCoi], tx: executedTx({}) });
    // The pre-cancel lookup lists it active (open); after the cancel it is gone from the active list.
    const restGetAuth = spot._restGetAuth as ReturnType<typeof vi.fn>;
    let activeReads = 0;
    restGetAuth.mockImplementation(async (path: string) => {
      if (path === "/accountActiveOrders") return { orders: activeReads++ === 0 ? [{ ...noCoi, status: "open" }] : [] };
      return { orders: [noCoi] };
    });
    const r = await spot.spotCancelOrder("ETH", "123456") as SpotOrderResult;
    expect(getOrdersByClientIndex).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "cancelled", finality: "final", orderId: "123456" });
  });

  it("tx rejected → ORDER_REJECTED (the order is untouched)", async () => {
    const { spot } = build({ rows: [LIVE_LIMIT_ROW], active: [openRow], tx: { hash: "c", status: 0 } });
    await expect(spot.spotCancelOrder("ETH", "577023702256844774")).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("still listed open after the reads → finality pending with a remediation (never a guessed cancelled)", async () => {
    const { spot } = build({ rows: [openRow], active: [openRow], tx: executedTx({}) });
    const r = await spot.spotCancelOrder("ETH", "577023702256844774") as SpotOrderResult;
    expect(r).toMatchObject({ status: "pending", finality: "pending", filledSize: null });
    expect(r.remediation).toMatch(/do NOT resubmit/);
  });
});

describe("Lighter spot market IOC: accountOrders row settles a non-'filled' event", () => {
  const prep = (spot: LighterSpotTestAdapter) => {
    spot._prepareMarketOrder = vi.fn(async () => ({
      resolved: "ETH/USDC", marketId: 4098, baseAmount: 50, priceTicks: 272700, dec: { size: 4, price: 2 },
      protection: { referencePrice: "2700", protectionPrice: "2727", appliedBps: 100 },
    }));
  };
  const slippage = { bps: 100, source: "flag" as const };

  it("filled event (live s-buy) → final filled from event_info", async () => {
    const { spot } = build({ rows: [], tx: executedTx({ to: { i: 577023702256844775, u: 145060018847308, is: 50, rs: 0, st: 3 }, ae: "" }) });
    prep(spot);
    const r = await spot.spotMarketOrder("ETH", "buy", "0.0050", { slippage }) as SpotOrderResult;
    expect(r).toMatchObject({ status: "filled", finality: "final", filledSize: "0.0050" });
    expect((r.venueRaw as { fillSource: string }).fillSource).toBe(TX_EVENT_FILL_SOURCE);
    expect(spot.iocOutcomeOf(r)).toEqual({ filledSize: "0.0050", final: true });
  });

  it("partial fill (cancelled remainder) → final partial from filled_base_amount, iocOutcomeOf reports it", async () => {
    const { spot } = build({ rows: [{ ...LIVE_MARKET_ROW, client_order_index: COI, status: "canceled-not-enough-liquidity", filled_base_amount: "0.0030" }], tx: executedTx({ to: { u: COI, is: 50, rs: 0, st: 10 }, ae: "" }) });
    prep(spot);
    const r = await spot.spotMarketOrder("ETH", "buy", "0.0050", { slippage }) as SpotOrderResult;
    expect(r).toMatchObject({ status: "partial", finality: "final", filledSize: "0.0030" });
    expect((r.venueRaw as { fillSource: string }).fillSource).toBe(ACCOUNT_ORDERS_FILL_SOURCE);
    expect(spot.iocOutcomeOf(r)).toEqual({ filledSize: "0.0030", final: true });
  });
});
