/**
 * Pre-mainnet review — Lighter: H4 (no hardcoded spot decimals), M6 (leverage / withdraw /
 * cancel-all polled to executed), order rows matched by client index + market + created-after-send,
 * getOpenOrders on a market without a positions[] entry, account selection, perp-only cancel-all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LighterAdapter, lighterRowCreatedMs, lighterSelectAccount, LIGHTER_ROW_SKEW_MS,
} from "../../exchanges/lighter.js";
import { LighterSpotAdapter } from "../../exchanges/lighter-spot.js";
import { lighterFamilyNetworks } from "../../exchanges/venues/lighter-family.js";
import { PerpError } from "../../errors.js";
import type { LighterTestAdapter } from "../helpers/internals.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function run<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

describe("H4: no hardcoded spot decimals", () => {
  it("/orderBooks failure → init throws; no market gets { size: 2, price: 4 } from the explorer", async () => {
    const lt = new LighterAdapter("0xabc", false);
    const spot = new LighterSpotAdapter(lt);
    (spot as unknown as { _restGet: () => Promise<unknown> })._restGet = async () => { throw new Error("GET /orderBooks failed (503)"); };
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ symbol: "ETH/USDC", market_index: 2048 }] });
    vi.stubGlobal("fetch", f);
    await expect(spot.init()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    await expect(spot.init()).rejects.toThrow(/refusing to trade without the venue's size \/ price decimals/);
    expect(f).not.toHaveBeenCalled(); // the explorer (which carries no decimals) is not consulted
    expect((spot as unknown as { _spotDecimals: Map<string, unknown> })._spotDecimals.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("a market without venue decimals is refused, never sized on a guess", () => {
    const spot = new LighterSpotAdapter(new LighterAdapter("0xabc", false));
    expect(() => (spot as unknown as { _getDecimals(s: string): unknown })._getDecimals("ETH/USDC")).toThrow(PerpError);
  });

  it("the perp market list never invents decimals: a failed /orderBooks read or a row without decimals throws", async () => {
    const lt = new LighterAdapter("0xabc", true);
    const refresh = () => (lt as unknown as { _refreshMarketMap(): Promise<void> })._refreshMarketMap();
    const calls: string[] = [];
    (lt as unknown as { restGet: (p: string) => Promise<unknown> }).restGet = async (p: string) => { calls.push(p); throw new Error("down"); };
    await expect(refresh()).rejects.toThrow("down");
    expect(calls).toEqual(["/orderBooks"]); // no second endpoint, no retry
    (lt as unknown as { restGet: (p: string) => Promise<unknown> }).restGet = async () => ({ order_books: [{ symbol: "BTC", market_id: 1, market_type: "perp" }] });
    await expect(refresh()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect((lt as unknown as { _marketDecimals: Map<string, unknown> })._marketDecimals.size).toBe(0);
    expect(() => lt.getMarketIndex("BTC")).toThrow(/Unknown Lighter market/);
  });
});

describe("M6: leverage / withdraw are polled to executed, not reported on the sendTx ack", () => {
  function adapter(tx: unknown) {
    const a = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
    a.name = "lighter"; a.venueId = "lighter"; a._testnet = false;
    a._network = lighterFamilyNetworks("lighter").mainnet;
    a._apiKeyIndex = 4; a._accountIndex = 42;
    a.ensureSigner = vi.fn(); a.ensureMarketMap = vi.fn();
    a.getNextNonce = vi.fn().mockResolvedValue(1);
    a.getMarketIndex = vi.fn().mockReturnValue(1);
    a._signer = {
      signUpdateLeverage: vi.fn().mockResolvedValue({ txType: 20, txInfo: "{}" }),
      signWithdraw: vi.fn().mockResolvedValue({ txType: 13, txInfo: "{}" }),
    };
    a.sendTx = vi.fn().mockResolvedValue({ code: 200, tx_hash: "h1" });
    a.restGet = vi.fn(async () => { if (tx instanceof Error) throw tx; return tx; });
    return a;
  }
  const executed = { hash: "h1", status: 2, executed_at: 5, event_info: "{\"ae\":\"\"}" };

  it("executed tx → success", async () => {
    vi.useFakeTimers();
    await expect(run(adapter(executed).updateLeverage("BTC", 5, "cross"))).resolves.toMatchObject({ tx_hash: "h1" });
    await expect(run(adapter(executed).withdraw("10", ""))).resolves.toMatchObject({ tx_hash: "h1" });
  });

  it("tx failed (status 0) or app error → ACTION_REJECTED, not success", async () => {
    vi.useFakeTimers();
    await expect(run(adapter({ hash: "h1", status: 0 }).updateLeverage("BTC", 5, "cross"))).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
    await expect(run(adapter({ ...executed, event_info: "{\"ae\":\"invalid margin mode\"}" }).withdraw("10", ""))).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
  });

  it("tx never executed within the poll window → ORDER_PENDING (unknown), not success", async () => {
    vi.useFakeTimers();
    await expect(run(adapter(new Error("HTTP 400 transaction not found")).updateLeverage("BTC", 5, "cross"))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    await expect(run(adapter({ hash: "h1", status: 1 }).withdraw("10", ""))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("withdraw amount is parsed strictly", async () => {
    const a = adapter(executed);
    await expect(a.withdraw("10abc", "")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(a.sendTx).not.toHaveBeenCalled();
  });
});

describe("order rows: client order index + market + created-after-send", () => {
  const NOW = 1_800_000_000_000;
  const row = (over: Record<string, unknown> = {}) => ({ client_order_index: 5, order_id: "77", market_index: 1, status: "open", filled_base_amount: "0.0", created_at: NOW / 1000, ...over });
  function adapter(rows: unknown[]) {
    const a = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
    a.name = "lighter";
    a.getOrdersByClientIndex = vi.fn().mockResolvedValue(rows);
    return a;
  }
  const match = { marketIndex: 1, sentAtMs: NOW };

  it("created_at is read in seconds, ms or µs", () => {
    expect(lighterRowCreatedMs({ created_at: 1_800_000_000 })).toBe(NOW);
    expect(lighterRowCreatedMs({ created_at: NOW })).toBe(NOW);
    expect(lighterRowCreatedMs({ timestamp: NOW * 1000 })).toBe(NOW);
    expect(lighterRowCreatedMs({})).toBeNull();
  });

  it("our row (same market, created after the send) settles", async () => {
    vi.useFakeTimers();
    await expect(run(adapter([row()]).orderRowOutcome(5, null, "x", () => true, match))).resolves.toMatchObject({ orderId: "77", status: "open" });
  });

  it("a row with the same client index on ANOTHER market is not ours", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(adapter([row({ market_index: 2 })]).orderRowOutcome(5, null, "x", () => true, match))).resolves.toBeNull();
  });

  it("an OLDER order that reused the client index (created before the send) is not ours", async () => {
    vi.useFakeTimers();
    const old = row({ created_at: (NOW - LIGHTER_ROW_SKEW_MS - 60_000) / 1000, status: "filled", filled_base_amount: "1.0" });
    await expect(run(adapter([old]).orderRowOutcome(5, null, "x", () => true, match))).resolves.toBeNull();
    await expect(run(adapter([old, row()]).orderRowOutcome(5, null, "x", () => true, match))).resolves.toMatchObject({ status: "open" });
    await expect(run(adapter([row({ created_at: undefined })]).orderRowOutcome(5, null, "x", () => true, match))).resolves.toBeNull();
  });
});

describe("getOpenOrders: an order on a market without a positions[] entry is still listed", () => {
  it("one accountActiveOrders read for every perp market (no market_id), symbol from market_index", async () => {
    const a = Object.create(LighterAdapter.prototype) as LighterTestAdapter;
    a.name = "lighter"; a._address = "0xabc"; a._accountIndex = 42; a._readOnly = false;
    a._marketMap = new Map([["BTC", 1], ["ETH", 2], ["SOL", 3]]);
    a.ensureMarketMap = vi.fn();
    a.fetchAccount = vi.fn();
    a.restGetAuth = vi.fn(async () => ({ orders: [{ order_id: "9", market_index: 3, is_ask: false, price: "1", initial_base_amount: "1", filled_base_amount: "0", status: "open", type: "limit" }] }));
    const orders = await a.getOpenOrders();
    expect(orders.map(o => [o.orderId, o.symbol])).toEqual([["9", "SOL"]]);
    expect((a.restGetAuth as ReturnType<typeof vi.fn>).mock.calls).toEqual([["/accountActiveOrders", { account_index: "42", market_type: "perp" }]]);
    expect(a.fetchAccount).not.toHaveBeenCalled();
  });
});

describe("account selection: never 'the first account'", () => {
  const accts = [{ account_index: 7, account_type: 1 }, { account_index: 3, account_type: 0 }];
  it("known index → that account or null; one account → it; several → the single main account", () => {
    expect(lighterSelectAccount(accts, 7, "lighter")).toBe(accts[0]);
    expect(lighterSelectAccount(accts, 99, "lighter")).toBeNull();
    expect(lighterSelectAccount([accts[0]], -1, "lighter")).toBe(accts[0]);
    expect(lighterSelectAccount(accts, -1, "lighter")).toBe(accts[1]);
    expect(lighterSelectAccount(undefined, -1, "lighter")).toBeNull();
  });
  it("several accounts and no unique main one → refused", () => {
    expect(() => lighterSelectAccount([{ account_index: 7 }, { account_index: 3 }], -1, "lighter")).toThrow(/refusing to pick one/);
  });
});

describe("spot cancel-all is per spot order (never the account-wide market-255 tx)", () => {
  it("cancels only the listed spot orders", async () => {
    const lt = new LighterAdapter("0xabc", false);
    Object.defineProperty(lt, "isReadOnly", { get: () => false });
    const spot = new LighterSpotAdapter(lt);
    const s = spot as unknown as Record<string, unknown>;
    s.getSpotOpenOrders = vi.fn().mockResolvedValue([{ orderId: "1", symbol: "ETH/USDC" }, { orderId: "2", symbol: "LIT/USDC" }]);
    s.spotCancelOrder = vi.fn().mockResolvedValue({ code: 200 });
    await spot.spotCancelAllOrders(null);
    expect((s.spotCancelOrder as ReturnType<typeof vi.fn>).mock.calls).toEqual([["ETH/USDC", "1"], ["LIT/USDC", "2"]]);
  });
});
