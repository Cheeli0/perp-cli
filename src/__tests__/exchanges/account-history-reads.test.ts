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
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { LighterAdapter } from "../../exchanges/lighter.js";

async function asterAdapter(routes: Record<string, (params: Record<string, string>) => unknown>, positions: Array<{ symbol: string; positionAmt: string }> = []) {
  const { AsterAdapter } = await import("../../exchanges/aster.js");
  const ast = new AsterAdapter(undefined, false);
  const t = ast as unknown as Record<string, unknown>;
  t._resolveSigner = vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
  const signed = vi.fn(async (path: string, params: Record<string, string>) => {
    const defaults: Record<string, () => unknown> = {
      "/fapi/v3/openOrders": () => [],
      "/fapi/v3/accountWithJoinMargin": () => ({ positions }),
    };
    const route = routes[path] ?? defaults[path];
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
      "/fapi/v3/income": () => [{ symbol: "DOGEUSDT", time: 1, tranId: 1 }],
      "/fapi/v3/allOrders": () => [order("DOGEUSDT", 1), order("DOGEUSDT", 5, "SELL")],
    });
    const rows = await ast.getOrderHistory(30);
    expect(rows.map((o) => [o.symbol, o.orderId, o.side])).toEqual([["DOGE", "5", "sell"], ["DOGE", "1", "buy"]]);
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/allOrders").map((c) => c[1].symbol)).toEqual(["DOGEUSDT"]);
  });

  it("a failed allOrders read throws instead of being skipped", async () => {
    const { ast } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "DOGEUSDT", time: 1, tranId: 1 }],
      "/fapi/v3/allOrders": () => { throw new Error("HTTP 418"); },
    });
    await expect(ast.getOrderHistory(30)).rejects.toThrow("418");
  });

  it("income is read as disjoint inclusive daily slices over 7 days — no response-order assumption", async () => {
    const { ast, signed } = await asterAdapter({ "/fapi/v3/income": () => [], "/fapi/v3/allOrders": () => [] });
    await ast.getOrderHistory(30);
    const w = signed.mock.calls.filter((c) => c[0] === "/fapi/v3/income").map((c) => [Number(c[1].startTime), Number(c[1].endTime)]);
    expect(w.length).toBeGreaterThanOrEqual(7);
    expect(w.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < w.length; i++) expect(w[i][0]).toBe(w[i - 1][1] + 1); // contiguous, no overlap, no gap
    expect(w[w.length - 1][1] - w[0][0]).toBeGreaterThanOrEqual(7 * 86_400_000 - 1);
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/income").every((c) => c[1].incomeType === "COMMISSION" && c[1].limit === "1000")).toBe(true);
  });

  it("a full slice (1000 rows) is split in half and re-read; symbols from either half are found in any row order", async () => {
    let first = true;
    const { ast, signed } = await asterAdapter({
      "/fapi/v3/income": (p) => {
        if (first) { // the first daily slice is "full": oldest-first rows, the newest symbol last
          first = false;
          return [...Array.from({ length: 999 }, () => ({ symbol: "SOLUSDT", time: Number(p.startTime) })), { symbol: "SOLUSDT", time: Number(p.endTime) }];
        }
        const s = Number(p.startTime);
        return s % 2 === 0 ? [{ symbol: "BNBUSDT", time: s }] : [{ symbol: "ETHUSDT", time: s }];
      },
      "/fapi/v3/allOrders": () => [],
    });
    await ast.getOrderHistory(30);
    const calls = signed.mock.calls.filter((c) => c[0] === "/fapi/v3/income").map((c) => [Number(c[1].startTime), Number(c[1].endTime)]);
    const [s0, e0] = calls[0];
    const mid = Math.floor((s0 + e0) / 2);
    expect(calls[1]).toEqual([s0, mid]);
    expect(calls[2]).toEqual([mid + 1, e0]);
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/allOrders").length).toBeGreaterThanOrEqual(1);
  });

  it("more requests than ASTER_INCOME_MAX_PAGES (every slice full) → EXCHANGE_ERROR, never a partial symbol set", async () => {
    const { ast } = await asterAdapter({ "/fapi/v3/income": (p) => Array.from({ length: 1000 }, () => ({ symbol: "SOLUSDT", time: Number(p.startTime) })) });
    await expect(ast.getOrderHistory(30)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("a full slice that is already one millisecond wide cannot be split → EXCHANGE_ERROR", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const a = Object.create(AsterAdapter.prototype) as Record<string, unknown>;
    // Every slice is "full", so slices are halved down to [T, T] and the guard must fire
    // (before ASTER_INCOME_MAX_PAGES only if a slice reaches 1 ms first — either way: EXCHANGE_ERROR).
    a._signedGetEip712 = vi.fn(async (_p: string, q: Record<string, string>) => Array.from({ length: 1000 }, () => ({ symbol: "SOLUSDT", time: Number(q.startTime) })));
    const incomeRows = (AsterAdapter.prototype as unknown as { _incomeRows: (t: string, r: unknown) => Promise<unknown[]> })._incomeRows;
    await expect(incomeRows.call(a, "COMMISSION", {})).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("open positions use the raw venue symbol (no _fromApi → _toApi round trip)", async () => {
    const { ast, signed } = await asterAdapter(
      { "/fapi/v3/income": () => [], "/fapi/v3/allOrders": () => [] },
      [{ symbol: "ETHUSDC", positionAmt: "0.5" }, { symbol: "BTCUSDT", positionAmt: "0" }],
    );
    await ast.getOrderHistory(30);
    expect(signed.mock.calls.filter((c) => c[0] === "/fapi/v3/allOrders").map((c) => c[1].symbol)).toEqual(["ETHUSDC"]);
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
      "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 1, tranId: 1, incomeType: "COMMISSION" }, { symbol: "SOLUSDT", time: 1, tranId: 2 }, { symbol: "ETHUSDT", time: 1, tranId: 3 }],
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
      "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 1, tranId: 1 }],
      "/fapi/v3/userTrades": () => { throw new Error("HTTP 429"); },
    });
    await expect(ast.getTradeHistory(30)).rejects.toThrow("429");
  });

  it("a row missing a field is an EXCHANGE_ERROR, not a zero", async () => {
    const { ast } = await asterAdapter({
      "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 1, tranId: 1 }],
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

describe("AsterAdapter.getFundingPayments — strict", () => {
  it("maps FUNDING_FEE rows; a non-list or a row without income → EXCHANGE_ERROR (no 0 / [] default)", async () => {
    let calls = 0;
    const ok = await asterAdapter({ "/fapi/v3/income": (p) => (calls++ < 2 ? [{ symbol: "SOLUSDT", time: Number(p.startTime), income: `-0.00${calls}` }] : []) });
    const rows = await ok.ast.getFundingPayments(10);
    expect(rows.map((r) => r.payment)).toEqual(["-0.002", "-0.001"]); // newest first across slices
    expect(rows.every((r) => r.symbol === "SOL")).toBe(true);
    expect(await (await asterAdapter({ "/fapi/v3/income": (p) => [{ symbol: "SOLUSDT", time: Number(p.startTime), income: "1" }] })).ast.getFundingPayments(3)).toHaveLength(3);
    const bad = await asterAdapter({ "/fapi/v3/income": () => [{ symbol: "SOLUSDT", time: 5 }] });
    await expect(bad.ast.getFundingPayments(10)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    const notList = await asterAdapter({ "/fapi/v3/income": () => null });
    await expect(notList.ast.getFundingPayments(10)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

function pacFills(rows: unknown, funding: unknown = []) {
  const a = Object.create(PacificaAdapter.prototype) as Record<string, unknown>;
  a._hasRealKey = true;
  a.account = "acct";
  a.client = { getTradeHistory: vi.fn(async () => rows), getFundingAccountHistory: vi.fn(async () => funding) };
  return a as unknown as PacificaAdapter;
}
// GET https://api.pacifica.fi/api/v1/trades/history row (2026-10-13), unwrapped.
const PAC_FILL = { history_id: 298076640, order_id: 13484908342, symbol: "ETH", amount: "0.0042", price: "2511.2", fee: "0.004219", event_type: "fulfill_taker", side: "close_short", created_at: 1791827683658 };

describe("PacificaAdapter.getTradeHistory / getFundingPayments", () => {
  it("side is the position effect: open_long / close_short → buy, open_short / close_long → sell (was always sell)", async () => {
    const rows = await pacFills([
      PAC_FILL, { ...PAC_FILL, side: "open_long" }, { ...PAC_FILL, side: "open_short" }, { ...PAC_FILL, side: "close_long" },
    ]).getTradeHistory(30);
    expect(rows.map((r) => r.side)).toEqual(["buy", "buy", "sell", "sell"]);
    expect(rows[0]).toEqual({ time: 1791827683658, symbol: "ETH", side: "buy", price: "2511.2", size: "0.0042", fee: "0.004219" });
  });

  it("an unknown side, a missing fee or a non-list → EXCHANGE_ERROR; the limit is passed to the venue", async () => {
    await expect(pacFills([{ ...PAC_FILL, side: "liquidation" }]).getTradeHistory(30)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    const { fee: _f, ...noFee } = PAC_FILL;
    await expect(pacFills([noFee]).getTradeHistory(30)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect(pacFills({ data: [] }).getTradeHistory(30)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    const a = pacFills([]);
    await a.getTradeHistory(7);
    expect((a as unknown as { client: { getTradeHistory: ReturnType<typeof vi.fn> } }).client.getTradeHistory).toHaveBeenCalledWith("acct", { limit: 7 });
  });

  it("funding rows: signed payout; a row without payout → EXCHANGE_ERROR", async () => {
    // GET …/funding/history row (2026-10-13), unwrapped.
    const row = { history_id: 58524731, symbol: "ETH", side: "bid", amount: "0.0041", payout: "-0.000597", rate: "0.00005385", created_at: 1791147604256 };
    expect(await pacFills([], [row]).getFundingPayments(10)).toEqual([{ time: 1791147604256, symbol: "ETH", payment: "-0.000597" }]);
    const { payout: _p, ...noPayout } = row;
    await expect(pacFills([], [noPayout]).getFundingPayments(10)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

// ── Hyperliquid ──

function hlAdapter(route: (body: Record<string, unknown>) => unknown, dex = "") {
  const a = Object.create(HyperliquidAdapter.prototype) as Record<string, unknown>;
  a._address = "0xabc";
  a._dex = dex;
  a._assetMap = new Map([["ETH-PERP", 1], ["xyz:GOLD", 110001]]);
  a._assetMapError = null;
  const info = vi.fn(async (body: Record<string, unknown>) => route(body));
  a._infoPost = info;
  return { a: a as unknown as HyperliquidAdapter, info };
}

// POST /info historicalOrders rows (shape live 2026-10-13): newest first, one row per status.
const hlOrder = (oid: number, status: string, at: number, extra: Record<string, unknown> = {}) => ({
  order: { coin: "ETH", side: "A", limitPx: "2494.6", sz: status === "open" ? "0.0083" : "0.0", oid, timestamp: at, isTrigger: false, triggerPx: "0.0", orderType: "Limit", origSz: "0.0083", ...extra },
  status, statusTimestamp: at,
});

describe("HyperliquidAdapter.getOrderHistory — historicalOrders, one row per order with its final status", () => {
  it("includes canceled orders (userFills showed fills only); 'open' + 'filled' at the same ms → filled; filled = origSz − sz", async () => {
    const { a, info } = hlAdapter(() => [
      hlOrder(2, "filled", 200), hlOrder(2, "open", 200),
      hlOrder(1, "canceled", 150, { sz: "0.0083" }), hlOrder(1, "open", 100, { sz: "0.0083" }),
    ]);
    const rows = await a.getOrderHistory(30);
    expect(info).toHaveBeenCalledWith({ type: "historicalOrders", user: "0xabc" });
    expect(rows.map((r) => [r.orderId, r.status, r.filled, r.side])).toEqual([["2", "filled", "0.0083", "sell"], ["1", "canceled", "0", "sell"]]);
  });

  it("a trigger order reports its trigger price; an unknown side or missing field → EXCHANGE_ERROR", async () => {
    const trig = await hlAdapter(() => [hlOrder(3, "triggered", 5, { isTrigger: true, triggerPx: "2400" })]).a.getOrderHistory(5);
    expect(trig[0].triggerPrice).toBe("2400");
    await expect(hlAdapter(() => [hlOrder(4, "filled", 5, { side: "X" })]).a.getOrderHistory(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect(hlAdapter(() => [hlOrder(4, "filled", 5, { limitPx: "" })]).a.getOrderHistory(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

describe("HyperliquidAdapter.getTradeHistory — strict userFills", () => {
  it("maps B/A and keeps the venue fee; a fill without fee → EXCHANGE_ERROR (no '0')", async () => {
    const fill = { coin: "ETH", px: "2507.1", sz: "0.0083", side: "A", time: 1791864358304, fee: "0.008989" };
    expect(await hlAdapter(() => [fill]).a.getTradeHistory(5)).toEqual([{ time: 1791864358304, symbol: "ETH-PERP", side: "sell", price: "2507.1", size: "0.0083", fee: "0.008989" }]);
    const { fee: _f, ...noFee } = fill;
    await expect(hlAdapter(() => [noFee]).a.getTradeHistory(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});

describe("HyperliquidAdapter.getFundingPayments — userFunding is oldest-first, 500 per page, one ms per funding hour", () => {
  const row = (time: number, coin = "ETH", usdc = "-0.0001") => ({ time, delta: { type: "funding", coin, usdc } });

  it("a page boundary inside one funding hour loses nothing: pages continue at the last ms (inclusive), deduped by time + coin", async () => {
    const t0 = Date.now() - 3_600_000;
    const T = t0 + 498;
    // page 1: 498 rows + 2 of the 4 coins paid at T; page 2 (startTime = T) repeats those 2 and adds the other 2.
    const page1 = [...Array.from({ length: 498 }, (_, i) => row(t0 + i, `C${i}`)), row(T, "ETH"), row(T, "BTC")];
    const page2 = [row(T, "ETH"), row(T, "BTC"), row(T, "SOL"), row(T, "HYPE")];
    const { a, info } = hlAdapter((b) => (Number(b.startTime) === T ? page2 : page1));
    const rows = await a.getFundingPayments(1000);
    expect((info.mock.calls[1][0] as { startTime: number }).startTime).toBe(T);
    const atT = rows.filter((r) => r.time === T).map((r) => r.symbol).sort();
    expect(atT).toEqual(["BTC", "ETH-PERP", "HYPE", "SOL"]); // the old `last + 1` dropped SOL and HYPE
  });

  it("reads 24 h first; widens to 7 days only when that holds fewer than `limit` rows; newest first", async () => {
    const now = Date.now();
    const recent = [row(now - 3_600_000, "ETH", "0.1"), row(now - 7_200_000, "ETH", "0.2")];
    const older = [row(now - 3 * 86_400_000, "ETH", "0.3"), ...recent.slice().reverse()];
    const { a, info } = hlAdapter((b) => (Number(b.startTime) > now - 2 * 86_400_000 ? recent.slice().reverse() : older));
    expect((await a.getFundingPayments(2)).map((r) => r.payment)).toEqual(["0.1", "0.2"]);
    expect(info).toHaveBeenCalledTimes(1); // 24 h was enough
    info.mockClear();
    expect((await a.getFundingPayments(3)).map((r) => r.payment)).toEqual(["0.1", "0.2", "0.3"]);
    expect(info).toHaveBeenCalledTimes(2); // widened to 7 days
  });

  it("scoped to the adapter: native keeps native perps (no xyz: / @ / # coins); a dex adapter keeps only its dex", async () => {
    const now = Date.now();
    const rows = [row(now - 1000, "ETH"), row(now - 1000, "xyz:GOLD"), row(now - 1000, "@107"), row(now - 1000, "#10")];
    expect((await hlAdapter(() => rows).a.getFundingPayments(10)).map((r) => r.symbol)).toEqual(["ETH-PERP"]);
    expect((await hlAdapter(() => rows, "xyz").a.getFundingPayments(10)).map((r) => r.symbol)).toEqual(["xyz:GOLD"]);
  });

  it("a full page that adds nothing new (500+ rows at one ms) → EXCHANGE_ERROR; a non-list or bad row → EXCHANGE_ERROR", async () => {
    const T = Date.now() - 1000;
    const stuck = Array.from({ length: 500 }, (_, i) => row(T, `C${i}`));
    await expect(hlAdapter(() => stuck).a.getFundingPayments(10)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect(hlAdapter(() => ({ error: "x" })).a.getFundingPayments(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
    await expect(hlAdapter(() => [{ time: 1, delta: { coin: "ETH" } }]).a.getFundingPayments(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });

  it("a rate-limit error from the info endpoint propagates (never an empty history)", async () => {
    const { PerpError } = await import("../../errors.js");
    const { a } = hlAdapter(() => { throw new PerpError("RATE_LIMITED", "HTTP 429"); });
    await expect(a.getFundingPayments(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "RATE_LIMITED" }) });
  });
});

describe("HyperliquidAdapter history scope + status precedence", () => {
  it("fills / orders are scoped like funding (native vs --dex)", async () => {
    const fill = (coin: string) => ({ coin, px: "1", sz: "1", side: "B", time: 5, fee: "0" });
    const fills = [fill("ETH"), fill("xyz:GOLD"), fill("@107"), fill("PURR/USDC")];
    expect((await hlAdapter(() => fills).a.getTradeHistory(10)).map((r) => r.symbol)).toEqual(["ETH-PERP"]);
    expect((await hlAdapter(() => fills, "xyz").a.getTradeHistory(10)).map((r) => r.symbol)).toEqual(["xyz:GOLD"]);
    const orders = [hlOrder(1, "filled", 5), hlOrder(2, "filled", 5, { coin: "xyz:GOLD" })];
    expect((await hlAdapter(() => orders, "xyz").a.getOrderHistory(10)).map((r) => r.orderId)).toEqual(["2"]);
  });

  it("equal statusTimestamp: a terminal status beats triggered beats open, whatever the row order", async () => {
    const rows = [hlOrder(9, "open", 50), hlOrder(9, "triggered", 50), hlOrder(9, "perpMarginRejected", 50)];
    expect((await hlAdapter(() => rows).a.getOrderHistory(5))[0].status).toBe("perpMarginRejected");
    expect((await hlAdapter(() => rows.slice().reverse()).a.getOrderHistory(5))[0].status).toBe("perpMarginRejected");
  });
});

// ── Lighter ──

describe("LighterAdapter.getOrderHistory — strict fields", () => {
  function lt(rows: Array<Record<string, unknown>>) {
    const a = Object.create(LighterAdapter.prototype) as Record<string, unknown>;
    a._address = "0xabc";
    a.historyRows = vi.fn(async () => rows);
    a.historySymbol = () => "SOL";
    Object.defineProperty(a, "name", { value: "lighter" });
    return a as unknown as LighterAdapter;
  }
  const row = { order_index: 7, market_index: 2, is_ask: true, price: "107.4", initial_base_amount: "0.200", filled_base_amount: "0.200", status: "filled", type: "market" };

  it("maps a complete row", async () => {
    const [o] = await lt([row]).getOrderHistory(5);
    expect(o).toMatchObject({ side: "sell", price: "107.4", size: "0.200", filled: "0.200", status: "filled", type: "market", triggerPrice: null });
  });

  it.each(["price", "status", "type", "filled_base_amount", "initial_base_amount"])("a row without %s → EXCHANGE_ERROR (no '0' / 'done' / 'limit')", async (k) => {
    const { [k]: _omit, ...partial } = row as Record<string, unknown>;
    await expect(lt([partial]).getOrderHistory(5)).rejects.toMatchObject({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) });
  });
});
