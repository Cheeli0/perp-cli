/**
 * Bot read failures are never decided on as fabricated values (0 / empty / stale):
 * - conditions: failed klines / orderbook → volatility / spread NaN (every comparison false), logged
 * - spot-perp-arb: a held position's unknown price blocks new entries (never valued at $0)
 * - funding-auto: an unreadable venue's markets → no exit decision on it; an unknown balance → no entry sizing
 * - grid: failed open-order reads are logged and counted; a loud warning after GRID_READ_FAILURE_WARN
 * - engine TUI: a failed positions / orders / balance read is flagged "unavailable", never empty
 * - strategy commands: an explicit --exchanges venue that fails refuses the start; a default one is skipped with a warning
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { Command } from "commander";

const placePerpVerified = vi.fn();
const closePerpVerified = vi.fn();
vi.mock("../bot/perp-order.js", async (orig) => ({
  ...(await orig<typeof import("../bot/perp-order.js")>()),
  placePerpVerified: (...a: unknown[]) => placePerpVerified(...a),
  closePerpVerified: (...a: unknown[]) => closePerpVerified(...a),
}));

import "../exchanges/venues/index.js";
import { getMarketSnapshot, evaluateCondition } from "../bot/conditions.js";
import { SpotPerpArbStrategy } from "../bot/strategies/spot-perp-arb-strategy.js";
import "../bot/strategies/funding-auto.js";
import { getStrategy } from "../bot/strategy-registry.js";
import { GridStrategy, GRID_READ_FAILURE_WARN } from "../bot/strategies/grid-strategy.js";
import { fetchPositions, fetchOpenOrders, fetchExchangeBalances } from "../bot/engine.js";
import { BotDashboard, type BotTuiState } from "../bot/tui/BotDashboard.js";
import { loadBotVenueAdapters, registerStrategyCommands } from "../commands/bot.js";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { StrategyContext, StrategyAction, EnrichedSnapshot } from "../bot/strategy-types.js";

const boom = (msg: string) => vi.fn(async () => { throw new Error(msg); });
const logged = (log: ReturnType<typeof vi.fn>, re: RegExp) => log.mock.calls.some(c => re.test(String(c[0])));

// ── H6: conditions ──

describe("getMarketSnapshot: failed klines / orderbook reads", () => {
  const market = { symbol: "ETH", markPrice: "2000", fundingRate: "0.0001", volume24h: "1000" };

  it("volatility / spread are NaN (never 0), each failure is logged, and no condition on them fires", async () => {
    const a = { name: "aster", getMarkets: vi.fn(async () => [market]), getKlines: boom("klines 500"), getOrderbook: boom("book 429") } as unknown as ExchangeAdapter;
    const log = vi.fn();
    const snap = await getMarketSnapshot(a, "ETH", log);
    expect(snap.volatility24h).toBeNaN();
    expect(snap.spreadPct).toBeNaN();
    expect(logged(log, /klines read failed.*klines 500/)).toBe(true);
    expect(logged(log, /orderbook read failed.*book 429/)).toBe(true);
    const ctx = { equity: 100, startTime: Date.now(), peakEquity: 100, dailyPnl: 0 };
    expect(evaluateCondition({ type: "volatility_below", value: 100 }, snap, ctx)).toBe(false);
    expect(evaluateCondition({ type: "volatility_above", value: -1 }, snap, ctx)).toBe(false);
    expect(evaluateCondition({ type: "spread_above", value: -1 }, snap, ctx)).toBe(false);
  });

  it("no candles in the last 24h → volatility unknown (not high = low = price)", async () => {
    const a = { name: "aster", getMarkets: vi.fn(async () => [market]), getKlines: vi.fn(async () => []), getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })) } as unknown as ExchangeAdapter;
    const snap = await getMarketSnapshot(a, "ETH");
    expect(snap.volatility24h).toBeNaN();
    expect(snap.spreadPct).toBeNaN();
  });

  it("successful reads still compute volatility and spread", async () => {
    const now = Date.now();
    const k = (h: number, hi: string, lo: string) => ({ time: now - h * 3600_000, open: "2000", high: hi, low: lo, close: "2000", volume: "1" });
    const a = {
      name: "aster", getMarkets: vi.fn(async () => [market]),
      getKlines: vi.fn(async () => [k(2, "2100", "1900"), k(1, "2050", "1950")]),
      getOrderbook: vi.fn(async () => ({ bids: [["1999", "1"]], asks: [["2001", "1"]] })),
    } as unknown as ExchangeAdapter;
    const snap = await getMarketSnapshot(a, "ETH");
    expect(snap.volatility24h).toBeCloseTo(10);
    expect(snap.spreadPct).toBeCloseTo(0.1);
  });
});

// ── H7: spot-perp-arb exposure ──

describe("spot-perp-arb: max_position_usd with a held position's price unknown", () => {
  type Internals = {
    executor: Record<string, unknown>;
    tryOpenPosition(spotEx: string, perpEx: string, symbol: string, rate: number, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, rates: Map<string, Map<string, unknown>>, bals: Map<string, { equity: number; available: number; marginPct: number }>): Promise<boolean>;
  };
  const perp = (name: string) => ({
    name, isUnifiedAccount: true,
    getBalance: vi.fn(async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" })),
  }) as unknown as ExchangeAdapter;

  function setup() {
    const hl = perp("hyperliquid");
    const adapters = new Map<string, ExchangeAdapter>([["hyperliquid", hl]]);
    const log = vi.fn();
    const ctx = { adapter: hl, symbol: "ALL", config: { size_usd: 10 }, state: new Map<string, unknown>(), tick: 0, log } as unknown as StrategyContext;
    ctx.state.set("spaPositions", [{ id: "h", symbol: "HYPE", spotExchange: "hyperliquid", perpExchange: "hyperliquid", size: "100", entryTime: 0, entryRate: 20, fundingHistory: [], lastFundingCheck: 0 }]);
    ctx.state.set("riskConfig", { max_position_usd: 50 });
    const s = new SpotPerpArbStrategy();
    const openPosition = vi.fn(async () => ({ success: false, error: "test stop" }));
    (s as unknown as Internals).executor = { getSpotAdapter: vi.fn(async () => ({ name: "hyperliquid-spot" })), openPosition };
    const bals = new Map([["hyperliquid", { equity: 1000, available: 1000, marginPct: 0 }]]);
    return { s: s as unknown as Internals, ctx, adapters, bals, log, openPosition };
  }

  it("missing rate for the held position → entry blocked and logged (never counted as $0 exposure)", async () => {
    const { s, ctx, adapters, bals, log, openPosition } = setup();
    expect(await s.tryOpenPosition("hyperliquid", "hyperliquid", "ETH", 25, adapters, ctx, new Map(), bals)).toBe(false);
    expect(openPosition).not.toHaveBeenCalled();
    expect(logged(log, /HYPE hyperliquid price unknown this cycle.*no new entries/)).toBe(true);
  });

  it("known price: the held exposure ($40 × 100 = $4000) counts against the cap", async () => {
    const { s, ctx, adapters, bals, log, openPosition } = setup();
    const rates = new Map([["hyperliquid", new Map([["HYPE", { rate: 0.0001, price: 40 }]])]]);
    expect(await s.tryOpenPosition("hyperliquid", "hyperliquid", "ETH", 25, adapters, ctx, rates, bals)).toBe(false);
    expect(openPosition).not.toHaveBeenCalled();
    expect(logged(log, /risk limit — total positions \$4000\/\$50/)).toBe(true);
  });
});

// ── M3 / M4: funding-auto ──

describe("funding-auto: unreadable venue / balance", () => {
  const strategy = () => {
    const s = getStrategy("funding-auto")!({});
    (s as unknown as { _config: Record<string, unknown> })._config = {};
    return s;
  };
  function venue(name: string, over: Record<string, unknown> = {}) {
    return {
      name,
      getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
      getPositions: vi.fn(async () => []),
      getMarkets: vi.fn(async () => [{ symbol: "ETH", markPrice: "2000", fundingRate: name === "hyperliquid" ? "0.0001" : "0.001", fundingHours: 1 }]),
      getTradeHistory: vi.fn(async () => []),
      getFundingPayments: vi.fn(async () => []),
      ...over,
    } as unknown as ExchangeAdapter;
  }
  function ctxOf(a: ExchangeAdapter, b: ExchangeAdapter) {
    const log = vi.fn();
    const ctx = { adapter: a, symbol: "ALL", config: {}, state: new Map<string, unknown>(), tick: 0, log } as unknown as StrategyContext;
    ctx.state.set("extraAdapters", new Map([[b.name, b]]));
    return { ctx, log };
  }
  const snap = {} as EnrichedSnapshot;
  beforeEach(() => {
    placePerpVerified.mockReset().mockRejectedValue(new PerpError("INVALID_PARAMS", "test: not placed"));
    closePerpVerified.mockReset();
  });

  it("control: both balances readable → an entry is attempted", async () => {
    const { ctx } = ctxOf(venue("hyperliquid"), venue("lighter"));
    await strategy().onTick(ctx, snap);
    expect(placePerpVerified).toHaveBeenCalled();
  });

  it("a failed balance read → equity unknown: logged, no entry sized (no stale value, no fallback size)", async () => {
    const { ctx, log } = ctxOf(venue("hyperliquid"), venue("lighter", { getBalance: boom("balance 503") }));
    await strategy().onTick(ctx, snap);
    expect(placePerpVerified).not.toHaveBeenCalled();
    expect(logged(log, /lighter balance unreadable \(balance 503\)/)).toBe(true);
    expect(logged(log, /No new entries: position size unknown \(equity unknown/)).toBe(true);
  });

  it("a non-numeric equity is unknown, never 0", async () => {
    const { ctx, log } = ctxOf(venue("hyperliquid"), venue("lighter", { getBalance: vi.fn(async () => ({ equity: "n/a", available: "0" })) }));
    await strategy().onTick(ctx, snap);
    expect(placePerpVerified).not.toHaveBeenCalled();
    expect(logged(log, /equity "n\/a" is not a number/)).toBe(true);
  });

  it("a held pair on a venue whose markets are unreadable: no exit decision, logged", async () => {
    const a = venue("hyperliquid", { getPositions: vi.fn(async () => [{ symbol: "ETH", side: "long", size: "0.01" }]) });
    const b = venue("lighter", {
      getPositions: vi.fn(async () => [{ symbol: "ETH", side: "short", size: "0.01" }]),
      getMarkets: boom("markets 500"),
    });
    const { ctx, log } = ctxOf(a, b);
    await strategy().onTick(ctx, snap);
    expect(closePerpVerified).not.toHaveBeenCalled();
    expect(placePerpVerified).not.toHaveBeenCalled();
    expect(a.getTradeHistory).not.toHaveBeenCalled();
    expect(logged(log, /lighter markets unreadable \(markets 500\)/)).toBe(true);
    expect(logged(log, /ETH: rates unavailable on lighter — skipping the exit decision/)).toBe(true);
  });
});

// ── M9: grid ──

describe("grid: failed open-order reads", () => {
  function setup(getOpenOrders: () => Promise<unknown>) {
    const log = vi.fn();
    const ctx = { adapter: { name: "aster", getOpenOrders: vi.fn(getOpenOrders) }, symbol: "ETH", config: { grids: 3, size: 3, rebalance: false }, state: new Map<string, unknown>(), tick: 1, log } as unknown as StrategyContext;
    ctx.state.set("gridUpper", 110);
    ctx.state.set("gridLower", 90);
    ctx.state.set("gridInitialized", true);
    ctx.state.set("gridLevels", [{ price: 90, side: "buy" }, { price: 110, side: "sell" }]);
    const g = new GridStrategy();
    (g as unknown as { _config: Record<string, unknown> })._config = ctx.config;
    return { g, ctx, log };
  }
  const snap = { price: 100 } as EnrichedSnapshot;
  const placed = (acts: StrategyAction[]) => acts.filter(a => a.type === "place_order");

  it("each failure is logged and counted; no counter orders on an unread book; loud warning after N; reset on success", async () => {
    let fail = true;
    const { g, ctx, log } = setup(async () => { if (fail) throw new Error("orders 502"); return []; });
    for (let i = 1; i < GRID_READ_FAILURE_WARN; i++) {
      expect(placed(await g.onTick(ctx, snap))).toHaveLength(0);
    }
    expect(ctx.state.get("gridReadFailures")).toBe(GRID_READ_FAILURE_WARN - 1);
    expect(logged(log, /Open orders read failed \(1\/5\): orders 502/)).toBe(true);
    expect(logged(log, /WARNING/)).toBe(false);
    await g.onTick(ctx, snap);
    expect(logged(log, /WARNING: open orders unreadable for 5 consecutive ticks \(orders 502\).*NOT placing counter orders/)).toBe(true);
    expect(ctx.state.get("gridLevels")).toHaveLength(2); // levels untouched by the failed reads

    fail = false;
    const acts = await g.onTick(ctx, snap);
    expect(ctx.state.get("gridReadFailures")).toBe(0);
    expect(logged(log, /readable again after 5 failed read/)).toBe(true);
    expect(placed(acts)).toHaveLength(2); // both levels now read as filled → counter orders
  });
});

// ── M14: engine TUI data ──

describe("engine TUI reads: a failed venue is flagged, never empty", () => {
  it("positions / open orders read failure → error set", async () => {
    const a = { name: "aster", getPositions: boom("pos 500"), getOpenOrders: boom("ord 500") } as unknown as ExchangeAdapter;
    expect(await fetchPositions(a, "ETH")).toEqual({ positions: [], error: expect.stringContaining("pos 500") });
    expect(await fetchOpenOrders(a, "ETH")).toEqual({ orders: [], error: expect.stringContaining("ord 500") });
  });

  it("a failed balance read lists the venue with error and null amounts", async () => {
    const ok = { name: "aster", getBalance: vi.fn(async () => ({ equity: "10", available: "5" })) } as unknown as ExchangeAdapter;
    const bad = { name: "lighter", getBalance: boom("bal 500") } as unknown as ExchangeAdapter;
    const bals = await fetchExchangeBalances(ok, new Map([["lighter", bad]]));
    expect(bals).toHaveLength(2);
    expect(bals.find(b => b.exchange === "lighter")).toEqual({ exchange: "lighter", equity: null, available: null, error: "bal 500" });
  });

  it("the dashboard renders unavailable venues instead of 'No open positions' / '--' / $0", () => {
    const state: BotTuiState = {
      phase: "running", equity: null, peakEquity: null, dailyPnl: 0, fills: 0, ordersPlaced: 0, totalPnl: 0, runtime: 1,
      strategy: "funding-arb", symbol: "ALL", exchange: "aster", price: 0, volume24h: 0, openInterest: "0", fundingRate: 0, volatility24h: NaN,
      positions: [], openOrders: [], strategyState: {}, tick: 1,
      exchangeBalances: [{ exchange: "aster", equity: "10", available: "5" }, { exchange: "lighter", equity: null, available: null, error: "bal 500" }],
      positionErrors: [{ exchange: "lighter", error: "positions read failed: pos 500" }],
      openOrdersError: "open orders read failed: ord 500",
    };
    const out = renderToString(React.createElement(BotDashboard, { initialState: state, onQuit: () => {}, onPause: () => {}, subscribe: () => () => {} }), { columns: 200 });
    expect(out).toContain("lighter: unavailable (positions read failed: pos 500)");
    expect(out).not.toContain("No open positions");
    expect(out).toContain("Open orders unavailable (open orders read failed: ord 500)");
    expect(out).toContain("unavailable (bal 500)");
    expect(out).toMatch(/Total Equity: unknown/);
  });
});

// ── M6: strategy command venue loading ──

describe("strategy commands: venue initialisation failures", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
  afterEach(() => stderr.mockRestore());

  const getAdapterFor = vi.fn(async (name: string) => {
    if (name === "lighter") throw new Error("no credentials");
    return { name } as unknown as ExchangeAdapter;
  });

  it("explicit list: a failing venue refuses the start with a PerpError naming it and the cause", async () => {
    const err = await loadBotVenueAdapters(["hyperliquid", "lighter"], true, getAdapterFor).catch(e => e);
    expect(err).toBeInstanceOf(PerpError);
    expect(err.message).toMatch(/lighter could not be initialised: no credentials/);
    expect(err.structured.remediation).toMatch(/remove it from --exchanges/);
  });

  it("default list: a failing venue is skipped with a stderr warning naming it and the cause", async () => {
    const adapters = await loadBotVenueAdapters(["hyperliquid", "lighter", "aster"], false, getAdapterFor);
    expect([...adapters.keys()]).toEqual(["hyperliquid", "aster"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/lighter unavailable \(no credentials\)/));
  });

  it("quick-arb --exchanges (user-passed) with a failing venue rejects before starting", async () => {
    const program = new Command().exitOverride().option("-e, --exchange <ex>", "", "hyperliquid").option("-n, --network <n>", "", "mainnet");
    registerStrategyCommands(program, async () => ({ name: "hyperliquid" }) as unknown as ExchangeAdapter, getAdapterFor, () => false);
    await expect(program.parseAsync(["node", "perp", "strategy", "quick-arb", "--exchanges", "hyperliquid,lighter"]))
      .rejects.toThrow(/lighter could not be initialised/);
  });
});
