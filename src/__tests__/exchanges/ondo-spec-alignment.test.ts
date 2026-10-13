/**
 * Ondo Perps alignment with docs.ondoperps.xyz rest-spec.json:
 *  - spot↔perp transfer is POST /v1/spot/transfers with SpotWalletKey "spot" ↔ "margin"
 *  - a rejection naming the delayed placement path is CAPABILITY_UNSUPPORTED (not implemented)
 *  - venue error codes map onto CLI codes with venue-specific remediation
 *  - approve reads key scopes from GET /v1/api_keys and refuses disabled perps / API keys
 *  - withdraw reports AccountInfo.withdrawalFeeUSD
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import "../../exchanges/venues/index.js";
import { OndoClient } from "../../exchanges/ondo/client.js";
import { OndoSpotAdapter } from "../../exchanges/ondo/spot.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { approveOndoAgent } from "../../exchanges/ondo/agent.js";
import { PerpError } from "../../errors.js";

const KEY = { keyId: "ondoKeyId_test1", secret: "ondoApiSecret_s3cret" };

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function client() {
  return new OndoClient({ restUrl: "https://api.ondo.test", network: "testnet", rateLimit: { capacity: 1, refillPerSec: 1, weights: null }, credentials: KEY });
}

describe("Ondo spot↔perp transfer wallet keys", () => {
  it.each([
    ["transferToSpot", "margin", "spot"],
    ["transferToPerp", "spot", "margin"],
  ] as const)("%s sends from=%s to=%s", async (fn, from, to) => {
    const perp = { restClient: client(), accountId: async () => "acc1" } as unknown as OndoAdapter;
    const spot = new OndoSpotAdapter(perp);
    fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
    const r = await spot[fn]("10", "USDC");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.ondo.test/v1/spot/transfers");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ symbol: "USDC", amount: "10", from: { wallet: from }, to: { wallet: to } });
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
  });
});

describe("Ondo spot delayed placement", () => {
  const pairs = { success: true, result: { spot: { tradingPairs: [{ market: "TSLA-USDC", pair: { base: "TSLA", quote: "USDC" }, baseIncrement: "0.01", quoteIncrement: "0.01", disabled: false }] } } };

  it("a rejection directing to the delayed path is CAPABILITY_UNSUPPORTED and is not resubmitted", async () => {
    const perp = { restClient: client(), accountId: async () => "acc1" } as unknown as OndoAdapter;
    const spot = new OndoSpotAdapter(perp);
    fetchMock
      .mockResolvedValueOnce(reply(200, pairs))
      .mockResolvedValueOnce(reply(400, { success: false, error: "use /v1/spot/orders/delayed", error_code: "bad_request" }));
    const err = await spot.spotLimitOrder("TSLA", "buy", "100", "1", { tif: "GTC" }).catch(e => e) as PerpError;
    expect(err.structured.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(err.structured.remediation).toMatch(/not implemented/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.ondo.test/v1/spot/orders");
  });
});

describe("Ondo error code mapping", () => {
  it.each([
    ["transfer_amount_precision_overflow", "INVALID_PARAMS", /precision/],
    ["transfer_amount_too_precise", "INVALID_PARAMS", /precision/],
    ["clientOrderID_collision", "DUPLICATE_ORDER", /client order id/],
    ["clientOrderID_chars_invalid", "INVALID_PARAMS", /letters/],
    ["clientOrderID_length_invalid", "INVALID_PARAMS", /Shorten/],
    ["net_position_too_large", "SIZE_TOO_LARGE", /net position/],
    ["insufficient_liquidity", "ORDER_REJECTED", /liquidity/],
    ["mark_price_not_available", "PRICE_STALE", /Mark price/],
    ["market_orders_disabled", "CAPABILITY_UNSUPPORTED", /limit order/],
    ["trading_disabled", "CAPABILITY_UNSUPPORTED", /disabled/],
    ["bad_withdrawal_address", "INVALID_PARAMS", /address book/],
    ["withdrawal_address_not_found", "INVALID_PARAMS", /address book/],
    ["withdrawal_amount_too_small", "SIZE_TOO_SMALL", /minimum/],
  ])("%s → %s", async (venueCode, code, remediation) => {
    fetchMock.mockResolvedValueOnce(reply(400, { success: false, error: "nope", error_code: venueCode }));
    const err = await client().get("/v1/account", null).catch(e => e) as PerpError;
    expect(err).toBeInstanceOf(PerpError);
    expect(err.structured.code).toBe(code);
    expect(err.structured.remediation).toMatch(remediation);
  });

  it("timestamp_too_far remediation states the documented window (10 s behind / 1 s ahead)", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { success: false, error: "nope", error_code: "timestamp_too_far" }));
    const err = await client().get("/v1/account", null).catch(e => e) as PerpError;
    expect(err.structured.code).toBe("SIGNATURE_FAILED");
    expect(err.structured.remediation).toMatch(/10 s behind or 1 s ahead/);
    expect(err.structured.remediation).not.toMatch(/30/);
  });
});

describe("approveOndoAgent", () => {
  const account = (extra: Record<string, unknown> = {}) => reply(200, { success: true, result: { accountID: "acc1", accountState: "open", withdrawalFeeUSD: "1.5", ...extra } });

  // Live mainnet 2026-10-05: GET /v1/api_keys rejects API-key auth (403 key_not_allowed_for_action),
  // so the import must not call it; scopes are recorded as unknown.
  it("stores the key after GET /v1/account only; scopes are unknown", async () => {
    fetchMock.mockResolvedValueOnce(account());
    const meta = await approveOndoAgent({ agentName: "a", keyId: KEY.keyId, secret: KEY.secret, network: "testnet" });
    expect(meta.scopes).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/account$/);
  });

  it.each([
    [{ disablePerps: true }, /perps disabled/],
    [{ disableAPIKeys: true }, /API keys disabled/],
  ])("refuses an account with %o", async (disabledFunctionality, msg) => {
    fetchMock.mockResolvedValueOnce(account({ disabledFunctionality }));
    await expect(approveOndoAgent({ agentName: "a", keyId: KEY.keyId, secret: KEY.secret, network: "testnet" }))
      .rejects.toMatchObject({ structured: { code: "APPROVE_FAILED", message: expect.stringMatching(msg) } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

describe("OndoAdapter.withdraw", () => {
  it("returns withdrawalFeeUSD from GET /v1/account alongside the venue result", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { success: true, result: { accountID: "acc1", withdrawalFeeUSD: "2.00" } }))
      .mockResolvedValueOnce(reply(200, { success: true, result: { withdrawal_status: "pending", withdrawal_id: "w1", customer_withdrawal_id: "c1" } }));
    const a = Object.create(OndoAdapter.prototype) as OndoAdapter;
    (a as unknown as { client: OndoAdapter["client"] }).client = client();
    const r = await a.withdraw("10", "0x" + "1".repeat(40));
    expect(r).toMatchObject({ withdrawal_id: "w1", withdrawalFeeUSD: "2.00" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).from).toEqual({ id: "acc1", wallet: "margin" });
  });
});
