/**
 * Official Lighter signer (vendored lighter-go v1.0.9 WASM) + the order-path rules that
 * depend on it. The WASM self-tests run the real vendored signer with a generated key —
 * no network (CreateClient url "", explicit nonces).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LighterWasmSigner, lighterSignerDir, LIGHTER_SIGNER_WASM_SHA256, LIGHTER_SIGNER_WASM_EXEC_SHA256, LIGHTER_ALL_MARKETS,
} from "../../exchanges/lighter-signer.js";
import {
  LighterAdapter, lighterTxState, lighterOrderOutcomeOf, lighterOrderSignIndex, lighterOrderIdOf, LIGHTER_TX_STATUS,
} from "../../exchanges/lighter.js";
import { LighterSpotAdapter } from "../../exchanges/lighter-spot.js";
import { LIGHTER_CAPABILITIES } from "../../exchanges/venues/lighter-family.js";
import { createHash } from "node:crypto";

const API_KEY_INDEX = 4;
const ACCOUNT_INDEX = 1;
const A = { apiKeyIndex: API_KEY_INDEX, accountIndex: ACCOUNT_INDEX };

let signer: LighterWasmSigner;

beforeAll(async () => {
  signer = await LighterWasmSigner.load();
  const { privateKey } = signer.generateAPIKey();
  signer.createClient({ privateKey, chainId: 300, ...A });
}, 30_000);

const order = (marketIndex: number, extra: Partial<Parameters<LighterWasmSigner["signCreateOrder"]>[0]> = {}) =>
  signer.signCreateOrder({
    marketIndex, clientOrderIndex: 1, baseAmount: 100, price: 100_000, isAsk: 0, orderType: 0,
    timeInForce: 1, reduceOnly: 0, triggerPrice: 0, orderExpiry: -1, nonce: 1, ...A, ...extra,
  });

describe("vendored signer integrity", () => {
  it("the vendored files match the pinned sha256", () => {
    const dir = lighterSignerDir();
    const h = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
    expect(h("lighter-signer.wasm")).toBe(LIGHTER_SIGNER_WASM_SHA256);
    expect(h("wasm_exec.js")).toBe(LIGHTER_SIGNER_WASM_EXEC_SHA256);
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toContain(LIGHTER_SIGNER_WASM_SHA256);
  });

  it("refuses to load a modified wasm (sha256 mismatch → SIGNATURE_FAILED)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lt-signer-"));
    copyFileSync(join(lighterSignerDir(), "wasm_exec.js"), join(dir, "wasm_exec.js"));
    const wasm = readFileSync(join(lighterSignerDir(), "lighter-signer.wasm"));
    wasm[wasm.length - 1] ^= 0xff;
    writeFileSync(join(dir, "lighter-signer.wasm"), wasm);
    await expect(LighterWasmSigner.load(dir)).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
  });

  it("does not leave the Go exports on globalThis", () => {
    expect((globalThis as Record<string, unknown>).SignCreateOrder).toBeUndefined();
  });
});

describe("official WASM signer self-test (no network)", () => {
  it.each([0, 2048, 4095, 4096, 4097, 4098])("create order on market %i signs", (m) => {
    const r = order(m);
    expect(r.error).toBeUndefined();
    expect(r.txType).toBe(14);
    expect(JSON.parse(r.txInfo).MarketIndex).toBe(m);
  });

  it.each([255, 32768])("market %i is rejected by the signer", (m) => {
    expect(order(m).error).toBeTruthy();
  });

  it.each([2048, 4095])("reduce-only market IOC and stop-loss sign on %i (not treated as spot)", (m) => {
    expect(order(m, { orderType: 1, timeInForce: 0, reduceOnly: 1, orderExpiry: 0 }).error).toBeUndefined();
    const sl = order(m, { orderType: 2, timeInForce: 0, reduceOnly: 1, triggerPrice: 90_000 });
    expect(sl.error).toBeUndefined();
    expect(JSON.parse(sl.txInfo)).toMatchObject({ Type: 2, ReduceOnly: 1, TriggerPrice: 90_000 });
  });

  it("post-only signs time-in-force 2 with a ~28-day expiry", () => {
    const r = order(4095, { timeInForce: 2 });
    const info = JSON.parse(r.txInfo);
    expect(info.TimeInForce).toBe(2);
    expect(info.OrderExpiry).toBeGreaterThan(Date.now() + 27 * 86_400_000);
  });

  it("modify: 15 args — nonce and orderVersion land in Nonce / L2TxAttributes[8]", () => {
    const r = signer.signModifyOrder({ marketIndex: 4095, index: 123, baseAmount: 100, price: 100_000, triggerPrice: 0, nonce: 42, orderVersion: 7, ...A });
    expect(r.error).toBeUndefined();
    expect(r.txType).toBe(17);
    const info = JSON.parse(r.txInfo);
    expect(info).toMatchObject({ MarketIndex: 4095, Index: 123, BaseAmount: 100, Price: 100_000, TriggerPrice: 0, Nonce: 42, AccountIndex: 1, ApiKeyIndex: 4 });
    expect(info.L2TxAttributes).toEqual({ "8": 7 }); // AttributeTypeOrderOrderVersion = 8
    const unversioned = JSON.parse(signer.signModifyOrder({ marketIndex: 4095, index: 123, baseAmount: 100, price: 100_000, triggerPrice: 0, nonce: 43, ...A }).txInfo);
    expect(unversioned.Nonce).toBe(43);
    expect(unversioned.L2TxAttributes).toBeNull();
  });

  it("cancel-all for every market uses cancelAllMarketIndex 255 (no market attribute)", () => {
    const r = signer.signCancelAllOrders({ timeInForce: 0, time: 0, marketIndex: LIGHTER_ALL_MARKETS, nonce: 3, ...A });
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.txInfo)).toMatchObject({ TimeInForce: 0, Time: 0, Nonce: 3, L2TxAttributes: null });
  });

  it("cancel / leverage / withdraw / transfer / auth token sign with explicit nonces", () => {
    expect(JSON.parse(signer.signCancelOrder({ marketIndex: 4095, orderIndex: 77, nonce: 4, ...A }).txInfo)).toMatchObject({ MarketIndex: 4095, Index: 77, Nonce: 4 });
    expect(signer.signUpdateLeverage({ marketIndex: 2048, fraction: 1000, marginMode: 0, nonce: 5, ...A }).error).toBeUndefined();
    expect(JSON.parse(signer.signWithdraw({ usdcAmount: 1_000_000, assetIndex: 3, routeType: 0, nonce: 6, ...A }).txInfo)).toMatchObject({ AssetIndex: 3, Amount: 1_000_000, Nonce: 6 });
    const t = JSON.parse(signer.signTransfer({ toAccountIndex: 1, assetIndex: 3, fromRouteType: 0, toRouteType: 1, amount: 5, usdcFee: 0, memo: "0x" + "00".repeat(32), nonce: 8, ...A }).txInfo);
    expect(t).toMatchObject({ FromRouteType: 0, ToRouteType: 1, Amount: 5, Nonce: 8 });
    expect(signer.createAuthToken(Math.floor(Date.now() / 1000) + 600, API_KEY_INDEX, ACCOUNT_INDEX)).toMatch(/^\d+:1:4:[0-9a-f]+$/);
  });

  it("never lets the signer fetch a nonce itself (-1 / non-integer refused before signing)", () => {
    expect(() => order(4095, { nonce: -1 })).toThrow(/nonce must be explicit/);
    expect(() => order(4095, { baseAmount: 1.5 })).toThrow(/safe integer/);
  });
});

describe("/tx status mapping (0 Failed · 1 Pending · 2 Executed · 3 Pending-final)", () => {
  const tx = (status: unknown, extra: Record<string, unknown> = {}) => ({ hash: "h", status, executed_at: 1, event_info: "", ...extra });
  it.each([
    [tx(0), "rejected"],
    [tx(1), "pending"],
    [tx(2), "executed"],
    [tx(3), "executed"],
    [tx(2, { executed_at: 0 }), "pending"],
    [tx(3, { executed_at: 0 }), "pending"],
    [tx(4), "pending"],
    [tx(5), "pending"],
    [tx(undefined), "pending"],
    [{ code: 21500, message: "transaction not found" }, "pending"],
    [tx(3, { event_info: JSON.stringify({ ae: "order rejected: reduce only increases position" }) }), "rejected"],
    [tx(3, { event_info: JSON.stringify({ ae: "", to: { st: 2 } }) }), "executed"],
  ])("%j → %s", (t, kind) => {
    expect(lighterTxState(t).kind).toBe(kind);
  });
  it("exports the documented codes", () => {
    expect(LIGHTER_TX_STATUS).toEqual({ FAILED: 0, PENDING: 1, EXECUTED: 2, PENDING_FINAL: 3 });
  });
});

describe("order status → final outcome", () => {
  it.each([
    [2, "0", "open"], [2, "0.5", "open"], [1, "0", "open"],
    [3, "1", "filled"], [4, "0", "cancelled"], [5, "0", "cancelled"], [12, "0.2", "partiallyFilled"],
    ["open", "0", "open"], ["filled", "1", "filled"], ["canceled-post-only", "0", "cancelled"],
  ])("st %j filled %s → %s", (st, filled, status) => {
    expect(lighterOrderOutcomeOf(st, filled, "9", "event_info")).toMatchObject({ status, final: true });
  });
  it.each([0, "in-progress", 99, "weird"])("%j is not final → null", (st) => {
    expect(lighterOrderOutcomeOf(st, "0", null, "event_info")).toBeNull();
  });
});

describe("cancel / modify index selection (never a bigint, never a different order)", () => {
  it("prefers the client order index", () => {
    expect(lighterOrderSignIndex({ order_id: "281474976710657", order_index: 281474976710657, client_order_index: 179063628209702, client_order_id: "179063628209702" }, "lighter")).toBe(179063628209702);
  });
  it("falls back to the exact order id when the client index is 0", () => {
    expect(lighterOrderSignIndex({ order_id: "562949953421306", client_order_index: 0, client_order_id: "0" }, "lighter")).toBe(562949953421306);
  });
  it("refuses an order id that is not exactly representable when the client index is 0", () => {
    expect(() => lighterOrderSignIndex({ order_id: "9007199254740993", client_order_index: 0 }, "lighter")).toThrow(/not exactly representable/);
    expect(() => lighterOrderSignIndex({ order_index: 2 ** 60, client_order_index: 0 }, "lighter")).toThrow();
  });
  it("order ids are surfaced as exact strings", () => {
    expect(lighterOrderIdOf({ order_id: "9007199254740993", order_index: 9007199254740992 })).toBe("9007199254740993");
    expect(lighterOrderIdOf({ order_index: 12 })).toBe("12");
  });

  const buildAdapter = (rows: unknown[]) => {
    const a = Object.create(LighterAdapter.prototype);
    a.name = "lighter";
    a._apiKeyIndex = 4;
    a._accountIndex = 42;
    a.ensureSigner = vi.fn();
    a.ensureMarketMap = vi.fn();
    a.getMarketIndex = vi.fn().mockReturnValue(4095);
    a.getNextNonce = vi.fn().mockResolvedValue(9);
    a.restGetAuth = vi.fn().mockResolvedValue({ code: 200, orders: rows });
    a.toTicks = vi.fn().mockReturnValue({ baseAmount: 100, priceTicks: 3000 });
    a.sendTx = vi.fn().mockResolvedValue({ code: 200, tx_hash: "h" });
    a._marketDecimals = new Map(); // no decimals loaded → the modify outcome is not resolved (no reads)
    a._signer = {
      signCancelOrder: vi.fn().mockReturnValue({ txType: 15, txInfo: "{}", txHash: "h" }),
      signModifyOrder: vi.fn().mockReturnValue({ txType: 17, txInfo: "{}", txHash: "h" }),
      signCancelAllOrders: vi.fn().mockReturnValue({ txType: 16, txInfo: "{}", txHash: "h" }),
    };
    return a;
  };
  const row = { order_id: "9007199254740993", order_index: 9007199254740992, client_order_index: 123, client_order_id: "123", is_ask: false, type: "limit", trigger_price: "0" };

  it("cancelOrder signs with the row's client order index", async () => {
    const a = buildAdapter([row]);
    await a.cancelOrder("ETH", "9007199254740993");
    expect(a._signer.signCancelOrder).toHaveBeenCalledWith(expect.objectContaining({ marketIndex: 4095, orderIndex: 123, nonce: 9 }));
    expect(typeof a._signer.signCancelOrder.mock.calls[0][0].orderIndex).toBe("number");
  });

  it("cancelOrder: an order not listed open → ORDER_NOT_FOUND, nothing signed", async () => {
    const a = buildAdapter([row]);
    await expect(a.cancelOrder("ETH", "1")).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    expect(a._signer.signCancelOrder).not.toHaveBeenCalled();
  });

  it("cancelOrder: client index 0 and an unrepresentable id → INVALID_PARAMS, nothing signed", async () => {
    const a = buildAdapter([{ ...row, client_order_index: 0, client_order_id: "0" }]);
    await expect(a.cancelOrder("ETH", "9007199254740993")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(a._signer.signCancelOrder).not.toHaveBeenCalled();
  });

  it("cancelOrder: a signer error is not sent", async () => {
    const a = buildAdapter([row]);
    a._signer.signCancelOrder = vi.fn().mockReturnValue({ txType: NaN, txInfo: "", txHash: "", error: "bad" });
    await expect(a.cancelOrder("ETH", "9007199254740993")).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
    expect(a.sendTx).not.toHaveBeenCalled();
  });

  it("modifyOrder signs with the client order index and orderVersion 0", async () => {
    const a = buildAdapter([row]);
    await a.modifyOrder("ETH", "9007199254740993", "3000", "0.01");
    expect(a._signer.signModifyOrder).toHaveBeenCalledWith(expect.objectContaining({ index: 123, nonce: 9, orderVersion: 0, triggerPrice: 0 }));
  });

  it("cancel-all never signs the account-wide CancelAllOrders tx (market 255 would also cancel spot orders)", async () => {
    const a = buildAdapter([]);
    a.getOpenOrders = vi.fn().mockResolvedValue([]);
    await a.cancelAllOrders();
    expect(a._signer.signCancelAllOrders).not.toHaveBeenCalled();
  });
});

/** Trimmed live testnet `/orderBooks` (2026-10-02): perps 4095–4097, spot 4098/4099. */
const TESTNET_ORDER_BOOKS = {
  code: 200,
  order_books: [
    { symbol: "ETH", market_id: 4095, market_type: "perp", status: "active", supported_size_decimals: 4, supported_price_decimals: 2, min_base_amount: "0.005", min_quote_amount: "10" },
    { symbol: "BTC", market_id: 4096, market_type: "perp", status: "active", supported_size_decimals: 5, supported_price_decimals: 1, min_base_amount: "0.0002", min_quote_amount: "10" },
    { symbol: "SOL", market_id: 4097, market_type: "perp", status: "active", supported_size_decimals: 3, supported_price_decimals: 3, min_base_amount: "0.05", min_quote_amount: "10" },
    { symbol: "ETH/USDC", market_id: 4098, market_type: "spot", status: "active", supported_size_decimals: 4, supported_price_decimals: 2, min_base_amount: "0.005", min_quote_amount: "10" },
    { symbol: "LIT/USDC", market_id: 4099, market_type: "spot", status: "active", supported_size_decimals: 2, supported_price_decimals: 4, min_base_amount: "1", min_quote_amount: "10" },
  ],
};

describe("market map by market_type (testnet ids ≥ 2048 are perps)", () => {
  it("perp map = 4095–4097; spot markets excluded", async () => {
    const a = new LighterAdapter("", true);
    (a as unknown as { restGet: () => Promise<unknown> }).restGet = async () => TESTNET_ORDER_BOOKS;
    await (a as unknown as { _refreshMarketMap: () => Promise<void> })._refreshMarketMap();
    expect([...(a as unknown as { _marketMap: Map<string, number> })._marketMap.entries()]).toEqual([["ETH", 4095], ["BTC", 4096], ["SOL", 4097]]);
  });

  it("spot map = 4098/4099 only", async () => {
    const lt = new LighterAdapter("", true);
    const spot = new LighterSpotAdapter(lt);
    (spot as unknown as { _restGet: () => Promise<unknown> })._restGet = async () => TESTNET_ORDER_BOOKS;
    await spot.init();
    expect(spot.getSpotMarketId("ETH/USDC")).toBe(4098);
    expect(spot.getSpotMarketId("LIT/USDC")).toBe(4099);
    expect(spot.getSpotMarketId("ETH")).toBe(4098);
    expect(spot.getSpotMarketId("SOL/USDC")).toBeUndefined();
  });
});

describe("post-only (ALO) → time-in-force 2", () => {
  it("is declared in the capabilities", () => {
    expect(LIGHTER_CAPABILITIES.timeInForce).toContain("ALO");
  });

  const build = (eventTo: Record<string, unknown>) => {
    const a = Object.create(LighterAdapter.prototype);
    a.name = "lighter";
    a._testnet = false;
    a._marketDecimals = new Map([["ETH", { size: 4, price: 2 }]]);
    a.ensureSigner = vi.fn();
    a.ensureMarketMap = vi.fn();
    a.getNextNonce = vi.fn().mockResolvedValue(1);
    a.getMarketIndex = vi.fn().mockReturnValue(4095);
    a.toTicks = vi.fn().mockReturnValue({ baseAmount: 100, priceTicks: 300000 });
    a.signOrder = vi.fn().mockResolvedValue({ txType: 14, txInfo: "{}", txHash: "h" });
    a.sendTx = vi.fn().mockResolvedValue({ code: 200, tx_hash: "h" });
    a.restGet = vi.fn().mockResolvedValue({ hash: "h", status: 3, executed_at: 1, event_info: JSON.stringify({ to: eventTo, ae: "" }) });
    a.getOrdersByClientIndex = vi.fn().mockRejectedValue(new Error("not used"));
    return a;
  };

  it("limitOrder ALO signs timeInForce 2 and resolves a resting order to final open (filled from accountOrders)", async () => {
    const a = build({ i: 281474976710657, u: 5, is: 100, rs: 100, st: 2 });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ market_index: 4095, created_at: Math.floor(Date.now() / 1000), client_order_index: 5, order_id: "281474976710657", status: "open", filled_base_amount: "0.0000" }]);
    const raw = await a.limitOrder("ETH", "buy", "3000", "0.01", { tif: "ALO", clientOrderIndex: 5 });
    expect(a.signOrder).toHaveBeenCalledWith(expect.objectContaining({ timeInForce: 2, orderType: 0, orderExpiry: -1 }));
    expect(a.orderOutcomeOf(raw)).toEqual({ status: "open", final: true, venueStatus: "open", filledSize: "0.0000", orderId: "281474976710657", source: "accountOrders" });
  });

  it("a crossing post-only cancelled by the venue resolves to final cancelled (canceled-post-only), filled 0 — never is − rs", async () => {
    const a = build({ i: 7, u: 5, is: 100, rs: 0, st: 5 });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ market_index: 4095, created_at: Math.floor(Date.now() / 1000), client_order_index: 5, order_id: "7", status: "canceled-post-only", remaining_base_amount: "0.0000", filled_base_amount: "0.0000" }]);
    const raw = await a.limitOrder("ETH", "buy", "3000", "0.01", { tif: "ALO", clientOrderIndex: 5 });
    expect(a.orderOutcomeOf(raw)).toMatchObject({ status: "cancelled", venueStatus: "canceled-post-only", filledSize: "0.0000", final: true });
  });

  it("an event for another order falls back to accountOrders by client order index", async () => {
    const a = build({ i: 7, u: 999, is: 100, rs: 0, st: 3 });
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue([{ market_index: 4095, created_at: Math.floor(Date.now() / 1000), client_order_index: 5, order_id: "8", status: "filled", filled_base_amount: "0.01" }]);
    const raw = await a.limitOrder("ETH", "buy", "3000", "0.01", { tif: "GTC", clientOrderIndex: 5 });
    expect(a.getOrdersByClientIndex).toHaveBeenCalledWith([5]);
    expect(a.orderOutcomeOf(raw)).toMatchObject({ status: "filled", filledSize: "0.01", orderId: "8", source: "accountOrders" });
  });

  it("a tx app error (`ae`) → ORDER_REJECTED", async () => {
    const a = build({});
    a.restGet = vi.fn().mockResolvedValue({ hash: "h", status: 2, executed_at: 1, event_info: JSON.stringify({ ae: "not enough margin" }) });
    await expect(a.limitOrder("ETH", "buy", "3000", "0.01", { tif: "GTC", clientOrderIndex: 5 })).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });
});

describe("TradingV2: a resting Lighter limit is final open (not pending)", () => {
  const v2With = async (raw: unknown) => {
    await import("../../exchanges/venues/index.js");
    const { toTradingV2 } = await import("../../exchanges/legacy-trading-v2.js");
    const limitOrder = vi.fn().mockResolvedValue(raw);
    const adapter = {
      name: "lighter",
      limitOrder,
      getMarkets: vi.fn().mockResolvedValue([{ symbol: "ETH", stepSize: null, sizeDecimals: 4 }]),
    };
    return { v2: toTradingV2(adapter as never, "testnet"), limitOrder };
  };
  const req = (tif: "GTC" | "ALO") => ({
    symbol: "ETH", side: "buy" as const, type: "limit" as const, size: "0.01", price: "3000", triggerPrice: null,
    triggerSource: null, tif, reduceOnly: false, clientOrderId: "5", slippage: null, tpsl: null,
  });

  it("orderOutcome open → status open, finality final, venue order id", async () => {
    const { v2 } = await v2With({ code: 200, tx_hash: "h", clientOrderIndex: 5, orderOutcome: { status: "open", final: true, venueStatus: "open", filledSize: "0", orderId: "281474976710657", source: "event_info" } });
    const r = await v2.placeOrder(req("GTC"));
    expect(r).toMatchObject({ status: "open", finality: "final", orderId: "281474976710657", clientOrderId: "5", filledSize: "0" });
  });

  it("ALO is sent as POST_ONLY; a canceled-post-only outcome is final cancelled", async () => {
    const { v2, limitOrder } = await v2With({ code: 200, tx_hash: "h", clientOrderIndex: 5, orderOutcome: { status: "cancelled", final: true, venueStatus: "canceled-post-only", filledSize: "0", orderId: "7", source: "event_info" } });
    const r = await v2.placeOrder(req("ALO"));
    expect(limitOrder).toHaveBeenCalledWith("ETH", "buy", "3000", "0.01", expect.objectContaining({ tif: "ALO", clientOrderIndex: 5 }));
    expect(r).toMatchObject({ status: "cancelled", finality: "final" });
    expect(r.execution?.tifSent).toBe("POST_ONLY");
  });

  it("no orderOutcome → accepted / pending (never guessed)", async () => {
    const { v2 } = await v2With({ code: 200, tx_hash: "h", clientOrderIndex: 5 });
    expect(await v2.placeOrder(req("GTC"))).toMatchObject({ status: "accepted", finality: "pending" });
  });
});
