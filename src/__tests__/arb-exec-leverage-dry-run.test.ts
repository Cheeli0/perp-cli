/**
 * `arb exec --leverage N --dry-run` used to call setLeverage on BOTH venues (a live
 * account write) before reaching the dry-run branch. Under --dry-run the leverage
 * change must only be reported in the plan (sent:false); live runs still set it first.
 *
 * Parsed through the real root program. Venue adapters are stubs; fetch throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Command } from "commander";

const book = {
  asks: Array.from({ length: 20 }, (_, i) => [String(100 + i * 0.01), "50"] as [string, string]),
  bids: Array.from({ length: 20 }, (_, i) => [String(99.99 - i * 0.01), "50"] as [string, string]),
};
const setLeverage = vi.fn(async () => ({}));
const getOrderbook = vi.fn(async () => book);
const marketOrder = vi.fn();
const limitOrder = vi.fn();

function stub(name: string) {
  return {
    name, address: "0x1111111111111111111111111111111111111111",
    setLeverage, getOrderbook, marketOrder, limitOrder,
    getBalance: vi.fn(async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" })),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    getMarkets: vi.fn(async () => []),
  };
}

vi.mock("../exchanges/venue.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../exchanges/venue.js")>();
  return {
    ...orig,
    getVenue: (input: string) => {
      const def = orig.getVenue(input);
      return def.create === null ? def : { ...def, create: async () => stub(def.id) };
    },
  };
});

// arb exec reads each leg's published order minimums from the venue market list (no network here).
vi.mock("../exchanges/legacy-trading-v2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exchanges/legacy-trading-v2.js")>()),
  tradingV2Of: () => ({ getVenueMarkets: async () => [{ symbol: "BTC", minSize: null, minNotional: "10" }] }),
}));

const { buildProgram } = await import("../cli-program.js");
const { allCommands } = await import("../cli-flags.js");

function program(): Command {
  const { program: p } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  for (const c of [p, ...allCommands(p)]) {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  }
  return p;
}

let out: string[];
beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { throw new Error(`unexpected network call: ${String(u)}`); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

const lastJson = () => JSON.parse(out.filter(l => l.trim().startsWith("{")).at(-1)!);

describe("arb exec --leverage under --dry-run", () => {
  it.each([
    [["--json", "--dry-run", "arb", "exec", "BTC", "hl", "pac", "1000", "--leverage", "5", "--isolated"]],
    [["--json", "arb", "exec", "BTC", "hl", "pac", "1000", "--leverage", "5", "--isolated", "--dry-run"]],
  ])("%j → leverage reported in the plan, never set; no order", async (argv) => {
    await program().parseAsync(["node", "perp", ...argv]);
    expect(setLeverage).not.toHaveBeenCalled();
    expect(marketOrder).not.toHaveBeenCalled();
    expect(limitOrder).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({
      ok: true,
      data: { dryRun: true, sent: false, leverage: { value: 5, mode: "isolated" }, long: { exchange: "hyperliquid" }, short: { exchange: "pacifica" } },
    });
  });

  it("control: without --dry-run the leverage IS set on both venues before anything else", async () => {
    // Stop the live run right after the leverage step (orderbook read fails) — no order path.
    getOrderbook.mockRejectedValueOnce(new Error("stop after leverage")).mockRejectedValueOnce(new Error("stop after leverage"));
    await program().parseAsync(["node", "perp", "--json", "arb", "exec", "BTC", "hl", "pac", "100", "--leverage", "5"]).catch(() => undefined);
    expect(setLeverage).toHaveBeenCalledTimes(2);
    expect(setLeverage).toHaveBeenCalledWith("BTC", 5, "cross");
    expect(marketOrder).not.toHaveBeenCalled();
    expect(limitOrder).not.toHaveBeenCalled();
  });
});
