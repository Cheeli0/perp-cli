/**
 * Lighter / Lighter RH request budget: how many venue requests ONE CLI invocation makes.
 *
 * Docs (apidocs.lighter.xyz/docs/rate-limits): "Standard Accounts: 60 requests per rolling
 * minute". Every invocation here is a fresh adapter (a new process) driven through the real
 * command handlers with a fetch mock that records each URL. The on-disk market-metadata cache
 * (cache.ts, keyed venue + network) is the only state shared between invocations — "cold" =
 * empty cache, "warm" = the market list is cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerTradeCommands } from "../../commands/trade.js";
import { registerAccountCommands } from "../../commands/account.js";
import { registerMarketCommands } from "../../commands/market.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { invalidateCache } from "../../cache.js";
import type { AgentMeta } from "../../settings.js";
import type { LighterVenueId } from "../../exchanges/venues/lighter-family.js";

const ACCOUNT_INDEX = 77;
const TSLA = 112;

const BOOKS = [
  { symbol: "ETH", market_id: 0, market_type: "perp", status: "active", supported_size_decimals: 4, supported_price_decimals: 2 },
  { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", supported_size_decimals: 5, supported_price_decimals: 1 },
  { symbol: "TSLA", market_id: TSLA, market_type: "perp", status: "active", supported_size_decimals: 4, supported_price_decimals: 2 },
  { symbol: "ETH/USDC", market_id: 2048, market_type: "spot", status: "active", supported_size_decimals: 4, supported_price_decimals: 2 },
];

const ACCOUNT = {
  account_index: ACCOUNT_INDEX, index: ACCOUNT_INDEX, account_type: 0, account_trading_mode: 0,
  total_order_count: 1, total_asset_value: "13.00", available_balance: "9.00", collateral: "13.00", assets: [],
  positions: [{
    market_id: TSLA, symbol: "TSLA", initial_margin_fraction: "20.00", open_order_count: 1, pending_order_count: 0,
    sign: 1, position: "0.0295", avg_entry_price: "372.88", position_value: "11.000000", unrealized_pnl: "0.000000",
    realized_pnl: "0.000000", liquidation_price: "0", margin_mode: 0, allocated_margin: "0.000000",
  }],
};

const OPEN_ORDER = {
  order_id: "9001", order_index: 9001, client_order_index: 555, market_index: TSLA, is_ask: false, price: "300.00",
  initial_base_amount: "0.0300", remaining_base_amount: "0.0300", filled_base_amount: "0.0000", status: "open", type: "limit", trigger_price: "0",
};

let urls: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fakeVenue(input: string | URL | Request): Response {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const path = url.pathname.replace("/api/v1", "");
  urls.push(`${path}${url.searchParams.has("market_id") ? `?market_id=${url.searchParams.get("market_id")}` : ""}`);
  switch (path) {
    case "/orderBooks": return json({ code: 200, order_books: BOOKS });
    case "/orderBookDetails": return json({ code: 200, order_book_details: BOOKS.map(b => ({ ...b, mark_price: "372.88", index_price: "372.80", min_initial_margin_fraction: 500 })) });
    case "/funding-rates": return json({ code: 200, funding_rates: [] });
    case "/account": return json({ code: 200, accounts: [ACCOUNT] });
    case "/accountActiveOrders": return json({ code: 200, orders: [OPEN_ORDER] });
    case "/nextNonce": return json({ code: 200, nonce: 5 });
    case "/sendTx": return json({ code: 200, tx_hash: "0xabc" });
    case "/tx": return json({ code: 200, status: 2, hash: "0xabc", executed_at: 1, event_info: "{}" });
    case "/orderBookOrders": return json({ code: 200, bids: [{ price: "372.80", remaining_base_amount: "1.0000" }], asks: [{ price: "372.90", remaining_base_amount: "1.0000" }] });
    case "/accountOrders": {
      const coi = Number(url.searchParams.get("client_order_indexes"));
      // 555 = the resting order being cancelled; anything else = the order just placed.
      return json({ code: 200, orders: [coi === 555
        ? { ...OPEN_ORDER, status: "canceled" }
        : { ...OPEN_ORDER, order_id: "9002", order_index: 9002, client_order_index: coi, created_at: Math.floor(Date.now() / 1000) }] });
    }
    default: throw new Error(`unexpected venue request: ${path}`);
  }
}

const fakeSigner = {
  createClient: () => undefined,
  createAuthToken: () => "auth-token",
  signCreateOrder: async () => ({ txType: 14, txInfo: "{}" }),
  signCancelOrder: () => ({ txType: 15, txInfo: "{}" }),
  signUpdateLeverage: async () => ({ txType: 20, txInfo: "{}" }),
};

const AGENT: AgentMeta = {
  agentName: "default", agentWalletName: "lt-agent", agentEvmAddress: "0x00000000000000000000000000000000000000aa",
  userEvmAddress: "0x00000000000000000000000000000000000000bb", apiKeyIndex: 4, accountIndex: ACCOUNT_INDEX,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  masterWalletName: "main", owsApiKeyId: "ows_key_test", owsPolicyId: "policy-test", approvedAt: new Date().toISOString(),
  permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false }, asterApprovalNonce: "0",
};

/** A fresh adapter per invocation, built the way venues/create-helpers.ts createLighterFamily builds an agent adapter. */
async function agentAdapter(venue: LighterVenueId): Promise<LighterAdapter> {
  const a = LighterAdapter.forVenue(venue, "", false);
  a.setAgentSigner(AGENT, "ab".repeat(40));
  a.setAddress(AGENT.userEvmAddress);
  await a.init();
  return a;
}

/** Read-only adapter, as the public market-data commands build it (no credentials). */
async function publicAdapter(venue: LighterVenueId): Promise<LighterAdapter> {
  const a = LighterAdapter.forVenue(venue, "", false);
  await a.init();
  return a;
}

/** One CLI invocation → the venue requests it made, in order. */
async function invoke(venue: LighterVenueId, args: string[]): Promise<string[]> {
  urls = [];
  const program = new Command();
  addRootSafetyOptions(program);
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const getAdapter = () => agentAdapter(venue);
  registerTradeCommands(program, getAdapter, () => true);
  registerAccountCommands(program, getAdapter, () => true);
  registerMarketCommands(program, () => publicAdapter(venue), () => true);
  await program.parseAsync(["node", "perp", ...args]);
  return urls;
}

beforeEach(() => {
  invalidateCache();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => fakeVenue(input)));
  (LighterAdapter as unknown as { _wasmClients: Map<string, unknown> })._wasmClients.clear();
  (LighterAdapter as unknown as { _createWasmClient: () => Promise<unknown> })._createWasmClient = async () => fakeSigner;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const COMMANDS: Array<{ name: string; args: string[] }> = [
  { name: "account positions", args: ["account", "positions"] },
  { name: "account orders", args: ["account", "orders"] },
  { name: "trade limit", args: ["trade", "limit", "TSLA", "buy", "300.00", "0.03"] },
  { name: "trade cancel", args: ["trade", "cancel", "TSLA", "9001"] },
  { name: "trade leverage", args: ["trade", "leverage", "TSLA", "5"] },
  { name: "market mid", args: ["market", "mid", "TSLA"] },
];

/** Requests per invocation after the fix: [cold = empty market-list cache, warm = cached]. */
const EXPECTED: Record<string, { cold: string[]; warm: string[] }> = {
  "account positions": { cold: ["/orderBooks", "/account"], warm: ["/account"] },
  "account orders": { cold: ["/orderBooks", "/accountActiveOrders"], warm: ["/accountActiveOrders"] },
  // /account = the local risk check (balance + positions, one shared read); /tx and /accountOrders settle the placement.
  "trade limit": { cold: ["/orderBooks", "/account", "/nextNonce", "/sendTx", "/tx", "/accountOrders"], warm: ["/account", "/nextNonce", "/sendTx", "/tx", "/accountOrders"] },
  "trade cancel": {
    cold: ["/orderBooks", `/accountActiveOrders?market_id=${TSLA}`, "/nextNonce", "/sendTx", "/tx", "/accountOrders"],
    warm: [`/accountActiveOrders?market_id=${TSLA}`, "/nextNonce", "/sendTx", "/tx", "/accountOrders"],
  },
  "trade leverage": { cold: ["/orderBooks", "/nextNonce", "/sendTx", "/tx"], warm: ["/nextNonce", "/sendTx", "/tx"] },
  "market mid": { cold: ["/orderBooks", `/orderBookOrders?market_id=${TSLA}`], warm: [`/orderBookOrders?market_id=${TSLA}`] },
};

describe.each(["lighter", "lighter-rh"] as const)("%s request count per CLI invocation", (venue) => {
  it.each(COMMANDS)("$name: only the requests the command needs (read ≤ 4, write ≤ 6)", async (c) => {
    const cold = await invoke(venue, c.args);
    invalidateCache("acct"); // account state is never reused across invocations here
    const warm = await invoke(venue, c.args);
    expect(cold).toEqual(EXPECTED[c.name].cold);
    expect(warm).toEqual(EXPECTED[c.name].warm);
    const limit = c.name.startsWith("trade") ? 6 : 4;
    expect(cold.length).toBeLessThanOrEqual(limit);
  }, 30_000);

  it("account orders is ONE read however many markets hold orders (no per-market fan-out)", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/accountActiveOrders")) {
        urls.push(`/accountActiveOrders?${url.searchParams.get("market_type")}:${url.searchParams.get("market_id")}`);
        // ETH and BTC orders: the account has no positions[] entry for either market.
        return json({ code: 200, orders: [{ ...OPEN_ORDER, market_index: 0 }, { ...OPEN_ORDER, order_id: "9003", market_index: 1 }] });
      }
      return fakeVenue(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    const a = await agentAdapter(venue);
    urls = [];
    const orders = await a.getOpenOrders();
    expect(urls).toEqual(["/accountActiveOrders?perp:null"]);
    expect(orders.map(o => [o.orderId, o.symbol])).toEqual([["9001", "ETH"], ["9003", "BTC"]]);
  });

  it("a paged open-order answer (next_cursor) is an error, never a partial list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith("/accountActiveOrders") ? json({ code: 200, orders: [OPEN_ORDER], next_cursor: "abc" }) : fakeVenue(input)));
    const a = await agentAdapter(venue);
    await expect(a.getOpenOrders()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("a 429 on the market list is RATE_LIMITED after ONE request — never an empty map / SYMBOL_NOT_FOUND", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.pathname.replace("/api/v1", ""));
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "7" } });
    }));
    urls = [];
    await expect(agentAdapter(venue)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    expect(urls).toEqual(["/orderBooks"]);
  });

  it("an empty market list is an error and is not cached", async () => {
    let empty = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      empty && new URL(String(input)).pathname.endsWith("/orderBooks") ? json({ code: 200, order_books: [] }) : fakeVenue(input)));
    await expect(publicAdapter(venue)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    empty = false;
    const a = await publicAdapter(venue);
    expect(a.getMarketIndex("TSLA")).toBe(TSLA);
  });

  it("the lot step comes from the loaded market list (no market-details read)", async () => {
    const { lotStepOf } = await import("../../exchanges/precision.js");
    const a = await agentAdapter(venue);
    urls = [];
    expect(await lotStepOf(a, "TSLA")).toBe("0.0001");
    expect(await lotStepOf(a, "BTC")).toBe("0.00001");
    await expect(lotStepOf(a, "NOPE")).rejects.toMatchObject({ structured: { code: "SYMBOL_NOT_FOUND" } });
    expect(urls).toEqual([]);
  });

  it("a failed read before a cancel / modify / leverage tx is ORDER_REJECTED 'not sent' and nothing is posted", async () => {
    const a = await agentAdapter(venue);
    let failing = "/nextNonce";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/api/v1", "");
      if (path === failing) { urls.push(path); return new Response("Too Many Requests", { status: 429 }); }
      return fakeVenue(input);
    }));
    urls = [];
    const notSent = { structured: { code: "ORDER_REJECTED", retryable: false, details: { exchange: venue } } };
    await expect(a.cancelOrder("TSLA", "9001")).rejects.toMatchObject(notSent);
    await expect(a.cancelOrder("TSLA", "9001")).rejects.toThrow(new RegExp(`^${venue} cancel 9001 TSLA not sent: ${venue}: rate limited \\(HTTP 429\\)$`));
    await expect(a.modifyOrder("TSLA", "9001", "301.00", "0.03")).rejects.toMatchObject(notSent);
    await expect(a.updateLeverage("TSLA", 5, "cross")).rejects.toMatchObject(notSent);
    await expect(a.limitOrder("TSLA", "buy", "300.00", "0.03")).rejects.toMatchObject(notSent);
    failing = "/accountActiveOrders";
    await expect(a.cancelOrder("TSLA", "9001")).rejects.toMatchObject(notSent);
    await expect(a.cancelAllOrders()).rejects.toMatchObject(notSent);
    expect(urls).not.toContain("/sendTx");
    // The lookup's own verdict keeps its code.
    failing = "";
    await expect(a.cancelOrder("TSLA", "404404")).rejects.toMatchObject({ structured: { code: "ORDER_NOT_FOUND" } });
    expect(urls).not.toContain("/sendTx");
  });

  it("positions report the CONFIGURED leverage, the margin mode and no liquidation price for '0'", async () => {
    const a = await agentAdapter(venue);
    expect(await a.getPositions()).toEqual([expect.objectContaining({ symbol: "TSLA", leverage: 5, marginMode: "cross", liquidationPrice: null })]);
  });

  it("account settings lists every positions[] entry (leverage from initial_margin_fraction, margin mode); never an empty list", async () => {
    const { lighterPositionSettings } = await import("../../exchanges/lighter.js");
    expect(lighterPositionSettings({ initial_margin_fraction: "33.33", margin_mode: 1 }, venue)).toEqual({ leverage: 3, marginMode: "isolated" });
    expect(lighterPositionSettings({ initial_margin_fraction: "6.66", margin_mode: 0 }, venue)).toEqual({ leverage: 15, marginMode: "cross" });
    expect(() => lighterPositionSettings({ initial_margin_fraction: "0", margin_mode: 0 }, venue)).toThrow(/configured leverage unknown/);
    expect(() => lighterPositionSettings({ initial_margin_fraction: "20.00" }, venue)).toThrow(/margin_mode/);

    const log = vi.mocked(console.log);
    await invoke(venue, ["account", "settings"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).data).toEqual([{ symbol: "TSLA", leverage: 5, margin_mode: "cross" }]);

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith("/account") ? json({ code: 200, accounts: [{ ...ACCOUNT, positions: [] }] }) : fakeVenue(input)));
    invalidateCache("acct");
    await expect(invoke(venue, ["account", "settings"])).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
  });

  it("a WAF challenge (HTTP 405 HTML) is RATE_LIMITED without the HTML; on a write it is a definite 'not sent'", async () => {
    const a = await agentAdapter(venue);
    let block = "all";
    const html = "<html><head><title>Human Verification</title></head><body><script>window.awsWafCookieDomainList = ['app.lighter.xyz'];</script></body></html>";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/api/v1", "");
      return block === "all" || block === path ? new Response(html, { status: 405, headers: { "x-amzn-waf-action": "captcha" } }) : fakeVenue(input);
    }));
    const err = await a.getOpenOrders().catch((e: unknown) => e) as { message: string; structured: { code: string; retryable: boolean } };
    expect(err.structured).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(err.message).toBe(`${venue}: blocked by the venue's WAF challenge (HTTP 405 Human Verification) — wait 1–2 minutes`);
    await expect(a.getOrdersByClientIndex([1])).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    // Pre-send read of a write command, and the sendTx POST itself: nothing reached the API.
    const notSent = { structured: { code: "ORDER_REJECTED", retryable: false } };
    await expect(a.cancelOrder("TSLA", "9001")).rejects.toMatchObject(notSent);
    block = "/sendTx";
    const sent = await a.limitOrder("TSLA", "buy", "300.00", "0.03").catch((e: unknown) => e) as { message: string; structured: { code: string } };
    expect(sent.structured.code).toBe("ORDER_REJECTED");
    expect(sent.message).toMatch(/not sent: .*WAF challenge/);
    expect(sent.message).not.toMatch(/<html|awsWaf/);
    // A JSON 405 is the API's own answer, not a challenge.
    const { lighterWafChallenge } = await import("../../exchanges/lighter-public.js");
    expect(lighterWafChallenge(venue, 405, '{"code":20001,"message":"invalid param"}')).toBeNull();
    expect(lighterWafChallenge(venue, 500, html)).toBeNull();
  });
});

// ── Account history: account-wide endpoints, bounded requests, no swallowed page ──

// GET /trades?account_index=723334&sort_by=timestamp (mainnet, 2026-10-05), trimmed; account → ACCOUNT_INDEX.
const TRADE_TAKER_SELL = {
  trade_id: 33270966187, type: "trade", market_id: TSLA, market_kind: "perps", size: "0.096", price: "121.134", usd_amount: "11.628864",
  ask_account_id: ACCOUNT_INDEX, bid_account_id: 513030, is_maker_ask: false, timestamp: 1791168722794,
};
const TRADE_TAKER_BUY_FEE = { ...TRADE_TAKER_SELL, trade_id: 33270800000, market_id: 0, ask_account_id: 513030, bid_account_id: ACCOUNT_INDEX, is_maker_ask: true, usd_amount: "0.766687", taker_fee: 100, maker_fee: 28, timestamp: 1791168000000 };
// GET /positionFunding?account_index=281474976710654 (public pool, mainnet, 2026-10-05).
const FUNDING_ROW = { timestamp: 1791169200, market_id: 0, funding_id: 1652161, change: "13.021960", rate: "0.000012", position_size: "397.3458", position_side: "short", discount: "0.000000" };
const INACTIVE_ORDER = { ...OPEN_ORDER, order_id: "8001", order_index: 8001, market_index: 1, status: "filled", filled_base_amount: "0.0300" };

type HistoryReply = (url: URL, nth: number) => Response;

function historyVenue(over: Partial<Record<"/accountInactiveOrders" | "/trades" | "/positionFunding", HistoryReply>> = {}) {
  const seen: Record<string, number> = {};
  const replies: Record<string, HistoryReply> = {
    "/accountInactiveOrders": () => json({ code: 200, orders: [INACTIVE_ORDER] }),
    "/trades": () => json({ code: 200, trades: [TRADE_TAKER_SELL, TRADE_TAKER_BUY_FEE] }),
    "/positionFunding": () => json({ code: 200, position_fundings: [FUNDING_ROW] }),
    ...over,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1", "");
    const reply = replies[path];
    if (reply === undefined) return fakeVenue(input);
    urls.push(path);
    seen[path] = (seen[path] ?? 0) + 1;
    return reply(url, seen[path]);
  }));
}

describe.each(["lighter", "lighter-rh"] as const)("%s account history request count", (venue) => {
  const HISTORY: Array<{ name: string; args: string[]; warm: string[] }> = [
    { name: "account history", args: ["account", "history"], warm: ["/accountInactiveOrders"] },
    { name: "account trades", args: ["account", "trades"], warm: ["/trades"] },
    { name: "account funding-history", args: ["account", "funding-history"], warm: ["/positionFunding"] },
    { name: "trade fills", args: ["trade", "fills"], warm: ["/trades"] },
  ];

  it.each(HISTORY)("$name: ONE history request for the whole account (was one per perp market)", async (c) => {
    historyVenue();
    const cold = await invoke(venue, c.args);
    const warm = await invoke(venue, c.args);
    expect(cold).toEqual(["/orderBooks", ...c.warm]);
    expect(warm).toEqual(c.warm);
  }, 30_000);

  it("account pnl: trades + funding + one account read, each account-wide", async () => {
    historyVenue();
    await invoke(venue, ["account", "history"]); // warm the market list
    invalidateCache("acct");
    const reqs = await invoke(venue, ["account", "pnl"]);
    expect([...reqs].sort()).toEqual(["/account", "/positionFunding", "/trades"]);
  }, 30_000);

  it("the requests carry no market filter and the documented required parameters", async () => {
    const queries: Record<string, URLSearchParams> = {};
    const record = (body: unknown): HistoryReply => (url) => { queries[url.pathname.replace("/api/v1", "")] = url.searchParams; return json(body); };
    historyVenue({
      "/accountInactiveOrders": record({ code: 200, orders: [] }),
      "/trades": record({ code: 200, trades: [] }),
      "/positionFunding": record({ code: 200, position_fundings: [] }),
    });
    const a = await agentAdapter(venue);
    await expect(a.getOrderHistory(30)).resolves.toEqual([]);
    await expect(a.getTradeHistory(30)).resolves.toEqual([]);
    await expect(a.getFundingPayments(50)).resolves.toEqual([]);
    for (const q of Object.values(queries)) {
      expect(q.get("account_index")).toBe(String(ACCOUNT_INDEX));
      expect(q.has("market_id")).toBe(false);
      expect(q.has("market_ids")).toBe(false);
    }
    expect(queries["/accountInactiveOrders"].get("limit")).toBe("30");
    expect(queries["/accountInactiveOrders"].get("auth")).toBe("auth-token");
    expect(queries["/trades"].get("sort_by")).toBe("timestamp");
    expect(queries["/trades"].has("auth")).toBe(false);
    expect(queries["/positionFunding"].get("limit")).toBe("50");
    expect(queries["/positionFunding"].get("auth")).toBe("auth-token");
  });

  it("rows: side from ask/bid account, ms trade time, fee = usd_amount × rate / 1e6, funding seconds → ms", async () => {
    historyVenue();
    const a = await agentAdapter(venue);
    await expect(a.getTradeHistory(30)).resolves.toEqual([
      { time: 1791168722794, symbol: "TSLA", side: "sell", price: "121.134", size: "0.096", fee: "0" },
      { time: 1791168000000, symbol: "ETH", side: "buy", price: "121.134", size: "0.096", fee: "0.0000766687" },
    ]);
    await expect(a.getFundingPayments(10)).resolves.toEqual([{ time: 1791169200000, symbol: "ETH", payment: "13.021960" }]);
    expect((await a.getOrderHistory(10)).map(o => [o.orderId, o.symbol, o.side, o.status])).toEqual([["8001", "BTC", "buy", "filled"]]);
  });

  it("limit above one page follows next_cursor: ⌈limit / 100⌉ requests, never more", async () => {
    const cursors: Array<string | null> = [];
    historyVenue({
      "/trades": (url, nth) => {
        cursors.push(url.searchParams.get("cursor"));
        return json({ code: 200, trades: Array.from({ length: Number(url.searchParams.get("limit")) }, (_, i) => ({ ...TRADE_TAKER_SELL, trade_id: nth * 1000 + i })), next_cursor: `c${nth}` });
      },
    });
    const a = await agentAdapter(venue);
    urls = [];
    const trades = await a.getTradeHistory(250);
    expect(trades).toHaveLength(250);
    expect(urls).toEqual(["/trades", "/trades", "/trades"]);
    expect(cursors).toEqual([null, "c1", "c2"]);
  });

  it("a failed page fails the read — no partial history (429 on page 2, venue error body, WAF)", async () => {
    historyVenue({
      "/trades": (_url, nth) => nth === 1
        ? json({ code: 200, trades: Array.from({ length: 100 }, () => TRADE_TAKER_SELL), next_cursor: "c1" })
        : new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "7" } }),
      "/positionFunding": () => json({ code: 20001, message: "invalid param : auth required for main accounts" }),
      "/accountInactiveOrders": () => new Response("<html><head><title>Human Verification</title></head></html>", { status: 405, headers: { "x-amzn-waf-action": "captcha" } }),
    });
    const a = await agentAdapter(venue);
    await expect(a.getTradeHistory(200)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    await expect(a.getFundingPayments(200)).rejects.toThrow(/returned no position_fundings array \(code 20001: "invalid param : auth required for main accounts"\)/);
    await expect(a.getOrderHistory(30)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
  });

  it("a trade row that names neither side as this account is an error, never a guessed side", async () => {
    historyVenue({ "/trades": () => json({ code: 200, trades: [{ ...TRADE_TAKER_SELL, ask_account_id: 1 }] }) });
    const a = await agentAdapter(venue);
    await expect(a.getTradeHistory(30)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});
