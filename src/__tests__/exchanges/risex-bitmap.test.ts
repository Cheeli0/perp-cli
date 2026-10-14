/**
 * M1: trading-only is proven from the RAW sessionKeys bitmap (+ the Authorization implementation pin
 * and a "no permission id ≥5" probe), at approve, at verify and once per adapter session before the
 * first permit. Mocked chain reader / HTTP; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import { PerpError } from "../../errors.js";
import { LocalEvmSigner } from "../../signer/evm-local.js";
import { assertTradingOnlyOnChain, decodeSessionKey, type RisexChainReader } from "../../exchanges/risex/session.js";
import { RISEX_PINS } from "../../exchanges/risex/typed-data.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import { verifyRisexAgent } from "../../exchanges/risex/agent.js";
import type { RisexAgentMeta } from "../../settings.js";

const ACCOUNT = "0x938a104179a2D23DeC249A968ecd5B4F8B857cac";
const SIGNER = "0x00000000000000000000000000000000000000a1";

function reader(o: { bitmap?: bigint; status?: number; impl?: string; id5?: boolean } = {}): RisexChainReader & { reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    hasPermission: async (_a, _s, p) => (((o.bitmap ?? 0xffffffe4n) >> BigInt(p)) & 1n) === 1n,
    isNonceUsed: async () => false,
    sessionKey: async () => { reads++; return { expiration: 2_000_000_000, bitmap: o.bitmap ?? 0xffffffe4n, status: o.status ?? 1 }; },
    permissionIdExists: async () => o.id5 ?? false,
    authImplementation: async () => o.impl ?? RISEX_PINS.mainnet.authImplementation,
  };
}

describe("decodeSessionKey (layout recorded on mainnet: expiration, bitmap, status)", () => {
  it("decodes the 3-word return", () => {
    const raw = "0x000000000000000000000000000000000000000000000000000000006af66b1600000000000000000000000000000000000000000000000000000000ffffffff0000000000000000000000000000000000000000000000000000000000000001";
    expect(decodeSessionKey(raw)).toEqual({ expiration: 1794534166, bitmap: 0xffffffffn, status: 1 });
    expect(() => decodeSessionKey("0x01")).toThrow(PerpError);
  });
});

describe("assertTradingOnlyOnChain", () => {
  it("accepts ids 0..4 = {2} with bits 5–31 set (they map to no permission)", async () => {
    await expect(assertTradingOnlyOnChain(reader(), "mainnet", ACCOUNT, SIGNER)).resolves.toMatchObject({ bitmap: 0xffffffe4n });
  });
  it.each([
    ["a new (unrestricted) signer, bitmap 0xffffffff", { bitmap: 0xffffffffn }, /not trading-only/],
    ["trading bit off", { bitmap: 0xffffffe0n }, /not trading-only/],
    ["revoked signer", { status: 3 }, /status 3/],
    ["an upgraded Authorization implementation", { impl: "0x0000000000000000000000000000000000000bad" }, /upgraded/],
    ["a new permission id 5", { id5: true }, /permission id 5/],
  ])("refuses %s → POLICY_DENIED", async (_n, o, re) => {
    const e = await assertTradingOnlyOnChain(reader(o), "mainnet", ACCOUNT, SIGNER).catch((x: unknown) => x as PerpError) as PerpError;
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.message).toMatch(re);
  });
});

describe("verifyRisexAgent", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { status: 1 } }), { status: 200 }))));
  afterEach(() => vi.restoreAllMocks());
  const meta = { kind: "risex", agentName: "a", agentWalletName: "w", signerAddress: SIGNER, accountAddress: ACCOUNT, expiresAt: new Date(Date.now() + 1e9).toISOString(), permissions: { tradingOnly: true, disabled: [0, 1, 3, 4], verifiedAt: "x" }, network: "mainnet", approvedAt: "x", source: "approved" } as RisexAgentMeta;

  it("trading-only bitmap → tradingOnly with the raw bitmap reported", async () => {
    expect(await verifyRisexAgent(meta, reader())).toMatchObject({ active: true, tradingOnly: true, bitmap: "0xffffffe4", reason: null });
  });
  it("a new permission id or an unrestricted bitmap → tradingOnly false with the reason", async () => {
    expect(await verifyRisexAgent(meta, reader({ id5: true }))).toMatchObject({ tradingOnly: false, reason: expect.stringMatching(/permission id 5/) });
    expect(await verifyRisexAgent(meta, reader({ bitmap: 0xffffffffn }))).toMatchObject({ tradingOnly: false, bitmap: "0xffffffff" });
  });
});

describe("adapter: proof once per session before the first permit", () => {
  let nonceDir: string;
  let posts: string[];
  beforeEach(() => {
    nonceDir = mkdtempSync(join(tmpdir(), "risex-bitmap-"));
    posts = [];
    const ok = (data: unknown) => new Response(JSON.stringify({ data, request_id: "r" }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
      const url = new URL(u);
      if (init?.method === "POST") posts.push(url.pathname);
      if (url.pathname === "/v1/markets") return ok({ markets: [{ market_id: "1", config: { name: "BTC/USDC", step_size: "0.000001", step_price: "0.1", max_leverage: "25", min_order_size: "0.00015", unlocked: true, match_price_band: "0.02" }, mark_price: "83000", funding_interval: "3600000000000", post_only: false, reduce_only: false, active: true, category: "crypto" }] });
      if (url.pathname === "/v1/auth/eip712-domain") return ok({ name: "RISEx", version: "1", chain_id: "4153", verifying_contract: RISEX_PINS.mainnet.auth });
      if (url.pathname === "/v1/system/config") return ok({ addresses: { router: RISEX_PINS.mainnet.router, auth: RISEX_PINS.mainnet.auth }, is_maintenance_mode: false });
      if (url.pathname.startsWith("/v1/nonce-state/")) return ok({ nonce_anchor: "1", current_bitmap_index: 0, bitmap: "0x0" });
      if (url.pathname === "/v1/orders/place") return ok({ order_id: "", block_number: "1", filled_quantity: "200000000000000" });
      throw new Error(`unrouted ${url.pathname}`);
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(nonceDir, { recursive: true, force: true }); });

  const order = { symbol: "BTC", side: "buy" as const, type: "limit" as const, size: "0.0002", price: "55024.8", triggerPrice: null, triggerSource: null, tif: "IOC" as const, reduceOnly: false, clientOrderId: "11", slippage: null, tpsl: null };
  const make = async (chain: RisexChainReader) => new RisexAdapter(getVenue("risex"), "mainnet", {
    account: ACCOUNT, signer: await LocalEvmSigner.create(Wallet.createRandom().privateKey), meta: null, noSignerReason: null, nonceDir, sleep: async () => undefined, chain, quarantine: () => undefined,
  });

  it("an unrestricted signer is refused before anything is signed or sent", async () => {
    const a = await make(reader({ bitmap: 0xffffffffn }));
    await expect(a.placeOrder(order)).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    expect(posts).toEqual([]);
  });

  it("a trading-only signer is proven once, then orders flow", async () => {
    const r = reader();
    const a = await make(r);
    await a.placeOrder(order);
    await a.placeOrder({ ...order, clientOrderId: "12" });
    expect(posts).toEqual(["/v1/orders/place", "/v1/orders/place"]);
    expect(r.reads()).toBe(1);
  });
});
