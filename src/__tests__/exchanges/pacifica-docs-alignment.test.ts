/**
 * Pacifica request shapes vs docs.pacifica.fi / pacifica-fi/python-sdk:
 *  - TWAP cancel signs {symbol, order_id}; API Config Key create signs an empty payload
 *  - subaccount transfer signs {to_account, amount}; vault payloads use lake / shares
 *  - a 4xx on /positions/tpsl or /account/leverage is a definite ACTION_REJECTED
 *  - a POST timeout on a write is ORDER_PENDING
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../cache.js", () => ({ invalidateCache: vi.fn() }));

import { PacificaClient } from "../../pacifica/client.js";
import { pacificaVenue } from "../../exchanges/venues/pacifica.js";

const ACCOUNT = "11111111111111111111111111111111";
const sign = async () => new Uint8Array(64);
const HEADER_KEYS = ["account", "agent_wallet", "signature", "timestamp", "expiry_window"];

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(reply(200, { success: true, data: null }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** Payload fields of the last POST (request-header fields removed). */
function sent(): { path: string; payload: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  for (const k of HEADER_KEYS) delete body[k];
  return { path: new URL(String(url)).pathname.replace(/^\/api\/v1/, ""), payload: body };
}

describe("Pacifica request payloads", () => {
  const client = () => new PacificaClient({ baseUrl: "https://pac.test/api/v1" });

  it("cancelTWAP sends order_id (python-sdk rest/cancel_twap_order.py)", async () => {
    await client().cancelTWAP({ symbol: "BTC", order_id: 3 }, ACCOUNT, sign);
    expect(sent()).toEqual({ path: "/orders/twap/cancel", payload: { symbol: "BTC", order_id: 3 } });
  });

  it("createApiKey signs an empty payload", async () => {
    await client().createApiKey(ACCOUNT, sign);
    expect(sent()).toEqual({ path: "/account/api_keys/create", payload: {} });
  });

  it("transferFunds sends to_account + amount only", async () => {
    await client().transferFunds({ to_account: "SUB", amount: "10" }, ACCOUNT, sign);
    expect(sent()).toEqual({ path: "/account/subaccount/transfer", payload: { to_account: "SUB", amount: "10" } });
  });

  it("vault payloads: create omits unset fields; deposit uses lake/amount; withdraw uses lake/shares", async () => {
    const c = client();
    await c.createLake({ manager: null, nickname: "N", initial_deposit: null }, ACCOUNT, sign);
    expect(sent()).toEqual({ path: "/lake/create", payload: { nickname: "N" } });
    await c.depositToLake({ lake: "L", amount: "5" }, ACCOUNT, sign);
    expect(sent()).toEqual({ path: "/lake/deposit", payload: { lake: "L", amount: "5" } });
    await c.withdrawFromLake({ lake: "L", shares: "2" }, ACCOUNT, sign);
    expect(sent()).toEqual({ path: "/lake/withdraw", payload: { lake: "L", shares: "2" } });
  });

  it("has no createSubaccount (both wallets must sign — gated in the CLI)", () => {
    expect((client() as unknown as Record<string, unknown>).createSubaccount).toBeUndefined();
  });
});

describe("Pacifica POST outcomes", () => {
  const client = () => new PacificaClient({ baseUrl: "https://pac.test/api/v1" });

  it("4xx on /account/leverage and /positions/tpsl is ACTION_REJECTED", async () => {
    fetchMock.mockResolvedValue(reply(400, { error: "Invalid leverage", code: 400 }));
    await expect(client().updateLeverage({ symbol: "BTC", leverage: 500 }, ACCOUNT, sign))
      .rejects.toMatchObject({ structured: { code: "ACTION_REJECTED", retryable: false } });
    await expect(client().setTPSL({ symbol: "BTC", side: "ask" }, ACCOUNT, sign, null))
      .rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
  });

  it("a write that times out is ORDER_PENDING and carries an abort signal", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expect(client().updateLeverage({ symbol: "BTC", leverage: 5 }, ACCOUNT, sign))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("Pacifica declared rate limit", () => {
  it("is the documented unidentified-IP quota: 125 credits / 60 s", () => {
    expect(pacificaVenue.rateLimit.capacity).toBe(125);
    expect(pacificaVenue.rateLimit.refillPerSec).toBeCloseTo(125 / 60);
  });
});
