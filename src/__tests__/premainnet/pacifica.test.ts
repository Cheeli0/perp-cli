/**
 * Pre-mainnet review — Pacifica: M3 (422 allowlist), M4 (cache keys carry network + full
 * account), M5 (withdraw signed by the master, never the agent), stop-id cancel routing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";

const cacheKeys: string[] = [];
vi.mock("../../cache.js", async () => ({
  withCache: async <T>(key: string, _ttl: number, fn: () => Promise<T>) => { cacheKeys.push(key); return fn(); },
  fetchAndCache: async <T>(key: string, _ttl: number, fn: () => Promise<T>) => { cacheKeys.push(key); return fn(); },
  invalidateCache: () => {},
  accountCacheEpoch: () => 0,
  TTL_ACCOUNT: 1000, TTL_MARKET: 1000,
}));

import "../../exchanges/venues/index.js";
import { PacificaAdapter, pacificaCreateRejection, PACIFICA_DEFINITE_CREATE_CODES } from "../../exchanges/pacifica.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { LighterAdapter } from "../../exchanges/lighter.js";
import { PerpError } from "../../errors.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import type { AgentMeta } from "../../settings.js";
import type { SolanaSigner } from "../../signer/index.js";

afterEach(() => { vi.restoreAllMocks(); cacheKeys.length = 0; });

const refusal = (body: object, path = "/orders/create_market") => new Error(`POST ${path} failed (422): ${JSON.stringify(body)}`);
const codeOf = (e: unknown) => (e as PerpError).structured?.code;

describe("M3: only documented validation codes are a definite 'no order created'", () => {
  it("validation codes keep their definite mapping", () => {
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "tick", code: 4 }), "x"))).toBe("INVALID_TICK");
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "bal", code: 5 }), "x"))).toBe("INSUFFICIENT_BALANCE");
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "small", code: 7 }), "x"))).toBe("SIZE_TOO_SMALL");
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "far", code: 30 }), "x"))).toBe("ORDER_REJECTED");
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "No reasonable price", code: 25 }), "x"))).toBe("ORDER_REJECTED");
    // live testnet 2026-10-02: code 0 with a specific error_id
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "No reasonable price found", code: 0, error_id: "no_reasonable_price" }), "x"))).toBe("ORDER_REJECTED");
  });

  it("live mainnet 2026-10-05: 422 code 0 + error_id no_position_for_reduce_only_order is a definite ORDER_REJECTED", () => {
    const e = pacificaCreateRejection(refusal(
      { success: false, data: null, error: "No position found for reduce-only order", code: 0, error_id: "no_position_for_reduce_only_order" }, "/orders/create",
    ), "limit sell 0.05 SOL @ 130.70") as PerpError;
    expect(e.structured).toMatchObject({ code: "ORDER_REJECTED", retryable: false });
    expect(e.message).toBe("Pacifica limit sell 0.05 SOL @ 130.70 refused (no order was created): No position found for reduce-only order");
    // The error_id match is exact (case-insensitive): the same code 0 with another id stays unknown.
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "x", code: 0, error_id: "NO_POSITION_FOR_REDUCE_ONLY_ORDER" }), "x"))).toBe("ORDER_REJECTED");
    expect(codeOf(pacificaCreateRejection(refusal({ success: false, error: "x", code: 0, error_id: "no_position" }), "x"))).toBe("ORDER_PENDING");
  });

  it("INTERNAL / DATABASE_ERROR / CHANNEL_CLOSED / RESPONSE_DROPPED / unknown / missing code → ORDER_PENDING", () => {
    for (const body of [
      { success: false, error: "internal", code: 0 },
      { success: false, error: "internal", code: 0, error_id: "unspecified" },
      { success: false, error: "db", code: 14 },
      { success: false, error: "closed", code: 26 },
      { success: false, error: "dropped", code: 27 },
      { success: false, error: "new code", code: 987 },
      { success: false, error: "no code" },
    ]) {
      const e = pacificaCreateRejection(refusal(body), "market buy 1 BTC");
      expect(codeOf(e)).toBe("ORDER_PENDING");
      expect((e as PerpError).structured.remediation).toMatch(/Do NOT resubmit/);
    }
    for (const c of [0, 14, 26, 27]) expect(PACIFICA_DEFINITE_CREATE_CODES.has(c)).toBe(false);
  });

  it("non-422 / non-create errors pass through unchanged", () => {
    const e = new Error("POST /orders/cancel failed (422): {}");
    expect(pacificaCreateRejection(e, "x")).toBe(e);
  });
});

describe("M4: account cache keys carry the network and the full account", () => {
  it("pacifica positions / prices", async () => {
    const kp = Keypair.generate();
    for (const net of ["mainnet", "testnet"] as const) {
      const pac = new PacificaAdapter(kp, net);
      (pac as unknown as { client: unknown }).client = { getPositions: async () => [], getPrices: async () => [] };
      await (pac as unknown as { _getPositions(): Promise<unknown> })._getPositions();
      await (pac as unknown as { _getPrices(): Promise<unknown> })._getPrices();
    }
    const acct = kp.publicKey.toBase58();
    expect(cacheKeys).toEqual([
      `acct:pac:mainnet:positions:${acct}`, `acct:pac:mainnet:prices:${acct}`,
      `acct:pac:testnet:positions:${acct}`, `acct:pac:testnet:prices:${acct}`,
    ]);
  });

  it("hyperliquid and lighter account keys differ between mainnet and testnet", async () => {
    for (const testnet of [false, true]) {
      const hl = new HyperliquidAdapter(undefined, testnet);
      hl.setAddress("0xabc");
      (hl as unknown as { _infoPost: () => Promise<unknown> })._infoPost = async () => "disabled";
      await hl._getAbstractionMode();
    }
    expect(cacheKeys).toEqual(["mode:hl:mainnet:abstraction:0xabc", "mode:hl:testnet:abstraction:0xabc"]);
    expect(new LighterAdapter("0xabc", false).accountCachePrefix).toBe("lt:mainnet");
    expect(new LighterAdapter("0xabc", true).accountCachePrefix).toBe("lt:testnet");
    expect(LighterAdapter.forVenue("lighter-rh", "0xabc", true).accountCachePrefix).toBe("lighter-rh:testnet");
  });
});

describe("M5: withdraw is signed by the master wallet only", () => {
  function signerOf(kp: Keypair, sign = vi.fn(async () => new Uint8Array(64))): SolanaSigner & { signMessage: typeof sign } {
    return { getPublicKeyBase58: () => kp.publicKey.toBase58(), signMessage: sign } as unknown as SolanaSigner & { signMessage: typeof sign };
  }
  const future = new Date(Date.now() + 86_400_000).toISOString();

  function build(withMaster: boolean) {
    const masterKp = Keypair.generate();
    const agentKp = Keypair.generate();
    const pac = new PacificaAdapter(Keypair.generate(), "mainnet", false); // no real key of its own
    const master = signerOf(masterKp);
    const agent = signerOf(agentKp);
    if (withMaster) pac.setSigner(master);
    pac.setAgentSigner({ agentName: "a", expiresAt: future, userSolanaAddress: masterKp.publicKey.toBase58() } as unknown as AgentMeta, agent);
    const withdraw = vi.fn(async (_p: unknown, _acct: string, sign: (m: Uint8Array) => Promise<Uint8Array>) => { await sign(new Uint8Array(1)); return { success: true }; });
    const setRequestAgentWallet = vi.fn();
    (pac as unknown as { client: unknown }).client = { withdraw, setRequestAgentWallet, getAccount: async () => ({ available_to_withdraw: "1000" }) };
    return { pac, master, agent, withdraw, setRequestAgentWallet };
  }

  it("with an agent registered, the MASTER key signs and no agent_wallet is attached", async () => {
    const { pac, master, agent, withdraw, setRequestAgentWallet } = build(true);
    expect(pac.activeSignerTier).toBe("agent");
    await pac.withdraw("100", "");
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(master.signMessage).toHaveBeenCalledTimes(1);
    expect(agent.signMessage).not.toHaveBeenCalled();
    expect(setRequestAgentWallet).toHaveBeenLastCalledWith(undefined);
  });

  it("agent only (no master on this machine) → NO_SIGNER_AVAILABLE, nothing signed or sent", async () => {
    const { pac, agent, withdraw } = build(false);
    await expect(pac.withdraw("100", "")).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    expect(agent.signMessage).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe("trade cancel <symbol> <id> routes a stop / TP / SL id to the stop-cancel endpoint", () => {
  function pac(listed: Array<{ orderId: string; type: string; symbol: string }>) {
    const a = Object.create(PacificaAdapter.prototype) as PacificaAdapter & Record<string, unknown>;
    Object.defineProperty(a, "name", { value: "pacifica" });
    a.getOpenOrders = vi.fn().mockResolvedValue(listed);
    a.cancelOrder = vi.fn().mockResolvedValue({ success: true });
    a.cancelStopOrder = vi.fn().mockResolvedValue({ success: true });
    return a;
  }
  const ref = (v: string) => ({ kind: "orderId" as const, value: v });

  it("no listed type given: the open-orders listing decides the endpoint", async () => {
    const a = pac([{ orderId: "7", type: "stop_loss_market", symbol: "BTC" }, { orderId: "8", type: "limit", symbol: "BTC" }]);
    const v2 = toTradingV2(a as unknown as ExchangeAdapter, "mainnet");
    const r = await v2.cancelByRef("BTC", ref("7"));
    expect(a.cancelStopOrder).toHaveBeenCalledWith("BTC", "7");
    expect(a.cancelOrder).not.toHaveBeenCalled();
    expect(r.cancelled).toEqual([ref("7")]);
    await v2.cancelByRef("BTC", ref("8"));
    expect(a.cancelOrder).toHaveBeenCalledWith("BTC", "8");
  });

  it("a failed listing read throws before anything is sent", async () => {
    const a = pac([]);
    a.getOpenOrders = vi.fn().mockRejectedValue(new Error("GET /orders failed (500)"));
    await expect(toTradingV2(a as unknown as ExchangeAdapter, "mainnet").cancelByRef("BTC", ref("7"))).rejects.toThrow(/500/);
    expect(a.cancelOrder).not.toHaveBeenCalled();
    expect(a.cancelStopOrder).not.toHaveBeenCalled();
  });
});
