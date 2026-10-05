/**
 * Live testnet E2E round 7 (2026-10-02) fixes, with the venues' real responses:
 * - Lighter / Lighter RH `trade spot-transfer to-spot` → sendTx "invalid ToAccount: . You can't
 *   transfer from the same account to itself in unified mode with a universal asset" (UNKNOWN).
 *   The testnet accounts (537, 354) are Unified Trading Accounts (`account_trading_mode: 1`;
 *   lighter-python models/account.py: Classic=0, Unified=1): spot and perp share the USDC margin,
 *   so spot-transfer is the sharedAccount no-op. Classic accounts keep the self-transfer.
 *   Any explicit non-200 sendTx code is a definite venue rejection (validated before execution).
 * - Pacifica `funds withdraw pacifica 1` → 422 {"error":"Withdraw amount too low: 1","code":29}
 *   (UNKNOWN) → INVALID_PARAMS (code 29 WITHDRAW_AMOUNT_TOO_LOW, docs.pacifica.fi error codes).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../exchanges/venues/index.js";
import { getVenue } from "../exchanges/venue.js";
import { LighterAdapter, lighterSendTxRejection } from "../exchanges/lighter.js";
import { LighterSpotAdapter } from "../exchanges/lighter-spot.js";
import { PacificaAdapter, PACIFICA_WITHDRAW_MIN_USDC, pacificaWithdrawRejection } from "../exchanges/pacifica.js";
import { getSpotAdapter, spotSharesPerpMargin, transferQuoteToPerp, transferQuoteToSpot } from "../exchanges/spot-factory.js";
import { setSharedApiNetwork } from "../api/public/urls.js";
import { isDefiniteOrderFailure, PerpError } from "../errors.js";
import { PROFILES } from "../../scripts/e2e/venues.js";
import { Keypair } from "@solana/web3.js";
import type { SpotAdapter } from "../exchanges/spot-interface.js";

afterEach(() => {
  setSharedApiNetwork("mainnet");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// GET https://testnet.zklighter.elliot.ai/api/v1/account?by=index&value=537 (2026-10-02), trimmed.
const LT_UNIFIED_ACCOUNT = {
  code: 0, account_type: 0, index: 537, account_index: 537, l1_address: "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3",
  available_balance: "9999.802247", collateral: "9999.802247", total_asset_value: "9999.802247", account_trading_mode: 1,
  assets: [{ symbol: "USDC", asset_id: 3, balance: "0.000000", locked_balance: "0.000000", margin_mode: "enabled", margin_balance: "9999.802247161996" }],
};
// sendTx refusal of the s-transfer-in self-transfer (report 2026-10-02T07-12-51-759Z-lighter-rh-testnet).
const LT_UNIFIED_TRANSFER_MSG = "invalid ToAccount: . You can't transfer from the same account to itself in unified mode with a universal asset";

function ltAccount(acct: Record<string, unknown> | null | Error, address = "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3") {
  const a = Object.create(LighterAdapter.prototype) as LighterAdapter & Record<string, unknown>;
  a.name = "lighter-rh";
  a._address = address;
  a._tradingMode = null;
  a.fetchAccount = vi.fn(async () => { if (acct instanceof Error) throw acct; return acct; });
  return a;
}

describe("Lighter account trading mode (account_trading_mode)", () => {
  it("Unified (1) → isUnifiedAccount true; Classic (0) → false", async () => {
    const u = ltAccount(LT_UNIFIED_ACCOUNT);
    await u.resolveAccountTradingMode();
    expect(u.isUnifiedAccount).toBe(true);
    const c = ltAccount({ ...LT_UNIFIED_ACCOUNT, account_trading_mode: 0 });
    await c.resolveAccountTradingMode();
    expect(c.isUnifiedAccount).toBe(false);
  });

  it("never assumes a mode: not read / missing field / failed read / no address → isUnifiedAccount throws", async () => {
    expect(() => ltAccount(LT_UNIFIED_ACCOUNT).isUnifiedAccount).toThrow(/trading mode unknown: not read/);
    const cases: Array<[LighterAdapter, RegExp]> = [
      [ltAccount({ ...LT_UNIFIED_ACCOUNT, account_trading_mode: undefined }), /account_trading_mode is undefined/],
      [ltAccount({ ...LT_UNIFIED_ACCOUNT, account_trading_mode: 2 }), /account_trading_mode is 2/],
      [ltAccount(new Error("GET /account failed (503): down")), /GET \/account failed \(503\)/],
      [ltAccount(null), /no account found/],
      [ltAccount(LT_UNIFIED_ACCOUNT, ""), /no account address configured/],
    ];
    for (const [a, re] of cases) {
      await a.resolveAccountTradingMode(); // never throws itself: public spot reads keep working
      let err: unknown;
      try { void a.isUnifiedAccount; } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PerpError);
      expect((err as PerpError).structured.code).toBe("EXCHANGE_ERROR");
      expect((err as PerpError).message).toMatch(re);
    }
  });

  it("LighterSpotAdapter.init reads the mode (spot paths have it before any transfer)", async () => {
    const lt = ltAccount(LT_UNIFIED_ACCOUNT);
    const spot = new LighterSpotAdapter(lt);
    (spot as unknown as { _loadSpotMarkets: () => Promise<void> })._loadSpotMarkets = vi.fn(async () => {});
    await spot.init();
    expect(lt.isUnifiedAccount).toBe(true);
  });

  it("lighter + lighter-rh spot accountModel is runtime", () => {
    expect(getVenue("lighter").spot?.accountModel).toBe("runtime");
    expect(getVenue("lighter-rh").spot?.accountModel).toBe("runtime");
  });
});

describe("spot-transfer on Lighter-family: unified → sharedAccount no-op, classic → transfer", () => {
  async function spotFor(unified: boolean) {
    setSharedApiNetwork("testnet");
    const rh = getVenue("lighter-rh");
    const transferToSpot = vi.fn().mockResolvedValue({ ok: true });
    const transferToPerp = vi.fn().mockResolvedValue({ ok: true });
    const fake = { name: "lighter-rh", transferToSpot, transferToPerp } as unknown as SpotAdapter;
    vi.spyOn(rh.spot!, "createSpot").mockResolvedValue(fake);
    const perp = ltAccount({ ...LT_UNIFIED_ACCOUNT, account_trading_mode: unified ? 1 : 0 });
    await perp.resolveAccountTradingMode();
    const spot = await getSpotAdapter("lighter-rh", perp);
    return { rh, perp, spot: spot!, transferToSpot, transferToPerp };
  }

  it("unified: nothing is sent (moved = false → execution.method sharedAccount), both directions", async () => {
    const { rh, perp, spot, transferToSpot, transferToPerp } = await spotFor(true);
    expect(spotSharesPerpMargin(rh, perp)).toBe(true);
    await expect(transferQuoteToSpot(spot, 26.65)).resolves.toBe(false);
    await expect(transferQuoteToPerp(spot, 26.65)).resolves.toBe(false);
    expect(transferToSpot).not.toHaveBeenCalled();
    expect(transferToPerp).not.toHaveBeenCalled();
  });

  it("classic: the self-transfer is kept", async () => {
    const { rh, perp, spot, transferToSpot } = await spotFor(false);
    expect(spotSharesPerpMargin(rh, perp)).toBe(false);
    await expect(transferQuoteToSpot(spot, 26.65)).resolves.toBe(true);
    expect(transferToSpot).toHaveBeenCalledWith("26.65", "USDC");
  });
});

describe("Lighter sendTx explicit rejection → definite (was UNKNOWN)", () => {
  // The refusal's numeric code was not in the report; 21500 stands in for "any non-200 code".
  const refusal = { code: 21500, message: LT_UNIFIED_TRANSFER_MSG };
  const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })));

  it("action (transfer / withdraw / leverage) → ACTION_REJECTED; order → ORDER_REJECTED; both definite", () => {
    const a = lighterSendTxRejection("lighter-rh", refusal, "action");
    expect(a.structured).toMatchObject({ code: "ACTION_REJECTED", retryable: false, details: { venueCode: 21500 } });
    expect(a.message).toContain(LT_UNIFIED_TRANSFER_MSG);
    const o = lighterSendTxRejection("lighter", refusal, "order");
    expect(o.structured.code).toBe("ORDER_REJECTED");
    expect(isDefiniteOrderFailure(a) && isDefiniteOrderFailure(o)).toBe(true);
  });

  it("a balance refusal keeps INSUFFICIENT_BALANCE (spot-transfer shortfall sizing still applies)", () => {
    expect(lighterSendTxRejection("lighter", { code: 21500, message: "not enough balance" }, "action").structured.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("perp adapter sendTx (withdraw / leverage path) throws ACTION_REJECTED", async () => {
    const a = Object.create(LighterAdapter.prototype) as LighterAdapter & Record<string, unknown>;
    a.name = "lighter-rh";
    a._baseUrl = "https://api.rh-testnet.lighter.xyz";
    a.rhRate = vi.fn(async () => {});
    respond(refusal);
    const send = (a as unknown as { sendTx: (s: unknown, k: "order" | "action") => Promise<unknown> }).sendTx.bind(a);
    await expect(send({ txType: 12, txInfo: "{}" }, "action")).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
    await expect(send({ txType: 14, txInfo: "{}" }, "order")).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });

  it("spot adapter self-transfer sendTx throws ACTION_REJECTED", async () => {
    const lt = Object.create(LighterAdapter.prototype) as LighterAdapter & Record<string, unknown>;
    lt.name = "lighter-rh";
    lt._baseUrl = "https://api.rh-testnet.lighter.xyz";
    lt.rhRate = vi.fn(async () => {});
    const spot = new LighterSpotAdapter(lt);
    respond(refusal);
    const send = (spot as unknown as { _sendTx: (s: unknown, k: "place" | "order" | "action") => Promise<unknown> })._sendTx.bind(spot);
    await expect(send({ txType: 12, txInfo: "{}" }, "action")).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
  });
});

// POST https://test-api.pacifica.fi/api/v1/account/withdraw (report 2026-10-02T07-31-19-198Z-pacifica-testnet)
const PAC_TOO_LOW = new Error("POST /account/withdraw failed (422): {\"success\":false,\"data\":null,\"error\":\"Withdraw amount too low: 1\",\"code\":29,\"error_id\":\"unspecified\"}");

describe("Pacifica withdraw refusal → definite, code 29 → INVALID_PARAMS", () => {
  it("code 29 WITHDRAW_AMOUNT_TOO_LOW → INVALID_PARAMS with the minimum in the remediation", () => {
    const e = pacificaWithdrawRejection(PAC_TOO_LOW, "1") as PerpError;
    expect(e).toBeInstanceOf(PerpError);
    expect(e.structured).toMatchObject({ code: "INVALID_PARAMS", retryable: false, details: { venueCode: 29 } });
    expect(e.structured.remediation).toMatch(/1 USDC minimum plus a \$1 fee/);
  });

  it("code 9 OVER_WITHDRAWAL → INSUFFICIENT_BALANCE; other 422 → ACTION_REJECTED; non-422 / unparseable → unchanged", () => {
    const over = new Error("POST /account/withdraw failed (422): {\"success\":false,\"data\":null,\"error\":\"Over withdrawal\",\"code\":9}");
    expect((pacificaWithdrawRejection(over, "5") as PerpError).structured.code).toBe("INSUFFICIENT_BALANCE");
    const blocked = new Error("POST /account/withdraw failed (422): {\"success\":false,\"data\":null,\"error\":\"Withdrawal blocked\",\"code\":32}");
    expect((pacificaWithdrawRejection(blocked, "5") as PerpError).structured.code).toBe("ACTION_REJECTED");
    for (const e of [
      new Error("POST /account/withdraw failed (500): {\"success\":false,\"error\":\"Internal\"}"),
      new Error("POST /account/withdraw failed (422): <html>"),
      new Error("POST /orders/create failed (422): {\"success\":false,\"error\":\"x\",\"code\":29}"),
      new Error("fetch failed"),
    ]) {
      expect(pacificaWithdrawRejection(e, "5")).toBe(e);
    }
  });

  function pac(withdrawImpl: () => Promise<unknown>) {
    const p = new PacificaAdapter(Keypair.generate(), "testnet");
    const withdraw = vi.fn(withdrawImpl);
    (p as unknown as { client: unknown }).client = {
      withdraw, getAccount: vi.fn().mockResolvedValue({ available_to_withdraw: "1000" }), setRequestAgentWallet: vi.fn(),
    };
    return { p, withdraw };
  }

  it("adapter.withdraw maps the venue refusal (was UNKNOWN)", async () => {
    const { p } = pac(async () => { throw PAC_TOO_LOW; });
    await expect(p.withdraw("1", p.publicKey)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it(`below the documented ${PACIFICA_WITHDRAW_MIN_USDC} USDC minimum → INVALID_PARAMS before signing`, async () => {
    const { p, withdraw } = pac(async () => ({ ok: true }));
    await expect(p.withdraw("0.5", p.publicKey)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("runner: Pacifica testnet withdraw default is the conservative 10 USDC (1 was refused)", () => {
    const route = PROFILES.pacifica.withdraw.testnet;
    expect(route.kind === "cli" && route.min).toBe(10);
  });
});
