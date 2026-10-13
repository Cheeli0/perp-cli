/**
 * Round-5 testnet E2E findings (2026-10-02). Fixtures are live testnet responses read on 2026-10-02.
 *
 * 1. Lighter / Lighter RH `trade stop` (reduce-only stop below market) came back "accepted / pending"
 *    and stopped the runner although the stop rested — trigger orders now resolve through the same
 *    resolveOrderOutcome / accountOrders path as resting limits (untriggered → final "open"); the
 *    --tp/--sl separate legs too.
 * 2. Pacifica cancel of an already-filled market order: POST /orders/cancel 422
 *    {"error":"Failed to cancel order","code":5} was UNKNOWN → settled from history_by_id: terminal
 *    (filled) → failed (ORDER_REJECTED at the CLI), unknown id (history 404) → failed, else pending.
 * 3. Hyperliquid spot: perp → spot quote move for more than the perp withdrawable → the runner sizes
 *    the move from live balances (or skips the spot phase); the CLI error says what is withdrawable.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../exchanges/venues/index.js";
import { toTradingV2, placeTpSlLeg } from "../exchanges/legacy-trading-v2.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { PacificaAdapter, pacificaCancelRefusalOf } from "../exchanges/pacifica.js";
import { transferShortfallError } from "../exchanges/spot-factory.js";
import { cancelIncompleteError } from "../commands/trade.js";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { planSpotFunding } from "../../scripts/e2e/lib.js";
import type { LighterTestAdapter, PacificaTestAdapter } from "./helpers/internals.js";

afterEach(() => vi.useRealTimers());

async function run<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

// ── 1. Lighter trigger orders ───────────────────────────────────────────────

// GET /api/v1/accountInactiveOrders (lighter testnet, account 537, 2026-10-02): the t-stop order
// (client index 179092073039759) after `flatten` cancelled it. While untriggered the same row is
// listed with status "pending" / "open" (lighter-python Order.status enum) and trigger_status "mark-price".
const LT_STOP_ROW = {
  order_index: 844424931614704, client_order_index: 179092073039759, order_id: "844424931614704", client_order_id: "179092073039759",
  market_index: 4097, market_kind: "perps", owner_account_index: 537, initial_base_amount: "0.091", price: "115.220", nonce: 0,
  remaining_base_amount: "0.000", is_ask: true, base_size: 0, base_price: 115220, filled_base_amount: "0.000", filled_quote_amount: "0.000000",
  side: "", type: "stop-loss", time_in_force: "immediate-or-cancel", reduce_only: true, trigger_price: "115.799", order_expiry: 1793339930504,
  status: "canceled", trigger_status: "mark-price", trigger_time: 0, parent_order_index: 0, parent_order_id: "0",
  created_at: 1790920730,
};
const LT_COI = 179092073039759;
// sendTx ack of the t-stop order (report 2026-10-02T05-54-28-648Z-lighter-testnet).
const LT_ACK = { code: 200, message: "{\"ratelimit\": \"Ratelimit is off\"}", tx_hash: "014328927b29aa2ad700f3c5729997e930f3bc70d0af879879c71cbb4619dc88cf233a9e30c7f830", predicted_execution_time_ms: 1790920730744 };

function ltAdapter(rows: (idx: number[]) => Promise<Array<Record<string, unknown>>>, tx: () => Promise<unknown> = async () => ({ hash: LT_ACK.tx_hash, status: 2, executed_at: 1, event_info: "{\"ae\":\"\"}" })) {
  const a = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
  a.name = "lighter";
  a._testnet = false;
  a._apiKeyIndex = 6;
  a._accountIndex = 537;
  a._marketDecimals = new Map([["SOL", { size: 3, price: 3 }]]);
  a.ensureSigner = vi.fn();
  a.ensureMarketMap = vi.fn();
  a.getMarketIndex = vi.fn().mockReturnValue(4097);
  a.getNextNonce = vi.fn().mockResolvedValue(4);
  a.getReferencePrice = vi.fn().mockResolvedValue(121.2);
  a.signOrder = vi.fn().mockResolvedValue({ txType: 14, txInfo: "{}", txHash: "h" });
  a.sendTx = vi.fn().mockResolvedValue(LT_ACK);
  a.restGet = vi.fn(tx);
  a.getOrdersByClientIndex = vi.fn(rows);
  return a;
}

const stopReq = {
  symbol: "SOL", side: "sell" as const, type: "stopMarket" as const, size: "0.091", price: null, triggerPrice: "115.799",
  triggerSource: null, tif: null, reduceOnly: true, clientOrderId: String(LT_COI), slippage: { bps: 50, source: "default" as const }, tpsl: null,
};

describe("Lighter stop → venue-final via accountOrders", () => {
  for (const status of ["pending", "open"]) {
    it(`untriggered stop row (status "${status}") → final open with the venue order id`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
      const a = ltAdapter(async () => [{ ...LT_STOP_ROW, status }]);
      const r = await run(toTradingV2(a as unknown as ExchangeAdapter, "testnet").placeOrder(stopReq));
      expect(a.getOrdersByClientIndex).toHaveBeenCalledWith([LT_COI]);
      expect(r).toMatchObject({ status: "open", finality: "final", orderId: "844424931614704", clientOrderId: String(LT_COI), filledSize: "0.000" });
      expect(r.execution.method).toBe("trigger");
    });
  }

  it("a canceled trigger row → final cancelled (never open)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
    const a = ltAdapter(async () => [LT_STOP_ROW]);
    const r = await run(toTradingV2(a as unknown as ExchangeAdapter, "testnet").placeOrder(stopReq));
    expect(r).toMatchObject({ status: "cancelled", finality: "final" });
  });

  it("tx rejected → ORDER_REJECTED", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
    const a = ltAdapter(async () => [], async () => ({ hash: LT_ACK.tx_hash, status: 0, executed_at: 0, event_info: "" }));
    await expect(run(toTradingV2(a as unknown as ExchangeAdapter, "testnet").placeOrder(stopReq))).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("row never listed (in-progress / not indexed) → stays accepted / pending", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ltAdapter(async () => [{ ...LT_STOP_ROW, status: "in-progress" }]);
    const r = await run(toTradingV2(a as unknown as ExchangeAdapter, "testnet").placeOrder(stopReq));
    expect(r).toMatchObject({ status: "accepted", finality: "pending" });
    err.mockRestore();
  });
});

describe("Lighter --tp/--sl separate legs → venue-final via accountOrders", () => {
  const leg = { symbol: "SOL", closeSide: "sell" as const, size: "0.091", trigger: "115.799", kind: "sl" as const, limitPrice: null, slippage: { bps: 50, source: "default" as const } };

  it("untriggered leg row → final open", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
    const a = ltAdapter(async idx => [{ ...LT_STOP_ROW, client_order_index: idx[0], status: "pending" }]); // generated client index
    const r = await run(placeTpSlLeg(a as unknown as ExchangeAdapter, "testnet", leg));
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "844424931614704" });
    expect(r.execution.method).toBe("stopLossTrigger");
  });

  it("leg not confirmed → ORDER_PENDING (caller reports ORDER_PARTIAL)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ltAdapter(async () => []);
    await expect(run(placeTpSlLeg(a as unknown as ExchangeAdapter, "testnet", leg))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    err.mockRestore();
  });

  it("leg cancelled by the venue → ORDER_REJECTED (no protection in place)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1790920730_000);
    const a = ltAdapter(async idx => [{ ...LT_STOP_ROW, client_order_index: idx[0], status: "canceled-reduce-only" }]);
    await expect(run(placeTpSlLeg(a as unknown as ExchangeAdapter, "testnet", leg))).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });
});

// ── 2. Pacifica cancel refusal ──────────────────────────────────────────────

const PAC_REFUSAL = "POST /orders/cancel failed (422): {\"success\":false,\"data\":null,\"error\":\"Failed to cancel order\",\"code\":5,\"error_id\":\"unspecified\"}";
// GET https://test-api.pacifica.fi/api/v1/orders/history_by_id?order_id=404335369 (2026-10-02), data rows newest first.
const PAC_FILLED_ROWS = [
  { history_id: 766027310, order_id: 404335369, client_order_id: null, parent_id: null, symbol: "BTC", side: "bid", price: "85726", initial_amount: "0.00013", filled_amount: "0.00013", cancelled_amount: "0", event_type: "fulfill_market", order_type: "market", order_status: "filled", stop_price: null, stop_parent_order_id: null, reduce_only: false, trigger_price_type: null, instrument_type: "perpetual", created_at: 1790921724837 },
  { history_id: 766027308, order_id: 404335369, client_order_id: null, parent_id: null, symbol: "BTC", side: "bid", price: "86583", initial_amount: "0.00013", filled_amount: "0", cancelled_amount: "0", event_type: "make", order_type: "market", order_status: "open", stop_price: null, stop_parent_order_id: null, reduce_only: false, trigger_price_type: null, instrument_type: "perpetual", created_at: 1790921724837 },
];
// GET …/orders/history_by_id?order_id=999999999 → HTTP 404 (as PacificaClient.get throws it).
const PAC_404 = new Error("GET /orders/history_by_id failed (404): {\"success\":false,\"data\":null,\"error\":\"Order history not found for order ID: 999999999\",\"code\":404,\"error_id\":\"unspecified\"}");

function pacAdapter(cancel: () => Promise<unknown>, history: () => Promise<unknown>) {
  const a = Object.create(PacificaAdapter.prototype) as PacificaTestAdapter;
  const client = { cancelOrder: vi.fn(cancel), getOrderHistoryById: vi.fn(history) };
  Object.defineProperty(a, "name", { value: "pacifica" });
  a.client = client;
  a.account = "acct";
  a.signMessage = vi.fn();
  a.ensureSigner = vi.fn();
  // cancelByRef reads the open-orders listing for the order's type (stop ids → /orders/stop/cancel).
  a.getOpenOrders = vi.fn().mockResolvedValue([]);
  return { a, client };
}

describe("pacificaCancelRefusalOf", () => {
  it("filled order → failed with the venue state, never cancelled", () => {
    const r = pacificaCancelRefusalOf("404335369", PAC_REFUSAL, { data: PAC_FILLED_ROWS });
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.error).toMatch(/already filled \(filled 0\.00013/);
  });
  it("unknown id (history 404) → failed", () => {
    const r = pacificaCancelRefusalOf("999999999", PAC_REFUSAL, { error: PAC_404 });
    expect(r).toMatchObject({ kind: "failed" });
    expect(r.kind === "failed" && r.error).toMatch(/does not exist/);
  });
  it("still open / no rows / unreadable → pending", () => {
    expect(pacificaCancelRefusalOf("404335369", PAC_REFUSAL, { data: [PAC_FILLED_ROWS[1]] }).kind).toBe("pending");
    expect(pacificaCancelRefusalOf("404335369", PAC_REFUSAL, { data: [] }).kind).toBe("pending");
    expect(pacificaCancelRefusalOf("404335369", PAC_REFUSAL, { error: new Error("GET /orders/history_by_id failed (500): x") }).kind).toBe("pending");
  });
});

describe("Pacifica cancelByRef: 422 refusal settled from history_by_id", () => {
  const ref = (v: string) => ({ kind: "orderId" as const, value: v });

  it("t-cancel-filled: 422 code 5 + filled history → failed (ORDER_REJECTED at the CLI)", async () => {
    const { a, client } = pacAdapter(async () => { throw new Error(PAC_REFUSAL); }, async () => PAC_FILLED_ROWS);
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").cancelByRef("BTC", ref("404335369"));
    expect(client.getOrderHistoryById).toHaveBeenCalledWith(404335369);
    expect(r.cancelled).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.failed[0].error).toMatch(/already filled/);
    const e = cancelIncompleteError(r, "BTC");
    expect(e?.structured.code).toBe("ORDER_REJECTED");
  });

  it("t-cancel-unknown: refusal + history 404 → failed", async () => {
    const { a } = pacAdapter(async () => { throw new Error(PAC_REFUSAL); }, async () => { throw PAC_404; });
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").cancelByRef("BTC", ref("999999999"));
    expect(r.failed[0].error).toMatch(/does not exist on Pacifica/);
    expect(r.cancelled).toEqual([]);
  });

  it("refusal while history still shows it open → pending (ORDER_PARTIAL), never cancelled", async () => {
    const { a } = pacAdapter(async () => { throw new Error(PAC_REFUSAL); }, async () => [PAC_FILLED_ROWS[1]]);
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").cancelByRef("BTC", ref("404335369"));
    expect(r.cancelled).toEqual([]);
    expect(r.pending?.[0].reason).toMatch(/still open/);
    expect(cancelIncompleteError(r, "BTC")?.structured.code).toBe("ORDER_PARTIAL");
  });

  it("5xx is not a refusal → the error propagates (outcome unknown)", async () => {
    const { a, client } = pacAdapter(async () => { throw new Error("POST /orders/cancel failed (502): bad gateway"); }, async () => PAC_FILLED_ROWS);
    await expect(toTradingV2(a as unknown as ExchangeAdapter, "testnet").cancelByRef("BTC", ref("404335369"))).rejects.toThrow(/502/);
    expect(client.getOrderHistoryById).not.toHaveBeenCalled();
  });
});

// ── 3. Spot transfer sizing ─────────────────────────────────────────────────

describe("spot-transfer shortfall error", () => {
  const base = { venue: "hyperliquid", direction: "to-spot" as const, amount: "28.44", asset: "USDC" };
  it("HL 'Insufficient balance for withdrawal.' → INSUFFICIENT_BALANCE with the perp withdrawable", async () => {
    const e = await transferShortfallError(new Error("Insufficient balance for withdrawal."), { ...base, readAvailable: async () => 15.23 }) as PerpError;
    expect(e.structured.code).toBe("INSUFFICIENT_BALANCE");
    expect(e.message).toMatch(/perp withdrawable is 15\.23 USDC/);
    expect(e.structured.remediation).toMatch(/at most 15\.23 USDC/);
  });
  it("zero of the transfer asset (aster multi-asset margin: USDC held, 0 USDT) → says the account holds no transferable USDT", async () => {
    const venueError = new Error("[-1006] 032206:Transfer amount exceeds the limit for futures account available balance");
    const e = await transferShortfallError(venueError, { venue: "aster", direction: "to-spot", amount: "6", asset: "USDT", readAvailable: async () => 0 }) as PerpError;
    expect(e.structured.code).toBe("INSUFFICIENT_BALANCE");
    expect(e.message).toMatch(/perp withdrawable is 0 USDT/);
    expect(e.structured.details).toMatchObject({ available: "0", asset: "USDT", requested: "6" });
    expect(e.structured.remediation).toMatch(/The perp account holds no transferable USDT/);
    expect(e.structured.remediation).not.toMatch(/Transfer at most/);
  });
  it("the balance read failing is said so (no guessed figure)", async () => {
    const e = await transferShortfallError(new Error("Insufficient balance for withdrawal."), { ...base, readAvailable: async () => { throw new Error("timeout"); } }) as PerpError;
    expect(e.message).toMatch(/could not be read \(timeout\)/);
  });
  it("other errors pass through unchanged", async () => {
    const orig = new PerpError("EXCHANGE_ERROR", "boom");
    expect(await transferShortfallError(orig, { ...base, readAvailable: async () => 1 })).toBe(orig);
  });
});

describe("planSpotFunding (runner)", () => {
  it("round-5 HL testnet: need 28.44, spot 6.90 + perp 15.23 → skip with the shortfall", () => {
    const p = planSpotFunding({ asset: "USDC", need: 28.44, spotAvail: 6.9, perpWithdrawable: 15.23, shared: false });
    expect(p).toEqual({ kind: "skip", reason: "insufficient testnet funds: need 28.44 USDC, have 22.13 USDC (spot 6.90 + perp withdrawable 15.23)" });
  });
  it("enough in total → move only the deficit", () => {
    expect(planSpotFunding({ asset: "USDC", need: 28.44, spotAvail: 6.9, perpWithdrawable: 40, shared: false })).toMatchObject({ kind: "fund", transfer: "21.54" });
  });
  it("spot already funded → a small exercise move (or none when nothing is withdrawable)", () => {
    expect(planSpotFunding({ asset: "USDC", need: 5, spotAvail: 10, perpWithdrawable: 40, shared: false })).toMatchObject({ kind: "fund", transfer: "1.00" });
    expect(planSpotFunding({ asset: "USDC", need: 5, spotAvail: 10, perpWithdrawable: 0, shared: false })).toMatchObject({ kind: "fund", transfer: null });
  });
  it("shared balance: no move; short → skip", () => {
    expect(planSpotFunding({ asset: "USDC", need: 5, spotAvail: 10, perpWithdrawable: 10, shared: true })).toMatchObject({ kind: "fund", transfer: null });
    expect(planSpotFunding({ asset: "USDC", need: 50, spotAvail: 10, perpWithdrawable: 10, shared: true }).kind).toBe("skip");
  });
  it("unreadable balance → throws", () => {
    expect(() => planSpotFunding({ asset: "USDC", need: 5, spotAvail: NaN, perpWithdrawable: 1, shared: false })).toThrow(/spotAvail/);
  });
});
