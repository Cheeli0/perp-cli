/**
 * Read-only sweep of v0.14.0 (2026-10-13) found two history reads returning an empty list while
 * the venue held rows:
 *
 * 1. Aster `account trades` / `trade fills`: GET /fapi/v3/userTrades requires `symbol`, and the
 *    adapter queried only symbols with an open position (else a hardcoded BTCUSDT), swallowing
 *    every error. Symbols now also come from GET /fapi/v3/income COMMISSION rows (venue default
 *    window: recent 7 days), and a failed read throws.
 * 2. Pacifica `account history`: PacificaClient.get already unwraps `{success, data}`, and the
 *    adapter read `.data ?? .orders ?? []` off the unwrapped list → always [].
 */
import { describe, it, expect, vi } from "vitest";
import { PacificaAdapter } from "../../exchanges/pacifica.js";

async function asterAdapter(routes: Record<string, (params: Record<string, string>) => unknown>, positions: Array<{ symbol: string }> = []) {
  const { AsterAdapter } = await import("../../exchanges/aster.js");
  const ast = new AsterAdapter(undefined, false);
  const t = ast as unknown as Record<string, unknown>;
  t._resolveSigner = vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
  t.getPositions = vi.fn().mockResolvedValue(positions);
  const signed = vi.fn(async (path: string, params: Record<string, string>) => {
    const route = routes[path] ?? (path === "/fapi/v3/openOrders" ? () => [] : undefined);
    if (!route) throw new Error(`unexpected ${path}`);
    return route(params);
  });
  t._signedGetEip712 = signed;
  return { ast, signed };
}

const trade = (symbol: string, time: number, buyer: boolean) =>
  ({ symbol, time, buyer, price: "108.29", qty: "0.06", commission: "0.0026" });

describe("AsterAdapter.getOrderHistory — same symbol discovery, no hard-coded list", () => {
  const order = (symbol: string, time: number, side = "BUY") =>
    ({ symbol, time, side, orderId: time, price: "100", origQty: "1", executedQty: "1", status: "FILLED", type: "LIMIT", stopPrice: "0" });

  it("queries the income symbols (not BTC/ETH/SOL/BNB/XRP) and sorts newest first", async () => {
    const { ast, signed } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "DOGEUSDT", time: 1 }],
      "/fapi/v3/allOrders": () => [order("DOGEUSDT", 1), order("DOGEUSDT", 5, "SELL")],
    });
    const rows = await ast.getOrderHistory(30);
    expect(rows.map((o) => [o.symbol, o.orderId, o.side])).toEqual([["DOGE", "5", "sell"], ["DOGE", "1", "buy"]]);
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/allOrders").map((c) => c[1].symbol)).toEqual(["DOGEUSDT"]);
  });

  it("a failed allOrders read throws instead of being skipped", async () => {
    const { ast } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "DOGEUSDT", time: 1 }],
      "/fapi/v3/allOrders": () => { throw new Error("HTTP 418"); },
    });
    await expect(ast.getOrderHistory(30)).rejects.toThrow("418");
  });

  it("income is paged back from now in 1000-row pages (endTime = oldest − 1) until a short page", async () => {
    const now = Date.now();
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ symbol: "SOLUSDT", time: now - i })),
      [{ symbol: "ETHUSDT", time: now - 5000 }],
    ];
    const { ast, signed } = await asterAdapter({
      "/fapi/v3/income": () => pages.shift()!,
      "/fapi/v3/allOrders": () => [],
    });
    await ast.getOrderHistory(30);
    const incomeCalls = signed.mock.calls.filter((c) => c[0] === "/fapi/v3/income").map((c) => c[1]);
    expect(incomeCalls).toHaveLength(2);
    expect(Number(incomeCalls[1].endTime)).toBe(now - 999 - 1);
    expect(Number(incomeCalls[0].startTime)).toBe(Number(incomeCalls[1].startTime));
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/allOrders").map((c) => c[1].symbol).sort()).toEqual(["ETHUSDT", "SOLUSDT"]);
  });

  it("more pages than ASTER_INCOME_MAX_PAGES → EXCHANGE_ERROR, never a partial symbol set", async () => {
    let t = Date.now();
    const { ast } = await asterAdapter({ "/fapi/v3/income": () => Array.from({ length: 1000 }, () => ({ symbol: "SOLUSDT", time: t-- })) });
    await expect(ast.getOrderHistory(30)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("symbols with open orders but no fills / position are included (GET /fapi/v3/openOrders)", async () => {
    const { ast, signed } = await asterAdapter({
      "/fapi/v3/openOrders": () => [{ symbol: "XRPUSDT" }],
      "/fapi/v3/income": () => [],
      "/fapi/v3/allOrders": () => [order("XRPUSDT", 9)],
    });
    expect((await ast.getOrderHistory(30)).map((o) => o.symbol)).toEqual(["XRP"]);
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/allOrders").map((c) => c[1].symbol)).toEqual(["XRPUSDT"]);
  });
});

describe("AsterAdapter.getTradeHistory — symbols from income, never a guess", () => {
  it("finds fills on symbols without an open position via COMMISSION income rows", async () => {
    const { ast, signed } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 1, incomeType: "COMMISSION" }, { symbol: "SOLUSDT", time: 1 }, { symbol: "ETHUSDT", time: 1 }],
      "/fapi/v3/userTrades": (p) => (p.symbol === "SOLUSDT" ? [trade("SOLUSDT", 2, false), trade("SOLUSDT", 1, true)] : [trade("ETHUSDT", 3, true)]),
    });
    const rows = await ast.getTradeHistory(30);
    expect(rows.map((r) => [r.symbol, r.time, r.side])).toEqual([["ETH", 3, "buy"], ["SOL", 2, "sell"], ["SOL", 1, "buy"]]);
    const queried = signed.mock.calls.filter((c) => c[0] === "/fapi/v3/userTrades").map((c) => c[1].symbol).sort();
    expect(queried).toEqual(["ETHUSDT", "SOLUSDT"]);
    expect(queried).not.toContain("BTCUSDT");
  });

  it("no positions and no income → empty list without a BTCUSDT guess", async () => {
    const { ast, signed } = await asterAdapter({ "/fapi/v3/income": () => [] });
    expect(await ast.getTradeHistory(30)).toEqual([]);
    expect(signed.mock.calls.some((c) => c[0] === "/fapi/v3/userTrades")).toBe(false);
  });

  it("a failed userTrades read throws instead of being skipped", async () => {
    const { ast } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 1 }],
      "/fapi/v3/userTrades": () => { throw new Error("HTTP 429"); },
    });
    await expect(ast.getTradeHistory(30)).rejects.toThrow("429");
  });

  it("a row missing a field is an EXCHANGE_ERROR, not a zero", async () => {
    const { ast } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 1 }],
      "/fapi/v3/userTrades": () => [{ symbol: "SOLUSDT", time: 1, buyer: true, qty: "1", commission: "0" }],
    });
    await expect(ast.getTradeHistory(30)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

function pacAdapter(getOrderHistory: () => Promise<unknown>) {
  const a = Object.create(PacificaAdapter.prototype) as Record<string, unknown>;
  a._hasRealKey = true;
  a.account = "acct";
  a.client = { getOrderHistory: vi.fn(getOrderHistory) };
  return a as unknown as PacificaAdapter;
}

// GET https://api.pacifica.fi/api/v1/orders/history row (2026-10-13), as PacificaClient.get returns it (unwrapped).
const PAC_ROW = {
  order_id: 13484908342, client_order_id: null, symbol: "ETH", side: "bid", initial_price: "2523.8",
  average_filled_price: "2511.2", amount: "0.0042", filled_amount: "0.0042", order_status: "filled",
  order_type: "market", stop_price: null, reduce_only: true, created_at: 1791827683658,
};

describe("PacificaAdapter.getOrderHistory — reads the unwrapped list", () => {
  it("maps the venue rows (previously always []) and passes the limit", async () => {
    const a = pacAdapter(async () => [PAC_ROW, { ...PAC_ROW, order_id: 2, side: "ask", stop_price: "2400" }]);
    const rows = await a.getOrderHistory(30);
    expect((a as unknown as { client: { getOrderHistory: ReturnType<typeof vi.fn> } }).client.getOrderHistory).toHaveBeenCalledWith("acct", { limit: 30 });
    expect(rows).toEqual([
      { orderId: "13484908342", symbol: "ETH", side: "buy", price: "2523.8", size: "0.0042", filled: "0.0042", status: "filled", type: "market", triggerPrice: null },
      { orderId: "2", symbol: "ETH", side: "sell", price: "2523.8", size: "0.0042", filled: "0.0042", status: "filled", type: "market", triggerPrice: "2400" },
    ]);
  });

  it("a non-list response is an EXCHANGE_ERROR, not an empty history", async () => {
    await expect(pacAdapter(async () => ({ orders: [] })).getOrderHistory(30))
      .rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("a row missing order_status is an EXCHANGE_ERROR, not 'done'", async () => {
    const { order_status: _omit, ...row } = PAC_ROW;
    await expect(pacAdapter(async () => [row]).getOrderHistory(30))
      .rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});
