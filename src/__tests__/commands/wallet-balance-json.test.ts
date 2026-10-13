/**
 * `wallet balance --json` prints exactly ONE JSON document on every path (the .env path used to
 * print one per configured venue), reads each distinct address once, and every entry has the
 * same shape ({ chain, address, balances, stableUsd, errors }).
 *
 * The on-chain reads, the .env keys and settings are mocked; HOME is isolated; fetch throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

const EVM = "0x1111111111111111111111111111111111111111";
const SOL = "So11111111111111111111111111111111111111112";

const evmRead = vi.fn(async () => [
  { chain: "arbitrum", token: "USDC", kind: "stable", balance: "12.5", usdValue: 12.5, error: null, priceError: null },
  { chain: "bsc", token: "USDT", kind: "stable", balance: null, usdValue: null, error: "rpc timeout", priceError: null },
]);
const solRead = vi.fn(async () => [
  { chain: "solana", token: "USDC", kind: "stable", balance: "3", usdValue: 3, error: null, priceError: null },
]);
vi.mock("../../onchain-balances.js", async (orig) => ({
  ...(await orig<typeof import("../../onchain-balances.js")>()),
  evmOnchainBalances: evmRead,
  solanaOnchainBalances: solRead,
}));
vi.mock("../../commands/init.js", async (orig) => {
  const real = await orig<typeof import("../../commands/init.js")>();
  return {
    ...real,
    // hyperliquid + aster share one EVM key, pacifica is Solana
    loadEnvFile: () => ({ HL_PRIVATE_KEY: "k1", ASTER_PRIVATE_KEY: "k1", PACIFICA_PRIVATE_KEY: "k2" }),
    validateKey: async (chain: string) => ({ valid: true, address: chain === "solana" ? SOL : EVM }),
  };
});
let owsActive: string | undefined;
vi.mock("../../settings.js", async (orig) => {
  const real = await orig<typeof import("../../settings.js")>();
  return { ...real, loadSettings: () => ({ ...real.loadSettings(), owsActiveWallet: owsActive }) };
});
let owsLoadFails = false;
vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => {
    if (owsLoadFails) throw new Error("vault missing");
    return { getWallet: (name: string) => ({ name, accounts: [{ chainId: "eip155:1", address: EVM }, { chainId: "solana:mainnet", address: SOL }, { chainId: "cosmos:x", address: "c1" }] }) };
  },
}));

const { registerWalletCommands } = await import("../../commands/wallet.js");
const { EXCHANGE_ENV_MAP } = await import("../../commands/init.js");

function program(): Command {
  const p = new Command();
  p.exitOverride();
  addRootSafetyOptions(p);
  registerWalletCommands(p, () => true);
  return p;
}

let out: string[];
beforeEach(() => {
  owsActive = undefined;
  owsLoadFails = false;
  vi.clearAllMocks();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wallet balance --json (.env path)", () => {
  it("one JSON document; each address read once; per-entry stableUsd + errors", async () => {
    // Only venues whose env key the mock provides take part.
    const envKeys = Object.values(EXCHANGE_ENV_MAP).map(i => i.envKey);
    expect(envKeys).toEqual(expect.arrayContaining(["HL_PRIVATE_KEY", "ASTER_PRIVATE_KEY", "PACIFICA_PRIVATE_KEY"]));

    await program().parseAsync(["node", "perp", "wallet", "balance"]);
    const docs = out.filter(l => l.trim() !== "");
    expect(docs).toHaveLength(1);
    const doc = JSON.parse(docs[0]) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(doc.ok).toBe(true);
    expect(doc.data).toHaveLength(2);
    const evm = doc.data.find(e => e.chain === "evm")!;
    expect(evm).toMatchObject({ address: EVM, stableUsd: 12.5, errors: ["bsc USDT: rpc timeout"] });
    expect(String(evm.exchange).split(",").sort()).toEqual(["aster", "hyperliquid"]);
    expect(doc.data.find(e => e.chain === "solana")).toMatchObject({ address: SOL, stableUsd: 3, errors: [] });
    expect(evmRead).toHaveBeenCalledTimes(1);
    expect(solRead).toHaveBeenCalledTimes(1);
  });
});

const parseOne = () => {
  const docs = out.filter(l => l.trim() !== "");
  expect(docs).toHaveLength(1);
  return JSON.parse(docs[0]) as { ok: boolean; data: Array<Record<string, unknown>> };
};

describe("wallet balance --json (OWS and named-wallet paths)", () => {
  it("active OWS wallet: one document, EVM + Solana accounts (other chains skipped), same entry shape", async () => {
    owsActive = "main";
    await program().parseAsync(["node", "perp", "wallet", "balance"]);
    const doc = parseOne();
    expect(doc.data.map(e => [e.wallet, e.chain, e.address])).toEqual([["main", "evm", EVM], ["main", "solana", SOL]]);
    expect(doc.data[0]).toMatchObject({ stableUsd: 12.5, errors: ["bsc USDT: rpc timeout"] });
  });

  it("OWS vault fails to load → falls back to the .env path (still one document)", async () => {
    owsActive = "main";
    owsLoadFails = true;
    await program().parseAsync(["node", "perp", "wallet", "balance"]);
    expect(parseOne().data.map(e => e.chain).sort()).toEqual(["evm", "solana"]);
  });

  it("a balance-read failure on the OWS path propagates (no silent fall back to .env)", async () => {
    owsActive = "main";
    evmRead.mockRejectedValueOnce(new Error("ethers import failed"));
    await expect(program().parseAsync(["node", "perp", "wallet", "balance"])).rejects.toThrow("ethers import failed");
    expect(out.filter(l => l.trim() !== "")).toHaveLength(0);
  });

  it("named OWS wallet: one document with a single entry", async () => {
    await program().parseAsync(["node", "perp", "wallet", "balance", "main"]);
    const doc = parseOne();
    expect(doc.data).toHaveLength(1);
    expect(doc.data[0]).toMatchObject({ wallet: "main", chain: "evm", address: EVM, stableUsd: 12.5 });
  });
});
