/**
 * Ondo position stops (POST /v1/perps/stop_order) with the live mainnet shapes of 2026-10-05:
 * a stop set with `quantity` is a PARTIAL stop — the resulting order carries `size` (not
 * closePosition), type "stopMarket" (stopLoss) / "takeProfitMarket" (takeProfit), status
 * "untriggered". The endpoint returns no order id, so the order is located in the order list.
 * `trade tpsl --tp --sl` places BOTH legs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import "../../exchanges/venues/index.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerTradeCommands } from "../../commands/trade.js";
import { OndoClient } from "../../exchanges/ondo/client.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";
import type { OrderRequest } from "../../exchanges/venue-types.js";

const MARKET = "ETH-USD.P";
const SL_ORDER = {
  orderId: "sl-1", side: "sell", price: "0", size: "0.005", market: MARKET, filledSize: "0", filledCost: "0", fee: "0",
  createdAt: "2026-10-05T00:00:00Z", reduceOnly: true,
  type: "stopMarket", stopOrderType: "stopLoss", status: "untriggered", triggerPrice: "2573.5",
};
const TP_ORDER = { ...SL_ORDER, orderId: "tp-1", type: "takeProfitMarket", stopOrderType: "takeProfit", triggerPrice: "2850" };
const POSITION = { market: MARKET, direction: "long", netQuantity: "0.005", averageEntryPrice: "2700", markPrice: "2700", unrealizedPnl: "0", leverage: "5" };

let posts: Array<{ path: string; body: Record<string, unknown> }>;
let orders: Array<Record<string, unknown>>;

function reply(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ success: true, result: body }) };
}

beforeEach(() => {
  posts = [];
  orders = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST" && path === "/v1/perps/stop_order") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      // The venue creates the order; its answer carries no order id (live shape).
      orders.push(body.type === "stopLoss" ? SL_ORDER : TP_ORDER);
      return reply({ orderId: "…", market: MARKET, positionDirection: "long", stopLoss: body.type === "stopLoss" ? "2573.5" : null, takeProfit: body.type === "takeProfit" ? "2850" : null });
    }
    if (path === "/v1/perps/orders") return reply(orders);
    if (path === "/v1/perps/mark_prices") return reply({ [MARKET]: { markPrice: "2700" } });
    if (path === "/v1/perps/positions") return reply([POSITION]);
    throw new Error(`unexpected Ondo request: ${init?.method ?? "GET"} ${path}`);
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function adapter(): OndoAdapter {
  const def = getVenue("ondo");
  const a = Object.create(OndoAdapter.prototype) as OndoAdapter & Record<string, unknown>;
  Object.assign(a, {
    name: "ondo", venue: def, network: "mainnet", caps: requireCapabilities(def), builderFee: null,
    client: new OndoClient({ restUrl: "https://api.ondo.test", network: "mainnet", rateLimit: { capacity: 1, refillPerSec: 1, weights: null }, credentials: { keyId: "k", secret: "s" } }),
    pairsCache: { at: Date.now(), byMarket: new Map([[MARKET, { market: MARKET, baseIncrement: "0.001", quoteIncrement: "0.1" }]]) },
  });
  return a;
}

const stop = (trigger: string, size = "0.005"): OrderRequest => ({
  symbol: "ETH", side: "sell", type: "stopMarket", size, price: null, triggerPrice: trigger, triggerSource: null,
  tif: null, reduceOnly: true, clientOrderId: null, slippage: null, tpsl: null,
});

describe("Ondo placePositionStop — the partial stop is located in the order list", () => {
  it("stop-loss below the mark of a long: type stopLoss + quantity; matched to the untriggered stopMarket order", async () => {
    const r = await adapter().placeOrder(stop("2573.5"));
    expect(posts).toEqual([{ path: "/v1/perps/stop_order", body: { market: MARKET, positionDirection: "long", type: "stopLoss", triggerPrice: "2573.5", quantity: "0.005" } }]);
    expect(r).toMatchObject({ venue: "ondo", symbol: "ETH", orderId: "sl-1", status: "open" });
  });

  it("take-profit above the mark of a long: type takeProfit; matched to the untriggered takeProfitMarket order", async () => {
    const r = await adapter().placeOrder(stop("2850"));
    expect(posts[0].body).toMatchObject({ type: "takeProfit", triggerPrice: "2850", quantity: "0.005" });
    expect(r).toMatchObject({ orderId: "tp-1", status: "open" });
  });

  it("an order of the other kind, size or trigger is never taken for the new stop", async () => {
    const a = adapter();
    // Only a take-profit and a differently sized stop-loss are listed after the stop-loss request.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") return reply({ orderId: "…", market: MARKET, positionDirection: "long", stopLoss: "2573.5", takeProfit: null });
      if (path === "/v1/perps/orders") return reply([TP_ORDER, { ...SL_ORDER, size: "0.004" }, { ...SL_ORDER, triggerPrice: "2500" }]);
      return reply({ [MARKET]: { markPrice: "2700" } });
    }));
    // The POST succeeded: no identifiable new stop → ORDER_PENDING (do NOT resubmit), never EXCHANGE_ERROR.
    await expect(a.placeOrder(stop("2573.5"))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });
});

describe("trade tpsl --tp --sl on ondo places BOTH legs", () => {
  it("one stop_order request per leg, each reported with its own order id", async () => {
    const a = adapter();
    const program = new Command();
    addRootSafetyOptions(program);
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerTradeCommands(program, async () => a, () => true);
    await program.parseAsync(["node", "perp", "trade", "tpsl", "ETH", "long", "--tp", "2850", "--sl", "2573.5"]);

    expect(posts.map(p => p.body)).toEqual([
      { market: MARKET, positionDirection: "long", type: "takeProfit", triggerPrice: "2850", quantity: "0.005" },
      { market: MARKET, positionDirection: "long", type: "stopLoss", triggerPrice: "2573.5", quantity: "0.005" },
    ]);
    const out = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as { ok: boolean; data: { legs: Array<{ kind: string; orderId: string; status: string }> } };
    expect(out.ok).toBe(true);
    expect(out.data.legs.map(l => [l.kind, l.orderId, l.status])).toEqual([["tp", "tp-1", "open"], ["sl", "sl-1", "open"]]);
  });
});
