/**
 * HyperliquidAdapter exchange actions without the `hyperliquid` npm SDK:
 * - user-signed actions (withdraw3, usdSend, approveBuilderFee, tokenDelegate,
 *   usdClassTransfer) are signed by the MASTER with HyperliquidSignTransaction
 *   EIP-712 and posted as {action, nonce, signature} — never by an agent, never
 *   with the L1 scheme;
 * - L1 actions (updateLeverage, updateIsolatedMargin, agentSendAsset) are signed
 *   by the active tier (agent included).
 * Exact bodies/signatures are checked against python-SDK vectors (see hl-signing.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { HyperliquidSpotAdapter } from "../../exchanges/hyperliquid-spot.js";
import { LocalEvmSigner } from "../../signer/index.js";
import type { AgentMeta } from "../../settings.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const DEST = "0x5e9ee1089755c3435139848e47e6635505d5a13a";

type Posted = { url: string; body: Record<string, unknown> };

let posted: Posted[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  posted = [];
  fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", response: { type: "default" } }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  (HyperliquidAdapter as unknown as { _lastNonce: number })._lastNonce = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function nowAt(ms: number) {
  vi.spyOn(Date, "now").mockReturnValue(ms);
}

async function masterAdapter(): Promise<HyperliquidAdapter> {
  const hl = new HyperliquidAdapter(undefined, true);
  hl.setSigner(await LocalEvmSigner.create(KEY));
  return hl;
}

async function agentOnlyAdapter(): Promise<HyperliquidAdapter> {
  const hl = new HyperliquidAdapter(undefined, true);
  hl.setAddress(DEST);
  const meta = { agentName: "t", agentWalletName: "agent-hl-t", agentEvmAddress: DEST, userEvmAddress: DEST, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } as unknown as AgentMeta;
  hl.setAgentSigner(meta, await LocalEvmSigner.create(KEY));
  return hl;
}

function sigEq(sig: unknown, want: { r: string; s: string; v: number }) {
  const s = sig as { r: string; s: string; v: number };
  expect(BigInt(s.r)).toBe(BigInt(want.r));
  expect(BigInt(s.s)).toBe(BigInt(want.s));
  expect(s.v).toBe(want.v);
}

describe("user-signed actions — master EIP-712, exact payloads", () => {
  it("withdraw → withdraw3 {action, nonce, signature} with python-SDK signature, no vaultAddress", async () => {
    const hl = await masterAdapter();
    nowAt(1687816341423);
    await hl.withdraw("1", DEST);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    const { body } = posted[0];
    expect(Object.keys(body).sort()).toEqual(["action", "nonce", "signature"]);
    expect(body.nonce).toBe(1687816341423);
    expect(body.action).toEqual({ type: "withdraw3", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", destination: DEST, amount: "1", time: 1687816341423 });
    sigEq(body.signature, {
      r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      v: 28,
    });
  });

  it("usdTransfer → usdSend (python-SDK vector)", async () => {
    const hl = await masterAdapter();
    nowAt(1687816341423);
    await hl.usdTransfer(1, DEST);
    expect(posted[0].body.action).toMatchObject({ type: "usdSend", destination: DEST, amount: "1", time: 1687816341423 });
    sigEq(posted[0].body.signature, {
      r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      v: 27,
    });
  });

  it("approveBuilderFee / tokenDelegate / usdClassTransfer carry `nonce` and the derived signatures", async () => {
    const hl = await masterAdapter();
    nowAt(1700000000006);
    await hl.approveBuilderFee(DEST.toUpperCase().replace("0X", "0x"), "0.01%");
    expect(posted[0].body.action).toMatchObject({ type: "approveBuilderFee", maxFeeRate: "0.01%", builder: DEST, nonce: 1700000000006 });
    sigEq(posted[0].body.signature, {
      r: "0x4a8e8c5b5e81681a822ea34fe9df8ee32ab59f10675ae8049dd758f29d1c60f",
      s: "0x7b0e1d53512f1e3d47c982bf48fa01cedb48469e644e26896587125754d3b30f",
      v: 27,
    });

    (HyperliquidAdapter as unknown as { _lastNonce: number })._lastNonce = 0;
    nowAt(1700000000005);
    await hl.tokenDelegate(DEST, "100000000", false);
    expect(posted[1].body.action).toMatchObject({ type: "tokenDelegate", validator: DEST, wei: 100000000, isUndelegate: false, nonce: 1700000000005 });
    sigEq(posted[1].body.signature, {
      r: "0xaa51c8f75b71b1f0a00bcae740f9503af24d2f726943cfe1c1a712905dc0a6f8",
      s: "0xdaaf65669db80096c363839584d678ec6b099cc37659eadb306a123236c572d",
      v: 27,
    });

    (HyperliquidAdapter as unknown as { _lastNonce: number })._lastNonce = 0;
    nowAt(1700000000004);
    await hl.usdClassTransfer("12.50", true);
    expect(posted[2].body.action).toMatchObject({ type: "usdClassTransfer", amount: "12.5", toPerp: true, nonce: 1700000000004 });
    sigEq(posted[2].body.signature, {
      r: "0x575c3ae4de134dec41ae41a1eccad5cacda33c5dcd87db90f391573546243478",
      s: "0x4b5d599b84be321bf61ee7a30948a266dd86942878f4f01527fe5ca12dc5faf3",
      v: 28,
    });
  });

  it("agent-only adapter: every user-signed action → NO_SIGNER_AVAILABLE, nothing sent", async () => {
    const hl = await agentOnlyAdapter();
    for (const run of [
      () => hl.withdraw("1", DEST),
      () => hl.usdTransfer(1, DEST),
      () => hl.approveBuilderFee(DEST, "0.01%"),
      () => hl.tokenDelegate(DEST, "1", false),
      () => hl.usdClassTransfer("1", true),
    ]) {
      await expect(run()).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tokenDelegate wei beyond a safe integer → INVALID_PARAMS before signing", async () => {
    const hl = await masterAdapter();
    await expect(hl.tokenDelegate(DEST, "9007199254740993", false)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("L1 actions — agent-signable, exact payloads", () => {
  function withAsset(hl: HyperliquidAdapter, marginMode: "strictIsolated" | "noCross" | null = null) {
    const h = hl as unknown as { _assetMap: Map<string, number>; _marginModeMap: Map<string, string> };
    h._assetMap.set("ETH-PERP", 1);
    if (marginMode) h._marginModeMap.set("ETH-PERP", marginMode);
  }

  it("updateLeverage → {type, asset, isCross, leverage} with the python-SDK signature (agent signs)", async () => {
    const hl = await agentOnlyAdapter();
    withAsset(hl);
    nowAt(1700000000000);
    await hl.updateLeverage("ETH", 5, true);
    const { body } = posted[0];
    expect(body.action).toEqual({ type: "updateLeverage", asset: 1, isCross: true, leverage: 5 });
    expect(body.nonce).toBe(1700000000000);
    expect(body.vaultAddress).toBeNull();
    sigEq(body.signature, {
      r: "0xe43f444a04f0535cc3af3786b85de1cde9ba4c52a2e68cf6889d053ca0e214d4",
      s: "0x3959216832fce48225f7eeed11bd4e56f0a83e67e7072fad4e50e77d725f8bb7",
      v: 27,
    });
  });

  it("updateIsolatedMargin(-2.5) REMOVES margin: isBuy true, ntli -2500000 (former bug sent +2500000)", async () => {
    const hl = await agentOnlyAdapter();
    withAsset(hl);
    nowAt(1700000000001);
    await hl.updateIsolatedMargin("ETH", -2.5);
    expect(posted[0].body.action).toEqual({ type: "updateIsolatedMargin", asset: 1, isBuy: true, ntli: -2500000 });
    sigEq(posted[0].body.signature, {
      r: "0x49036c76cfee788ebc6a8354a42d173c8785ed927cfbe1f7a79abac8b92dbbdb",
      s: "0x1d4ec9eeb959a93c11a5f8124e8113dad8329f481ff7f1d9547e1bb1a66d93bb",
      v: 27,
    });
    await hl.updateIsolatedMargin("ETH", 2.5);
    expect(posted[1].body.action).toEqual({ type: "updateIsolatedMargin", asset: 1, isBuy: true, ntli: 2500000 });
  });

  it("marginMode gating: cross leverage on isolated-only, margin removal on strictIsolated → refused, nothing sent", async () => {
    const hl = await agentOnlyAdapter();
    withAsset(hl, "strictIsolated");
    await expect(hl.setLeverage("ETH", 3, "cross")).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    await expect(hl.updateIsolatedMargin("ETH", -1)).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(fetchMock).not.toHaveBeenCalled();
    await hl.setLeverage("ETH", 3, "isolated");
    await hl.updateIsolatedMargin("ETH", 1);
    expect(posted).toHaveLength(2);
  });

  it("agentSendAsset: token '<name>:<tokenId>' from meta.collateralToken + spotMeta; nonce in action == body nonce", async () => {
    const hl = await agentOnlyAdapter();
    const info = vi.fn(async (b: Record<string, unknown>) => {
      if (b.type === "meta") return { universe: [], collateralToken: 0 };
      if (b.type === "spotMeta") return { tokens: [{ name: "USDC", index: 0, tokenId: "0xeb62eee3685fc4c43992febcd9e75443" }, { name: "PURR", index: 1, tokenId: "0xc1fb593aeffbeb02f85e0308e9956a90" }] };
      throw new Error(`unexpected info ${String(b.type)}`);
    });
    (hl as unknown as { _infoPost: typeof info })._infoPost = info;
    nowAt(1700000000003);
    await hl.agentSendAsset("12.5", true);
    const { body } = posted[0];
    expect(body.action).toEqual({
      type: "agentSendAsset", destination: DEST, sourceDex: "spot", destinationDex: "",
      token: "USDC:0xeb62eee3685fc4c43992febcd9e75443", amount: "12.5", fromSubAccount: "", nonce: 1700000000003,
    });
    expect(body.nonce).toBe(1700000000003);
    sigEq(body.signature, {
      r: "0x7458b22ed74196750bfddcc08f905e0d06a52de4e585090dc0a121ac2a9846aa",
      s: "0x31344de51b1119b016d7e3e69a7034ade198223b91e5df57f483654c8f4691d2",
      v: 28,
    });
  });

  it("agentSendAsset: collateral token missing from spotMeta → EXCHANGE_ERROR, nothing sent", async () => {
    const hl = await agentOnlyAdapter();
    (hl as unknown as { _infoPost: unknown })._infoPost = async (b: Record<string, unknown>) =>
      b.type === "meta" ? { collateralToken: 7 } : { tokens: [{ name: "USDC", index: 0, tokenId: "0xeb62eee3685fc4c43992febcd9e75443" }] };
    await expect(hl.agentSendAsset("1", true)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("spot↔perp USDC transfer routing by signer tier", () => {
  it("agent tier → agentSendAsset; master tier → usdClassTransfer", async () => {
    const agentHl = await agentOnlyAdapter();
    const a = vi.spyOn(agentHl, "agentSendAsset").mockResolvedValue({ status: "ok" });
    const u = vi.spyOn(agentHl, "usdClassTransfer").mockResolvedValue({ status: "ok" });
    await new HyperliquidSpotAdapter(agentHl).transferToPerp("5", "USDC");
    expect(a).toHaveBeenCalledWith("5", true);
    expect(u).not.toHaveBeenCalled();

    const masterHl = await masterAdapter();
    const a2 = vi.spyOn(masterHl, "agentSendAsset").mockResolvedValue({ status: "ok" });
    const u2 = vi.spyOn(masterHl, "usdClassTransfer").mockResolvedValue({ status: "ok" });
    await new HyperliquidSpotAdapter(masterHl).transferToSpot("5", "USDC");
    expect(u2).toHaveBeenCalledWith("5", false);
    expect(a2).not.toHaveBeenCalled();
  });
});

describe("no `hyperliquid` npm SDK left", () => {
  const root = join(__dirname, "..", "..", "..");
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|mts|js)$/.test(f)) out.push(p);
    }
    return out;
  }

  it("no source file imports the package; package.json does not depend on it", () => {
    const offenders = walk(join(root, "src")).filter(p => /from\s+["']hyperliquid["']|import\(\s*["']hyperliquid["']\s*\)|require\(\s*["']hyperliquid["']\s*\)/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.hyperliquid).toBeUndefined();
  });
});
