/**
 * Live mainnet findings 2026-10-12:
 *  - `strategy start <config>` ran every non-funding-arb config on the CLI default venue
 *    (config "exchange":"aster" → pacifica). The config's venue now wins; a contradicting
 *    explicit `-e` is INVALID_PARAMS.
 *  - exit_conditions `time_after` never stopped the bot: a met exit returned to monitoring, the
 *    "always" entry re-entered at once, and the cycle repeated until SIGINT. A met runtime limit
 *    now ends the bot.
 */
import { describe, it, expect, vi } from "vitest";
import "../exchanges/venues/index.js";
import { loadBotConfig, resolveConfigVenue, type BotConfig } from "../bot/config.js";
import { runBot } from "../bot/engine.js";
import { registerStrategy } from "../bot/strategy-registry.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

describe("bot config venue", () => {
  const def = { id: "pacifica" as const, explicit: false };

  it("config.exchange (alias resolved) wins over the CLI default", () => {
    const c = loadBotConfig(JSON.stringify({ exchange: "aster", symbol: "SOL", strategy: { type: "grid" } }), def);
    expect(c.exchange).toBe("aster");
    expect(resolveConfigVenue("hl", def)).toBe("hyperliquid");
  });

  it("no exchange in the config → the CLI selection (no hard-coded venue)", () => {
    const c = loadBotConfig(JSON.stringify({ symbol: "SOL", strategy: { type: "grid" } }), { id: "lighter", explicit: false });
    expect(c.exchange).toBe("lighter");
  });

  it("an explicit -e naming another venue → INVALID_PARAMS", () => {
    expect(() => loadBotConfig(JSON.stringify({ exchange: "aster", strategy: { type: "grid" } }), { id: "pacifica", explicit: true }))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
    expect(resolveConfigVenue("aster", { id: "aster", explicit: true })).toBe("aster");
  });

  it("unknown venue / non-string exchange is refused", () => {
    expect(() => resolveConfigVenue("nope", def)).toThrow();
    expect(() => loadBotConfig(JSON.stringify({ exchange: 5, strategy: { type: "grid" } }), def))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});

describe("time_after ends the bot", () => {
  function adapter(): ExchangeAdapter {
    return {
      name: "hyperliquid",
      getMarkets: vi.fn(async () => [{ symbol: "ETH", markPrice: "100", indexPrice: "100", fundingRate: "0", volume24h: "1", openInterest: "1", maxLeverage: 10 }]),
      getKlines: vi.fn(async () => []),
      getOrderbook: vi.fn(async () => ({ bids: [], asks: [] })),
      getBalance: vi.fn(async () => ({ equity: "100", available: "100", marginUsed: "0", unrealizedPnl: "0" })),
      getPositions: vi.fn(async () => []),
      getOpenOrders: vi.fn(async () => []),
      cancelAllOrders: vi.fn(async () => ({})),
    } as unknown as ExchangeAdapter;
  }

  function config(runtimeSec: number): BotConfig {
    return {
      name: "t", exchange: "hyperliquid", symbol: "ETH", strategy: { type: "test-runtime" } as never,
      entry_conditions: [{ type: "always", value: 0 }], exit_conditions: [{ type: "time_after", value: runtimeSec }],
      risk: { max_position_usd: 1000, max_daily_loss: 100, max_drawdown: 200, pause_after_loss_sec: 0, max_open_bots: 1 },
      monitor_interval_sec: 0.02,
    };
  }

  it("stops after the runtime instead of re-entering forever (onStop once, init once)", async () => {
    const init = vi.fn(async () => {});
    const onStop = vi.fn(async () => []);
    registerStrategy("test-runtime", () => ({ name: "test-runtime", init, onTick: async () => [], onStop } as never));
    const t0 = Date.now();
    await runBot(adapter(), config(0.15), undefined, () => {}, undefined, "headless", false);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(init).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("a runtime already over before the strategy ever ran stops without starting it", async () => {
    const init = vi.fn(async () => {});
    registerStrategy("test-runtime", () => ({ name: "test-runtime", init, onTick: async () => [], onStop: async () => [] } as never));
    await runBot(adapter(), config(-1), undefined, () => {}, undefined, "headless", false);
    expect(init).not.toHaveBeenCalled();
  });
});
