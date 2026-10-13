/**
 * Pre-mainnet review — QFEX: a rejection frame AFTER the ACK must not erase an earlier partial
 * fill reported by an order_response (the fill frame may not have arrived yet).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import { PerpError } from "../../errors.js";
import { QfexTradeSession, type QfexTimeouts } from "../../exchanges/qfex/ws-transport.js";
import { orderResponse, startFakeQfexServer, type FakeQfexServer } from "../helpers/qfex-fake-server.js";

const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAST: QfexTimeouts = { connectMs: 1000, authMs: 300, subscribeMs: 300, ackMs: 150, immediateFinalMs: 300, postOnlyFinalMs: 200, fillsMs: 80, cancelMs: 150, readMs: 200 };
const REJECT = "INVALID_TICK_SIZE_PRECISION_PRICE";
let server: FakeQfexServer;
let s: QfexTradeSession;

beforeEach(async () => {
  server = await startFakeQfexServer();
  s = new QfexTradeSession({
    url: server.url, network: "testnet", credentials: { publicKey: "qfex_pub_test", secret: "qfex_secret_test" },
    accountId: "11111111-1111-4111-8111-111111111111", builderCode: null, rateLimit: { capacity: 100, refillPerSec: 50, weights: null },
    timeouts: FAST, idleCloseMs: 5_000,
  });
});
afterEach(async () => { await s.close(); await server.close(); });

const add = () => s.addOrder({
  params: { symbol: "AAPL-USD", side: "BUY", order_type: "LIMIT", order_time_in_force: "IOC", quantity: 1, price: 333.4, client_order_id: CID },
  immediate: true, lotSize: "0.001", band: null,
});

describe("QFEX add_order: post-ACK rejection", () => {
  it("after a PARTIALLY filled order_response (no fill frame yet) → NOT thrown as 'never traded'", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "FILLED", quantity: 1, quantity_remaining: 0.6 }));
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: REJECT, quantity: 1, quantity_remaining: 0.6 }));
    };
    const r = await add();
    expect(r.terminal?.status).toBe(REJECT);
    expect(r.responses.map(x => x.status)).toEqual(["ACK", "FILLED", REJECT]);
  });

  it("a rejection frame that itself reports less remaining than ordered is kept as the terminal of a partial fill", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: REJECT, quantity: 1, quantity_remaining: 0.25 }));
    };
    await expect(add()).resolves.toMatchObject({ terminal: { status: REJECT } });
  });

  it("with nothing filled at all it is still a definite rejection", async () => {
    server.onCommand = (conn, msg) => {
      if (msg.type !== "add_order") return;
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: "ACK", quantity: 1, quantity_remaining: 1 }));
      conn.send(orderResponse({ order_id: "o1", client_order_id: CID, status: REJECT, quantity: 1, quantity_remaining: 1 }));
    };
    const e = await add().then(() => null, (x: unknown) => x as PerpError);
    expect(e?.structured.code).toBe("INVALID_TICK");
  });
});
