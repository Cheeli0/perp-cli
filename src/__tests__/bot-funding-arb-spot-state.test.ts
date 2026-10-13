/**
 * The funding-arb bot's own spot-perp path (spot buy + perp short on one venue) wrote no arb
 * state entry, so pairs it opened showed `confirmed: false` in `perp arb status` and
 * `perp arb close <SYM>` could not auto-detect them (same gap as spot-perp-arb, see
 * bot-spot-perp-state.test.ts). It now records the entry (actual leg sizes, venue-reported fill
 * prices) on the spot adapter's network, and removes / updates it on full / partial close.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spotAdapter = { name: "hyperliquid-spot", getSpotMarkets: vi.fn(async () => [{ baseToken: "HYPE", sizeDecimals: 2 }]) };
const spotMarketFill = vi.fn();
const placePerpVerified = vi.fn();

vi.mock("../exchanges/spot-factory.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/spot-factory.js")>()),
  getBotSpotAdapter: vi.fn(async () => spotAdapter),
  // The test spot adapter is not factory-made: its network is the bot's (-n) network.
  spotNetworkOf: () => "mainnet",
}));
vi.mock("../liquidity.js", async (orig) => ({
  ...(await orig<typeof import("../liquidity.js")>()),
  checkSpotPerpLiquidity: vi.fn(async () => ({ viable: true, adjustedSizeUsd: 10, spotSlippage: 0.1, perpSlippage: 0.1 })),
}));
vi.mock("../arb-sizing.js", async (orig) => ({
  ...(await orig<typeof import("../arb-sizing.js")>()),
  computeSpotPerpMatchedSize: vi.fn(() => ({ size: "0.24", notional: 10 })),
}));
vi.mock("../exchanges/precision.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/precision.js")>()),
  lotStepOf: vi.fn(async () => "0.01"),
}));
vi.mock("../exchanges/spot-result.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/spot-result.js")>()),
  spotLotStepOf: vi.fn(async () => "0.01"),
  spotMarketFill: (...a: unknown[]) => spotMarketFill(...a),
}));
vi.mock("../bot/strategies/funding-arb-utils.js", async (orig) => ({
  ...(await orig<typeof import("../bot/strategies/funding-arb-utils.js")>()),
  transferUsdcToSpot: vi.fn(async () => false),
  getPriceEstimate: vi.fn(async () => 42),
}));
vi.mock("../bot/perp-order.js", async (orig) => ({
  ...(await orig<typeof import("../bot/perp-order.js")>()),
  placePerpVerified: (...a: unknown[]) => placePerpVerified(...a),
}));
vi.mock("../execution-log.js", () => ({ logExecution: vi.fn(), pruneExecutionLog: vi.fn() }));

import "../exchanges/venues/index.js";
import { FundingArbStrategy } from "../bot/strategies/funding-arb-strategy.js";
import { getPositions, setStateFilePath, resetStateFilePath, addPosition } from "../arb/state.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { StrategyContext } from "../bot/strategy-types.js";

type Opp = { symbol: string; longExchange: string; shortExchange: string; longRate: number; shortRate: number; spread: number; mode: "spot-perp" };
type Pos = { symbol: string; longExchange: string; shortExchange: string; entrySpread: number; size: string; mode: "spot-perp"; entryTime: number };
type Internals = {
  _config: Record<string, unknown>;
  executor: Record<string, unknown>;
  openSpotPerp(opp: Opp, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, rates: Map<string, Map<string, unknown>>): Promise<boolean>;
  closeSpotPerp(pos: Pos, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext): Promise<boolean>;
};

function setup(executor: Record<string, unknown> = {}) {
  const hl = {
    name: "hyperliquid",
    setLeverage: vi.fn(async () => ({})),
    getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
  } as unknown as ExchangeAdapter;
  const adapters = new Map<string, ExchangeAdapter>([["hyperliquid", hl]]);
  const ctx = { adapter: hl, symbol: "ALL", config: {}, state: new Map<string, unknown>(), tick: 0, log: vi.fn() } as unknown as StrategyContext;
  ctx.state.set("arbOpenPositions", []);
  const s = new FundingArbStrategy() as unknown as Internals;
  s._config = { size_usd: 10, leverage: 2, max_positions: 3 };
  s.executor = executor;
  const rates = new Map([["hyperliquid", new Map([["HYPE", { rate: 0.0001, price: 42, maxLeverage: 5 }]])]]);
  return { s, ctx, adapters, rates };
}

const opp: Opp = { symbol: "HYPE", longExchange: "hyperliquid-spot", shortExchange: "hyperliquid", longRate: 0, shortRate: 0.0001, spread: 30, mode: "spot-perp" };

describe("funding-arb spot-perp ↔ arb state", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fa-state-"));
    setStateFilePath(join(dir, "arb-state.json"));
    spotMarketFill.mockReset();
    placePerpVerified.mockReset();
  });
  afterEach(() => { resetStateFilePath(); rmSync(dir, { recursive: true, force: true }); });

  it("a successful entry is recorded as a spot-perp state entry with the actual leg sizes and venue-reported fill prices", async () => {
    spotMarketFill.mockResolvedValue({ status: "filled", filledSize: 0.2401, avgPrice: 42.1, orderId: "s1", raw: {} });
    placePerpVerified.mockResolvedValue({ filledSize: 0.24, raw: { avgPrice: "42.3" } });
    const { s, ctx, adapters, rates } = setup();
    expect(await s.openSpotPerp(opp, adapters, ctx, rates)).toBe(true);
    const st = getPositions("mainnet");
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({
      symbol: "HYPE", mode: "spot-perp", spotExchange: "hyperliquid", spotSymbol: "HYPE/USDC",
      longExchange: "hyperliquid", shortExchange: "hyperliquid",
      longSize: 0.2401, shortSize: 0.24, entryLongPrice: 42.1, entryShortPrice: 42.3, entrySpread: 30,
    });
    expect(getPositions("testnet")).toHaveLength(0);
  });

  it("an unreported perp fill price is recorded as null (unknown), never the protection price", async () => {
    spotMarketFill.mockResolvedValue({ status: "filled", filledSize: 0.24, avgPrice: null, orderId: "s1", raw: {} });
    placePerpVerified.mockResolvedValue({ filledSize: 0.24, raw: { price: "40" } });
    const { s, ctx, adapters, rates } = setup();
    await s.openSpotPerp(opp, adapters, ctx, rates);
    expect(getPositions("mainnet")[0]).toMatchObject({ entryLongPrice: null, entryShortPrice: null });
  });

  it("a failed perp short (rolled back) writes nothing", async () => {
    spotMarketFill.mockResolvedValueOnce({ status: "filled", filledSize: 0.24, avgPrice: 42, orderId: "s1", raw: {} })
      .mockResolvedValueOnce({ status: "filled", filledSize: 0.24, avgPrice: 42, orderId: "s2", raw: {} });
    placePerpVerified.mockRejectedValue(new Error("insufficient margin"));
    const { s, ctx, adapters, rates } = setup();
    expect(await s.openSpotPerp(opp, adapters, ctx, rates)).toBe(false);
    expect(getPositions("mainnet")).toHaveLength(0);
  });

  const base = { entryTime: "t", entrySpread: 20, entryLongPrice: 1, entryShortPrice: 1, accumulatedFunding: 0, lastCheckTime: "t", mode: "spot-perp" as const, spotExchange: "hyperliquid", longExchange: "hyperliquid", shortExchange: "hyperliquid" };
  const pos = (symbol: string, size: string): Pos => ({ symbol, longExchange: "hyperliquid-spot", shortExchange: "hyperliquid", entrySpread: 20, size, mode: "spot-perp", entryTime: 1 });

  it("a full close removes the entry; another symbol's entry is untouched", async () => {
    const { s, ctx, adapters } = setup({ closePosition: vi.fn(async () => ({ closed: true, remainingSize: null, manual: false })) });
    addPosition("mainnet", { ...base, id: "a", symbol: "HYPE", spotSymbol: "HYPE/USDC", longSize: 0.24, shortSize: 0.24 });
    addPosition("mainnet", { ...base, id: "b", symbol: "PURR", spotSymbol: "PURR/USDC", longSize: 2, shortSize: 2 });
    expect(await s.closeSpotPerp(pos("HYPE", "0.24"), adapters, ctx)).toBe(true);
    expect(getPositions("mainnet").map(p => p.symbol)).toEqual(["PURR"]);
  });

  it("a partial close sets the legs to the hedged remainder", async () => {
    const { s, ctx, adapters } = setup({ closePosition: vi.fn(async () => ({ closed: false, remainingSize: "0.1", manual: false })) });
    addPosition("mainnet", { ...base, id: "a", symbol: "HYPE", spotSymbol: "HYPE/USDC", longSize: 0.24, shortSize: 0.24 });
    const p = pos("HYPE", "0.24");
    expect(await s.closeSpotPerp(p, adapters, ctx)).toBe(false);
    expect(p.size).toBe("0.1");
    expect(getPositions("mainnet")[0]).toMatchObject({ longSize: 0.1, shortSize: 0.1 });
  });

  it("a close of a pair the state holds for other venues leaves the state alone", async () => {
    const { s, ctx, adapters } = setup({ closePosition: vi.fn(async () => ({ closed: true, remainingSize: null, manual: false })) });
    addPosition("mainnet", { id: "x", symbol: "HYPE", longExchange: "lighter", shortExchange: "hyperliquid", longSize: 1, shortSize: 1, entryTime: "t", entrySpread: 0, entryLongPrice: 1, entryShortPrice: 1, accumulatedFunding: 0, lastCheckTime: "t" });
    await s.closeSpotPerp(pos("HYPE", "0.24"), adapters, ctx);
    expect(getPositions("mainnet")).toHaveLength(1);
  });
});
