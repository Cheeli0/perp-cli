/**
 * Live 2026-10-13 (delta-neutral, HL spot HYPE + Pacifica short): the spot-perp bot wrote no arb
 * state entry, so `arb status` showed the pair `confirmed: false` and `arb close HYPE` did not
 * detect spot-perp. The bot now records its entry (actual leg sizes, verified fill prices) on
 * the spot adapter's network, and removes / updates it on close and rotation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../exchanges/spot-factory.js", async (orig) => ({
  ...(await orig<typeof import("../exchanges/spot-factory.js")>()),
  // The test spot adapter is not factory-made: its network is the bot's (-n) network.
  spotNetworkOf: () => "mainnet",
}));

import "../exchanges/venues/index.js";
import { SpotPerpArbStrategy } from "../bot/strategies/spot-perp-arb-strategy.js";
import { getPositions, setStateFilePath, resetStateFilePath, addPosition } from "../arb/state.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { StrategyContext } from "../bot/strategy-types.js";

const perp = (name: string) => ({
  name, isUnifiedAccount: true,
  getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
  cancelAllOrders: vi.fn(async () => ({})),
}) as unknown as ExchangeAdapter;

type Internals = {
  executor: Record<string, unknown>;
  tryOpenPosition(spotEx: string, perpEx: string, symbol: string, rate: number, adapters: Map<string, ExchangeAdapter>, ctx: StrategyContext, rates: Map<string, unknown>, bals: Map<string, { equity: number; available: number; marginPct: number }>): Promise<boolean>;
};

function setup(executor: Record<string, unknown>) {
  const hl = perp("hyperliquid");
  const pac = perp("pacifica");
  const adapters = new Map<string, ExchangeAdapter>([["hyperliquid", hl], ["pacifica", pac]]);
  const ctx = { adapter: hl, symbol: "ALL", config: { size_usd: 10 }, state: new Map<string, unknown>(), tick: 0, log: vi.fn() } as unknown as StrategyContext;
  ctx.state.set("extraAdapters", adapters);
  ctx.state.set("spaPositions", []);
  ctx.state.set("riskConfig", { max_position_usd: 1000 });
  const s = new SpotPerpArbStrategy();
  const spotAdapter = { name: "hyperliquid-spot" };
  (s as unknown as Internals).executor = { getSpotAdapter: vi.fn(async () => spotAdapter), ...executor };
  const bals = new Map([["hyperliquid", { equity: 100, available: 100, marginPct: 0 }], ["pacifica", { equity: 100, available: 100, marginPct: 0 }]]);
  return { s, ctx, adapters, bals };
}

describe("spot-perp bot ↔ arb state (1)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "spa-state-")); setStateFilePath(join(dir, "arb-state.json")); });
  afterEach(() => { resetStateFilePath(); rmSync(dir, { recursive: true, force: true }); });

  it("a successful entry is recorded as a spot-perp state entry with the actual leg sizes and verified fill prices", async () => {
    const openPosition = vi.fn(async () => ({ success: true, size: "0.13", notional: 5.5, spotSize: 0.1301, spotAvgPrice: 42.1, perpEntryPrice: 42.3 }));
    const { s, ctx, adapters, bals } = setup({ openPosition });
    expect(await (s as unknown as Internals).tryOpenPosition("hyperliquid", "pacifica", "HYPE", 25, adapters, ctx, new Map(), bals)).toBe(true);
    const st = getPositions("mainnet");
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({
      symbol: "HYPE", mode: "spot-perp", spotExchange: "hyperliquid", spotSymbol: "HYPE/USDC",
      longExchange: "hyperliquid", shortExchange: "pacifica",
      longSize: 0.1301, shortSize: 0.13, entryLongPrice: 42.1, entryShortPrice: 42.3, entrySpread: 25,
    });
    expect(getPositions("testnet")).toHaveLength(0);
  });

  it("an unreported fill price is recorded as null (unknown), never a guess", async () => {
    const openPosition = vi.fn(async () => ({ success: true, size: "0.13", notional: 5.5, spotSize: 0.13, spotAvgPrice: null, perpEntryPrice: 42.3 }));
    const { s, ctx, adapters, bals } = setup({ openPosition });
    await (s as unknown as Internals).tryOpenPosition("hyperliquid", "pacifica", "HYPE", 25, adapters, ctx, new Map(), bals);
    expect(getPositions("mainnet")[0]).toMatchObject({ entryLongPrice: null, entryShortPrice: 42.3 });
  });

  it("a failed entry writes nothing", async () => {
    const openPosition = vi.fn(async () => ({ success: false, error: "liquidity not viable" }));
    const { s, ctx, adapters, bals } = setup({ openPosition });
    await (s as unknown as Internals).tryOpenPosition("hyperliquid", "pacifica", "HYPE", 25, adapters, ctx, new Map(), bals);
    expect(getPositions("mainnet")).toHaveLength(0);
  });

  it("onStop: a full close removes the entry; a partial close sets the legs to the hedged remainder; another symbol's entry is untouched", async () => {
    const closePosition = vi.fn(async ({ symbol }: { symbol: string }) => symbol === "HYPE"
      ? { closed: true, remainingSize: null, manual: false }
      : { closed: false, remainingSize: "0.5", manual: false });
    const { s, ctx } = setup({ closePosition });
    const base = { entryTime: "t", entrySpread: 20, entryLongPrice: 1, entryShortPrice: 1, accumulatedFunding: 0, lastCheckTime: "t", mode: "spot-perp" as const, spotExchange: "hyperliquid", longExchange: "hyperliquid", shortExchange: "pacifica" };
    addPosition("mainnet", { ...base, id: "a", symbol: "HYPE", spotSymbol: "HYPE/USDC", longSize: 0.13, shortSize: 0.13 });
    addPosition("mainnet", { ...base, id: "b", symbol: "PURR", spotSymbol: "PURR/USDC", longSize: 2, shortSize: 2 });
    addPosition("mainnet", { ...base, id: "c", symbol: "ETH", mode: "perp-perp", spotExchange: undefined, spotSymbol: undefined, longExchange: "lighter", longSize: 1, shortSize: 1 });
    ctx.state.set("spaPositions", [
      { id: "a", symbol: "HYPE", spotExchange: "hyperliquid", perpExchange: "pacifica", size: "0.13", entryTime: 1, entryRate: 20, fundingHistory: [], lastFundingCheck: 0 },
      { id: "b", symbol: "PURR", spotExchange: "hyperliquid", perpExchange: "pacifica", size: "2", entryTime: 1, entryRate: 20, fundingHistory: [], lastFundingCheck: 0 },
    ]);
    await s.onStop(ctx);
    const st = getPositions("mainnet");
    expect(st.map(p => p.symbol).sort()).toEqual(["ETH", "PURR"]);
    expect(st.find(p => p.symbol === "PURR")).toMatchObject({ longSize: 0.5, shortSize: 0.5 });
  });

  it("a close of a position the state does not hold for these venues (e.g. recovered from the venues) leaves the state alone", async () => {
    const closePosition = vi.fn(async () => ({ closed: true, remainingSize: null, manual: false }));
    const { s, ctx } = setup({ closePosition });
    addPosition("mainnet", { id: "x", symbol: "HYPE", longExchange: "lighter", shortExchange: "hyperliquid", longSize: 1, shortSize: 1, entryTime: "t", entrySpread: 0, entryLongPrice: 1, entryShortPrice: 1, accumulatedFunding: 0, lastCheckTime: "t" });
    ctx.state.set("spaPositions", [{ id: "r", symbol: "HYPE", spotExchange: "hyperliquid", perpExchange: "pacifica", size: "0.13", entryTime: 0, entryRate: 0, fundingHistory: [], lastFundingCheck: 0 }]);
    await s.onStop(ctx);
    expect(getPositions("mainnet")).toHaveLength(1);
  });
});
