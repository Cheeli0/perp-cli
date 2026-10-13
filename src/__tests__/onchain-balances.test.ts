/**
 * `perp wallet balance` on-chain reads: gas token + USDC / USDT (USDG on Robinhood Chain) on every
 * chain perp-cli moves funds on. A failed read is a per-token error (balance null), never a 0.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const failing = new Set<string>();
const rpcUrls: string[] = [];
const raw: Record<string, bigint> = {};

vi.mock("ethers", async (orig) => {
  const real = await orig<typeof import("ethers")>();
  class JsonRpcProvider {
    constructor(readonly url: string) { rpcUrls.push(url); }
    async getBalance() { return 10n ** 15n; } // 0.001 native
  }
  class Contract {
    constructor(readonly address: string) {}
    async balanceOf() {
      if (failing.has(this.address)) throw new Error("rpc timeout");
      return raw[this.address] ?? 0n;
    }
  }
  return { ...real, ethers: { ...real.ethers, JsonRpcProvider, Contract } };
});

const solTokenAccounts: Record<string, unknown[] | Error> = {};
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  class Connection {
    async getBalance() { return 17_183_250; } // 0.01718325 SOL
    async getParsedTokenAccountsByOwner(_o: unknown, f: { mint: { toBase58(): string } }) {
      const v = solTokenAccounts[f.mint.toBase58()];
      if (v instanceof Error) throw v;
      return { value: (v ?? []).map(a => ({ account: { data: { parsed: { info: { tokenAmount: a } } } } })) };
    }
  }
  return { ...real, Connection };
});

const { evmOnchainBalances, mainnetEvmChains, solanaOnchainBalances, stableTotal } = await import("../onchain-balances.js");
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const ADDR = "0x1111111111111111111111111111111111111111";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";

beforeEach(() => {
  for (const k of Object.keys(solTokenAccounts)) delete solTokenAccounts[k];
  rpcUrls.length = 0;
  failing.clear();
  for (const k of Object.keys(raw)) delete raw[k];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ETH: "2500", BNB: "700", SOL: "100" }))));
});

describe("evmOnchainBalances", () => {
  it("covers Arbitrum, Ethereum, Base, BNB Chain and Robinhood Chain with USDC / USDT / USDG", () => {
    const chains = mainnetEvmChains();
    expect(Object.keys(chains)).toEqual(["arbitrum", "ethereum", "base", "bsc", "robinhood"]);
    expect(chains.arbitrum.tokens.map(t => t.symbol)).toEqual(["USDC", "USDT"]);
    expect(chains.ethereum.tokens.map(t => t.symbol)).toEqual(["USDC", "USDT"]);
    expect(chains.bsc.tokens.map(t => [t.symbol, t.decimals])).toEqual([["USDT", 18], ["USDC", 18]]);
    expect(chains.robinhood.tokens.map(t => t.symbol)).toEqual(["USDG"]);
  });

  it("reads each token with its own decimals; stables at $1, natives at the HL mid", async () => {
    raw[ARB_USDC] = 34_982_822n;               // 6 decimals
    raw[BSC_USDT] = 762_813_476_240_626_101n;  // 18 decimals
    const rows = await evmOnchainBalances(ADDR, false);
    const get = (c: string, t: string) => rows.find(r => r.chain === c && r.token === t)!;
    expect(get("arbitrum", "USDC")).toMatchObject({ balance: "34.982822", usdValue: 34.982822, error: null });
    expect(get("bsc", "USDT").balance).toBe("0.762813476240626101");
    expect(get("bsc", "BNB")).toMatchObject({ kind: "native", balance: "0.001" });
    expect(get("bsc", "BNB").usdValue).toBeCloseTo(0.7, 9);
    expect(stableTotal(rows).usd).toBeCloseTo(35.745635, 5);
  });

  it("a failed token read is balance null + error, excluded from the total and listed — never 0", async () => {
    raw[ARB_USDC] = 5_000_000n;
    failing.add(BSC_USDT);
    const rows = await evmOnchainBalances(ADDR, false);
    expect(rows.find(r => r.chain === "bsc" && r.token === "USDT")).toMatchObject({ balance: null, usdValue: null, error: "rpc timeout" });
    const total = stableTotal(rows);
    expect(total.usd).toBe(5);
    expect(total.errors).toEqual(["bsc USDT: rpc timeout"]);
  });

  it("unknown native price → usdValue null with the reason in priceError (balance still shown)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const rows = await evmOnchainBalances(ADDR, false, ["arbitrum"]);
    expect(rows.find(r => r.token === "ETH")).toMatchObject({ balance: "0.001", usdValue: null, error: null, priceError: expect.stringContaining("offline") });
    expect(rows.find(r => r.token === "USDC")?.priceError).toBeNull();
  });

  it("every chain goes through the (mocked) provider — no real RPC in unit tests", async () => {
    await evmOnchainBalances(ADDR, false);
    expect(rpcUrls).toHaveLength(5);
  });

  it("`only` limits the chains; testnet reads Arbitrum Sepolia only", async () => {
    expect(new Set((await evmOnchainBalances(ADDR, false, ["arbitrum"])).map(r => r.chain))).toEqual(new Set(["arbitrum"]));
    expect(new Set((await evmOnchainBalances(ADDR, true)).map(r => r.chain))).toEqual(new Set(["arbitrum-sepolia"]));
  });
});

describe("solanaOnchainBalances", () => {
  const OWNER = "So11111111111111111111111111111111111111112";

  it("sums raw amounts across token accounts exactly (BigInt), SOL from lamports", async () => {
    solTokenAccounts[SOL_USDC] = [{ amount: "17000000" }, { amount: "48092" }];
    solTokenAccounts[SOL_USDT] = [];
    const rows = await solanaOnchainBalances(OWNER, false);
    expect(rows.map(r => [r.token, r.balance])).toEqual([["SOL", "0.01718325"], ["USDC", "17.048092"], ["USDT", "0"]]);
    expect(stableTotal(rows).usd).toBeCloseTo(17.048092, 9);
  });

  it("a token account without a raw amount, or a failed read → that token is balance null + error", async () => {
    solTokenAccounts[SOL_USDC] = [{ uiAmount: 5 }];
    solTokenAccounts[SOL_USDT] = new Error("429 Too Many Requests");
    const rows = await solanaOnchainBalances(OWNER, false);
    expect(rows.find(r => r.token === "USDC")).toMatchObject({ balance: null, error: expect.stringContaining("raw amount") });
    expect(rows.find(r => r.token === "USDT")).toMatchObject({ balance: null, error: "429 Too Many Requests" });
    expect(stableTotal(rows).errors).toHaveLength(2);
  });
});
