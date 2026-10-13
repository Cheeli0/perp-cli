/**
 * Command-level checks for fund movements whose on-chain leg is signed by the OWS master wallet:
 *   H1  `funds deposit hyperliquid` / `funds deposit lighter ethereum|cctp` sign through the OWS
 *       transaction signer (no raw private key, no `new ethers.Wallet("ows:…")`).
 *   M1  once a deposit tx is broadcast, a lost response / receipt timeout is ORDER_PENDING with
 *       the tx hash.
 *   L9  the Lighter CCTP deposit requires `intent_address` (no `|| address` fallback).
 *   +   `funds deposit aster|ondo`, `funds withdraw aster`, `funds address-book add`,
 *       `funds bridge send` (Relay): --dry-run prints the plan / quote without loading any key.
 * RPC (ethers JsonRpcProvider), the venue APIs and the OWS vault are mocked — nothing is sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { Interface, SigningKey, Transaction, Wallet, parseUnits } from "ethers";

const KEY = `0x${"42".repeat(32)}`;
const MASTER = new Wallet(KEY).address;
const SOL_MASTER = "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7";
const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const LIGHTER_L1 = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const INTENT = "0x00000000000000000000000000000000000000C7";

const erc20 = new Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const zk = new Interface(["function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount) payable"]);

const rpc = {
  chainId: 42161n, allowance: 0n, wait: "ok" as "ok" | "timeout" | "network" | "none",
  broadcastFails: null as null | "lost" | "rejected" | "already-known" | "nonce-too-low",
  /** eip1559 = maxFee / priority; legacy = a chain with no base fee (gasPrice only); none = no fee data at all. */
  fees: "eip1559" as "eip1559" | "legacy" | "none",
  broadcasts: [] as Transaction[],
};

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  class FakeProvider {
    async send(method: string, params?: string[]): Promise<string> {
      if (method === "eth_sendRawTransaction") return (await this.broadcastTransaction(params![0])).hash;
      if (method === "eth_chainId") return `0x${rpc.chainId.toString(16)}`;
      throw new Error(`unexpected rpc ${method}`);
    }
    async call(tx: { data: string }): Promise<string> {
      const sel = tx.data.slice(0, 10);
      if (sel === erc20.getFunction("decimals")!.selector) return erc20.encodeFunctionResult("decimals", [6]);
      if (sel === erc20.getFunction("balanceOf")!.selector) return erc20.encodeFunctionResult("balanceOf", [parseUnits("1000", 6)]);
      if (sel === erc20.getFunction("allowance")!.selector) return erc20.encodeFunctionResult("allowance", [rpc.allowance]);
      throw new Error(`unexpected call ${sel}`);
    }
    async estimateGas(): Promise<bigint> { return 60_000n; }
    async getFeeData(): Promise<{ maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null; gasPrice: bigint | null }> {
      if (rpc.fees === "legacy") return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: 3_000_000_000n };
      if (rpc.fees === "none") return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: null };
      return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, gasPrice: 10n };
    }
    async getBalance(): Promise<bigint> { return 10n ** 18n; }
    async getTransactionCount(): Promise<number> { return rpc.broadcasts.length; }
    async broadcastTransaction(raw: string): Promise<{ hash: string }> {
      const tx = actual.Transaction.from(raw);
      if (rpc.broadcastFails === "rejected") throw Object.assign(new Error("insufficient funds for gas"), { code: "INSUFFICIENT_FUNDS" });
      rpc.broadcasts.push(tx);
      if (rpc.broadcastFails === "lost") throw Object.assign(new Error("request timeout"), { code: "TIMEOUT" });
      // A proxy / second node that already relayed the same raw transaction answers like this.
      if (rpc.broadcastFails === "already-known") throw Object.assign(new Error("already known"), { code: "UNKNOWN_ERROR", error: { code: -32000, message: "already known" } });
      if (rpc.broadcastFails === "nonce-too-low") throw Object.assign(new Error("nonce too low: next nonce 1, tx nonce 0"), { code: "NONCE_EXPIRED" });
      return { hash: tx.hash as string };
    }
    async waitForTransaction(hash: string): Promise<{ status: number; hash: string; logs: never[] } | null> {
      if (rpc.wait === "none") return null;
      if (rpc.wait === "timeout") throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      if (rpc.wait === "network") throw Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" });
      return { status: 1, hash, logs: [] };
    }
  }
  return { ...actual, JsonRpcProvider: FakeProvider };
});

// The OWS master wallet: a transaction signer only (digest derived from the unsigned tx).
const masterSigner = {
  getAddress: () => MASTER,
  signTransaction: vi.fn(async (tx: Transaction) => new SigningKey(KEY).sign(tx.unsignedHash).serialized),
  signMessage: vi.fn(),
};
const loadMasterEvmSigner = vi.fn(async (..._a: unknown[]) => masterSigner);
vi.mock("../evm-master-tx.js", async (orig) => ({
  ...(await orig<typeof import("../evm-master-tx.js")>()),
  loadMasterEvmSigner: (...a: unknown[]) => loadMasterEvmSigner(...a),
}));

// Execution-log spy (calls through to the real, HOME-isolated log).
const logExecution = vi.fn();
vi.mock("../execution-log.js", async (orig) => {
  const actual = await orig<typeof import("../execution-log.js")>();
  return { ...actual, logExecution: (r: Parameters<typeof actual.logExecution>[0]) => { logExecution(r); return actual.logExecution(r); } };
});

const loadPrivateKey = vi.fn(async () => { throw new Error("loadPrivateKey must not be used by on-chain deposits"); });
const resolveOwsMaster = vi.fn(async (..._a: unknown[]): Promise<{ wallet: string; passphrase: string } | null> => ({ wallet: "main", passphrase: "" }));
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  loadPrivateKey: () => loadPrivateKey(),
  resolveOwsMaster: (...a: unknown[]) => resolveOwsMaster(...a),
}));
vi.mock("../signer/ows-evm.js", async (orig) => ({
  ...(await orig<typeof import("../signer/ows-evm.js")>()),
  OwsEvmSigner: { create: () => ({ getAddress: () => MASTER }) },
}));
vi.mock("../signer/ows-solana.js", () => ({ OwsSolanaSigner: { create: () => ({ getPublicKeyBase58: () => SOL_MASTER }) } }));

const QUOTE = {
  provider: "relay", requestId: "0xreq", orderId: "0xorder", from: "robinhood", to: "solana", fromAsset: "USDG", toAsset: "SOL",
  sender: MASTER, recipient: SOL_MASTER, amountIn: "15", amountInRaw: "15000000", expectedOut: "0.122", expectedOutRaw: "122000000",
  minimumOut: "0.12", minimumOutRaw: "120000000", amountInUsd: "14.99", expectedOutUsd: "14.93",
  fees: { originGasUsd: "0.006", relayerUsd: "0.032", relayerGasUsd: "0.003", relayerServiceUsd: "0.029", appUsd: "0" },
  totalImpactPercent: "-0.47", timeEstimateSec: 1, deadline: 4_000_000_000,
  txs: [{ kind: "approve", to: "0x1", data: "0x", value: 0n, chainId: 4663 }, { kind: "deposit", to: "0x2", data: "0x", value: 0n, chainId: 4663 }],
};
const quoteRelaySwap = vi.fn(async (req: Record<string, string>) => ({ ...QUOTE, ...req, from: req.from, to: req.to, sender: req.sender, recipient: req.recipient }));
const executeRelaySwap = vi.fn(async () => ({ provider: "relay", requestId: "0xreq", status: "success", approveTxHash: "0xa", depositTxHash: "0xd", destinationTxHashes: ["sig"] }));
vi.mock("../relay-swap.js", async (orig) => ({
  ...(await orig<typeof import("../relay-swap.js")>()),
  quoteRelaySwap: (r: Record<string, string>) => quoteRelaySwap(r),
  executeRelaySwap: (...a: unknown[]) => executeRelaySwap(...(a as [])),
}));

const { addRootSafetyOptions } = await import("../cli-flags.js");
const { registerFundsCommands } = await import("../commands/funds.js");
const { LighterAdapter } = await import("../exchanges/lighter.js");
const { PerpError } = await import("../errors.js");

function program(getAdapterForExchange: (ex: string) => Promise<unknown> = async () => { throw new Error("adapter must not be built"); }, network: "mainnet" | "testnet" = "mainnet"): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  addRootSafetyOptions(prog).option("--json").option("--ows <name>");
  registerFundsCommands(prog, async () => { throw new Error("getAdapter not expected"); }, () => true, () => network, getAdapterForExchange as never);
  return prog;
}

function captureJson(): () => Record<string, any> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  return () => JSON.parse(lines.filter(l => l.includes('"ok"') || lines.length === 1).join("\n") || lines.join("\n")) as Record<string, any>;
}

const run = (prog: Command, args: string[]) => prog.parseAsync(["--ows", "main", ...args], { from: "user" });
const transferArgs = (tx: Transaction) => erc20.parseTransaction({ data: tx.data })!.args.toArray();

beforeEach(() => {
  Object.assign(rpc, { chainId: 42161n, allowance: 0n, wait: "ok", broadcastFails: null, fees: "eip1559", broadcasts: [] });
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("H1 — Hyperliquid / Lighter deposits are signed by the OWS master wallet", () => {
  it("hyperliquid (direct): USDC.transfer(Bridge2, amount) on Arbitrum, signed through the transaction signer", async () => {
    const out = captureJson();
    await run(program(), ["funds", "deposit", "hyperliquid", "13"]);
    expect(loadMasterEvmSigner).toHaveBeenCalledWith("hyperliquid", expect.objectContaining({ ows: "main" }), expect.any(String));
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(masterSigner.signTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.broadcasts).toHaveLength(1);
    const tx = rpc.broadcasts[0];
    expect(tx).toMatchObject({ to: USDC_ARB, from: MASTER, chainId: 42161n, value: 0n });
    expect(transferArgs(tx)).toEqual([HL_BRIDGE, 13_000_000n]);
    expect(out()).toMatchObject({ ok: true, data: { txHash: tx.hash, amount: 13, method: "direct" } });
  });

  it("hyperliquid --relay: the relayer gets the OWS master ADDRESS; nothing is signed", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/health")) return new Response("ok");
      expect(JSON.parse(String(init?.body))).toEqual({ userAddress: MASTER, amount: 13 });
      return new Response(JSON.stringify({ txHash: "0xrelay", fee: 0, netAmount: 13 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = captureJson();
    await run(program(), ["funds", "deposit", "hyperliquid", "13", "--relay"]);
    expect(out()).toMatchObject({ ok: true, data: { txHash: "0xrelay", method: "relay" } });
    expect(masterSigner.signTransaction).not.toHaveBeenCalled();
    expect(loadPrivateKey).not.toHaveBeenCalled();
  });

  it("lighter ethereum: approve(contract, exact amount) then deposit(to = master, 3, 0, amount) on chain 1", async () => {
    rpc.chainId = 1n;
    const out = captureJson();
    await run(program(), ["funds", "deposit", "lighter", "ethereum", "5"]);
    expect(loadPrivateKey).not.toHaveBeenCalled();
    const [approve, deposit] = rpc.broadcasts;
    expect(approve).toMatchObject({ to: USDC_ETH, from: MASTER, chainId: 1n });
    expect(transferArgs(approve)).toEqual([LIGHTER_L1, 5_000_000n]);
    expect(deposit.to?.toLowerCase()).toBe(LIGHTER_L1.toLowerCase());
    expect(zk.parseTransaction({ data: deposit.data })!.args.toArray()).toEqual([MASTER, 3n, 0n, 5_000_000n]);
    expect(out()).toMatchObject({ ok: true, data: { txHash: deposit.hash, chain: "ethereum" } });
  });

  it("lighter ethereum skips the approve when the allowance suffices", async () => {
    rpc.chainId = 1n; rpc.allowance = 5_000_000n;
    captureJson();
    await run(program(), ["funds", "deposit", "lighter", "ethereum", "5"]);
    expect(rpc.broadcasts).toHaveLength(1);
  });

  const lighter = (intent: Record<string, unknown>, address = MASTER) => {
    const lt = Object.create(LighterAdapter.prototype) as Record<string, unknown>;
    Object.defineProperty(lt, "address", { get: () => address });
    lt.createIntentAddress = vi.fn(async () => intent);
    return lt;
  };

  it("lighter cctp: USDC.transfer(intent_address, amount) on the chosen chain, signed by the OWS master", async () => {
    const lt = lighter({ intent_address: INTENT });
    const out = captureJson();
    await run(program(async ex => { expect(ex).toBe("lighter"); return lt; }), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]);
    expect(lt.createIntentAddress).toHaveBeenCalledWith(42161);
    expect(loadPrivateKey).not.toHaveBeenCalled();
    const tx = rpc.broadcasts[0];
    expect(tx).toMatchObject({ to: USDC_ARB, from: MASTER, chainId: 42161n });
    expect(transferArgs(tx)).toEqual([INTENT, 16_000_000n]);
    expect(out()).toMatchObject({ ok: true, data: { txHash: tx.hash, intentAddress: INTENT, method: "cctp" } });
  });

  it("lighter cctp: the intent address is read TWICE and both answers must name the same address; a mismatch sends nothing", async () => {
    const ok = lighter({ intent_address: INTENT });
    captureJson();
    await run(program(async () => ok), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]);
    expect(ok.createIntentAddress).toHaveBeenCalledTimes(2);
    expect(rpc.broadcasts).toHaveLength(1);

    rpc.broadcasts = [];
    masterSigner.signTransaction.mockClear();
    const OTHER = "0x00000000000000000000000000000000000000D8";
    const flip = lighter({});
    let n = 0;
    flip.createIntentAddress = vi.fn(async () => ({ intent_address: n++ === 0 ? INTENT : OTHER }));
    const err = await run(program(async () => flip), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]).catch(e => e);
    expect(err.structured.code).toBe("EXCHANGE_ERROR");
    expect(err.message).toMatch(/two different intent addresses/);
    expect(rpc.broadcasts).toHaveLength(0);
    expect(masterSigner.signTransaction).not.toHaveBeenCalled();

    // Same address in another letter case is the same address; the zero address is refused.
    n = 0;
    const cased = lighter({});
    cased.createIntentAddress = vi.fn(async () => ({ intent_address: n++ === 0 ? INTENT.toLowerCase() : INTENT }));
    await run(program(async () => cased), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]);
    expect(rpc.broadcasts).toHaveLength(1);
    await expect(run(program(async () => lighter({ intent_address: `0x${"0".repeat(40)}` })), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("lighter ethereum: --asset-id / --route are validated strictly (no parseInt leniency); nothing is sent", async () => {
    rpc.chainId = 1n;
    for (const args of [["--asset-id", "3abc"], ["--asset-id", "1e1"], ["--asset-id", "-1"], ["--asset-id", "3.5"], ["--asset-id", "65536"], ["--asset-id", ""],
      ["--route", "2"], ["--route", "1x"], ["--route", "01"], ["--route", ""]]) {
      await expect(run(program(), ["funds", "deposit", "lighter", "ethereum", "5", ...args])).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    }
    expect(rpc.broadcasts).toHaveLength(0);
    expect(loadMasterEvmSigner).not.toHaveBeenCalled();
    captureJson();
    await run(program(), ["funds", "deposit", "lighter", "ethereum", "5", "--asset-id", "3", "--route", "1"]);
    expect(zk.parseTransaction({ data: rpc.broadcasts[1].data })!.args.toArray()).toEqual([MASTER, 3n, 1n, 5_000_000n]);
  });

  it("L9 — a response carrying only `address` (no intent_address) is refused; nothing is sent", async () => {
    for (const intent of [{ address: INTENT }, { intent_address: "" }, { intent_address: "not-an-address" }, {}]) {
      await expect(run(program(async () => lighter(intent)), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]))
        .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    }
    expect(rpc.broadcasts).toHaveLength(0);
    expect(masterSigner.signTransaction).not.toHaveBeenCalled();
  });

  it("lighter cctp: an adapter for another account than the master wallet is refused", async () => {
    await expect(run(program(async () => lighter({ intent_address: INTENT }, "0x000000000000000000000000000000000000dEaD")), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]))
      .rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("no OWS master selected → NO_SIGNER_AVAILABLE before anything is sent", async () => {
    loadMasterEvmSigner.mockRejectedValueOnce(new PerpError("NO_SIGNER_AVAILABLE", "no OWS master"));
    await expect(run(program(), ["funds", "deposit", "hyperliquid", "13"])).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });
});

describe("M1 — after the broadcast an unreadable result is ORDER_PENDING with the tx hash", () => {
  it.each([["receipt timeout", "timeout"], ["RPC error while waiting", "network"]] as const)("hyperliquid deposit: %s", async (_n, wait) => {
    rpc.wait = wait;
    const err = await run(program(), ["funds", "deposit", "hyperliquid", "13"]).catch(e => e);
    expect(rpc.broadcasts).toHaveLength(1);
    expect(err.structured).toMatchObject({ code: "ORDER_PENDING", retryable: false, details: { txHash: rpc.broadcasts[0].hash, chainId: 42161 } });
    expect(err.structured.remediation).toContain("Do NOT resend");
  });

  it("the broadcast response is lost but the tx is mined → success with its hash", async () => {
    rpc.broadcastFails = "lost";
    const out = captureJson();
    await run(program(), ["funds", "deposit", "hyperliquid", "13"]);
    expect(out()).toMatchObject({ ok: true, data: { txHash: rpc.broadcasts[0].hash } });
  });

  it("the broadcast response is lost and no receipt arrives → ORDER_PENDING with the hash", async () => {
    rpc.broadcastFails = "lost"; rpc.wait = "timeout";
    await expect(run(program(), ["funds", "deposit", "hyperliquid", "13"])).rejects.toMatchObject({ structured: { code: "ORDER_PENDING", details: { txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } } });
  });

  it.each(["already-known", "nonce-too-low"] as const)("eth_sendRawTransaction answers \"%s\" → the tx may be in the mempool: waits for the receipt (success with its hash)", async (how) => {
    rpc.broadcastFails = how;
    const out = captureJson();
    await run(program(), ["funds", "deposit", "hyperliquid", "13"]);
    expect(rpc.broadcasts).toHaveLength(1);
    expect(out()).toMatchObject({ ok: true, data: { txHash: rpc.broadcasts[0].hash } });
  });

  it.each([["already-known", "timeout"], ["already-known", "none"], ["nonce-too-low", "timeout"], ["nonce-too-low", "none"]] as const)(
    "eth_sendRawTransaction answers \"%s\" and no receipt arrives (%s) → ORDER_PENDING with the hash, never a retryable error", async (how, wait) => {
      rpc.broadcastFails = how; rpc.wait = wait;
      const err = await run(program(), ["funds", "deposit", "hyperliquid", "13"]).catch(e => e);
      expect(err.structured).toMatchObject({ code: "ORDER_PENDING", retryable: false, details: { txHash: rpc.broadcasts[0].hash } });
      expect(err.structured.remediation).toContain("Do NOT resend");
    });

  it("a chain with no EIP-1559 fee data (zero base fee → maxFeePerGas null) is sent as a type-0 tx priced with the legacy gasPrice", async () => {
    rpc.fees = "legacy";
    const out = captureJson();
    await run(program(), ["funds", "deposit", "hyperliquid", "13"]);
    const tx = rpc.broadcasts[0];
    expect(tx.type).toBe(0);
    expect(tx.gasPrice).toBe(3_000_000_000n);
    expect(tx.maxFeePerGas).toBeNull();
    expect(tx.from).toBe(MASTER);
    expect(out()).toMatchObject({ ok: true, data: { txHash: tx.hash } });
    // The default (EIP-1559 data present) stays a type-2 transaction.
    rpc.fees = "eip1559"; rpc.broadcasts = [];
    await run(program(), ["funds", "deposit", "hyperliquid", "13"]);
    expect(rpc.broadcasts[0]).toMatchObject({ type: 2, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
  });

  it("no fee data at all (neither EIP-1559 nor gasPrice) → EXCHANGE_ERROR before signing", async () => {
    rpc.fees = "none";
    await expect(run(program(), ["funds", "deposit", "hyperliquid", "13"])).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect(masterSigner.signTransaction).not.toHaveBeenCalled();
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("the RPC refusing the transaction is a definite failure (nothing sent), not pending", async () => {
    rpc.broadcastFails = "rejected";
    await expect(run(program(), ["funds", "deposit", "hyperliquid", "13"])).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
  });

  it("lighter cctp and lighter ethereum: receipt timeout → ORDER_PENDING with the tx hash", async () => {
    rpc.wait = "timeout";
    const lt = Object.create(LighterAdapter.prototype) as Record<string, unknown>;
    Object.defineProperty(lt, "address", { get: () => MASTER });
    lt.createIntentAddress = async () => ({ intent_address: INTENT });
    await expect(run(program(async () => lt), ["funds", "deposit", "lighter", "cctp", "arbitrum", "16"]))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING", details: { txHash: expect.any(String) } } });
    rpc.chainId = 1n;
    await expect(run(program(), ["funds", "deposit", "lighter", "ethereum", "5"]))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING", details: { txHash: expect.any(String) } } });
    // The L1 deposit() is never sent while the approve is unconfirmed.
    expect(rpc.broadcasts).toHaveLength(2);
    expect(rpc.broadcasts[1].to).toBe(USDC_ETH);
  });

  it("lighter-rh deposit: a receipt timeout is logged WITH the broadcast tx hash (failure meta used to drop it)", async () => {
    rpc.chainId = 4663n; rpc.wait = "timeout"; rpc.allowance = parseUnits("1000", 6); // no approve: the deposit is the only tx
    const RH_CONTRACT = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
    const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/v1/layer1BasicInfo")) {
        return new Response(JSON.stringify({ code: 200, l1_providers: [{ chainId: 4663, networkId: 4663 }], contract_addresses: [{ name: "ZkLighterContract", address: RH_CONTRACT }, { name: "USDCContract", address: USDG }] }));
      }
      if (u.includes("/api/v1/assetDetails")) {
        return new Response(JSON.stringify({ code: 200, asset_details: [{ asset_id: 3, symbol: "USDG", l1_decimals: 6, decimals: 6, l1_address: USDG }] }));
      }
      throw new Error(`unexpected fetch ${u}`);
    }));
    const lt = Object.create(LighterAdapter.prototype) as Record<string, unknown>;
    Object.defineProperty(lt, "address", { get: () => MASTER });
    lt.signL1Transaction = (tx: Transaction) => masterSigner.signTransaction(tx);
    const err = await run(program(async () => lt), ["funds", "deposit", "lighter-rh", "5"]).catch(e => e);
    expect(err.structured).toMatchObject({ code: "ORDER_PENDING", details: { txHash: rpc.broadcasts[0].hash } });
    const failed = logExecution.mock.calls.map(c => c[0] as { exchange: string; status: string; meta?: Record<string, unknown> }).find(r => r.exchange === "lighter-rh" && r.status !== "success");
    expect(failed).toBeDefined();
    expect(failed!.meta).toMatchObject({ action: "deposit", method: "contract", txHash: rpc.broadcasts[0].hash });
  });

  it("connect failures list ENETUNREACH / EHOSTUNREACH (request never left)", async () => {
    const { isConnectFailure } = await import("../errors.js");
    expect(isConnectFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } }))).toBe(true);
    expect(isConnectFailure({ code: "EHOSTUNREACH" })).toBe(true);
    expect(isConnectFailure({ code: "ECONNRESET" })).toBe(false);
  });
});

describe("--dry-run prints the plan and loads no key (Aster / Ondo / address book)", () => {
  const noKeys = () => {
    expect(loadMasterEvmSigner).not.toHaveBeenCalled();
    expect(resolveOwsMaster).not.toHaveBeenCalled();
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(rpc.broadcasts).toHaveLength(0);
  };

  it("funds deposit aster: default BNB Chain + USDT, pinned vault / token, broker 1", async () => {
    const out = captureJson();
    await program().parseAsync(["--dry-run", "funds", "deposit", "aster", "8"], { from: "user" });
    expect(out()).toMatchObject({ ok: true, data: {
      dryRun: true, sent: false, venue: "aster", asset: "USDT", amount: "8", chain: "BNB Chain", chainId: 56,
      vault: "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974", token: "0x55d398326f99059fF775485246999027B3197955", broker: "1 (perp account)",
    } });
    noKeys();
  });

  it("funds deposit aster --chain arbitrum --asset USDC; testnet → CAPABILITY_UNSUPPORTED; bad chain → INVALID_PARAMS", async () => {
    const out = captureJson();
    await program().parseAsync(["--dry-run", "funds", "deposit", "aster", "8", "--chain", "arbitrum", "--asset", "usdc"], { from: "user" });
    expect(out().data).toMatchObject({ chainId: 42161, asset: "USDC", vault: "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5", token: USDC_ARB });
    await expect(program(undefined, "testnet").parseAsync(["funds", "deposit", "aster", "8"], { from: "user" })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    await expect(program().parseAsync(["--dry-run", "funds", "deposit", "aster", "8", "--chain", "ethereum"], { from: "user" })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    noKeys();
  });

  it("funds deposit aster (live) without a usable API wallet → AGENT_NOT_REGISTERED before any RPC / signature", async () => {
    const { AsterAdapter } = await import("../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await expect(run(program(async () => ast), ["funds", "deposit", "aster", "8"])).rejects.toMatchObject({ structured: { code: "AGENT_NOT_REGISTERED" } });
    expect(rpc.broadcasts).toHaveLength(0);
    expect(masterSigner.signTransaction).not.toHaveBeenCalled();
  });

  it("funds deposit ondo: default Arbitrum, probe plan", async () => {
    const out = captureJson();
    await program().parseAsync(["--dry-run", "funds", "deposit", "ondo", "12", "--probe", "2"], { from: "user" });
    expect(out()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue: "ondo", asset: "USDC", amount: "12", chain: "Arbitrum", chainId: 42161, token: USDC_ARB, probe: "2" } });
    await expect(program(undefined, "testnet").parseAsync(["funds", "deposit", "ondo", "12"], { from: "user" })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    noKeys();
  });

  it.each([
    [["--dry-run", "funds", "address-book", "add", "ondo", MASTER]],
    [["funds", "address-book", "add", "ondo", MASTER]],
    [["--dry-run", "funds", "address-book", "add", "aster", MASTER]],
  ])("funds address-book add %j → CAPABILITY_UNSUPPORTED (Ondo withdrawals are web-app only), nothing signed", async (argv) => {
    await expect(program().parseAsync(argv, { from: "user" })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(masterSigner.signMessage).not.toHaveBeenCalled();
    noKeys();
  });
});

describe("funds bridge send — Relay", () => {
  const SEND = ["funds", "bridge", "send", "--from", "robinhood", "--to", "solana", "--from-asset", "USDG", "--to-asset", "SOL", "--amount", "15"];

  it("--dry-run with explicit addresses prints the quote (in, expected out, guaranteed, fees, ETA) and loads no key", async () => {
    const out = captureJson();
    await program().parseAsync(["--dry-run", ...SEND, "--sender", MASTER, "--recipient", SOL_MASTER], { from: "user" });
    expect(quoteRelaySwap).toHaveBeenCalledWith({ from: "robinhood", to: "solana", fromAsset: "USDG", toAsset: "SOL", amount: "15", sender: MASTER, recipient: SOL_MASTER });
    const data = out().data;
    expect(data).toMatchObject({
      dryRun: true, sent: false, provider: "relay",
      quote: { amountIn: "15", expectedOut: "0.122", minimumOut: "0.12", fees: { relayerUsd: "0.032", originGasUsd: "0.006" }, timeEstimateSec: 1, steps: ["approve", "deposit"] },
      minOut: { ok: false, rule: "required" },
    });
    expect(data.quote.txs).toBeUndefined();
    expect(loadMasterEvmSigner).not.toHaveBeenCalled();
    expect(resolveOwsMaster).not.toHaveBeenCalled();
    expect(loadPrivateKey).not.toHaveBeenCalled();
    expect(executeRelaySwap).not.toHaveBeenCalled();
  });

  it("--dry-run without addresses uses the master wallet's PUBLIC addresses (EVM sender, Solana recipient)", async () => {
    captureJson();
    await program().parseAsync(["--dry-run", ...SEND, "--min-out", "0.11"], { from: "user" });
    expect(quoteRelaySwap).toHaveBeenCalledWith(expect.objectContaining({ sender: MASTER, recipient: SOL_MASTER }));
    expect(loadMasterEvmSigner).not.toHaveBeenCalled();
    expect(executeRelaySwap).not.toHaveBeenCalled();
  });

  it("robinhood / bsc chains and asset flags imply Relay; another provider with them → INVALID_PARAMS", async () => {
    await expect(program().parseAsync(["--dry-run", ...SEND, "--provider", "cctp"], { from: "user" })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(quoteRelaySwap).not.toHaveBeenCalled();
  });

  it("live: stable → native without --min-out is refused before any signature", async () => {
    await expect(run(program(), SEND)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(loadMasterEvmSigner).not.toHaveBeenCalled();
    expect(executeRelaySwap).not.toHaveBeenCalled();
  });

  it("live: --min-out above the guaranteed minimum → RISK_VIOLATION, nothing sent", async () => {
    await expect(run(program(), [...SEND, "--min-out", "0.121"])).rejects.toMatchObject({ structured: { code: "RISK_VIOLATION" } });
    expect(executeRelaySwap).not.toHaveBeenCalled();
  });

  it("live: a recipient other than the master wallet's own destination address is refused (no quote, no signature)", async () => {
    await expect(run(program(), [...SEND, "--min-out", "0.11", "--recipient", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"])).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    await expect(run(program(), ["funds", "bridge", "send", "--from", "robinhood", "--to", "arbitrum", "--from-asset", "USDG", "--amount", "15", "--recipient", "0x000000000000000000000000000000000000dEaD"]))
      .rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
    expect(quoteRelaySwap).not.toHaveBeenCalled();
    expect(executeRelaySwap).not.toHaveBeenCalled();
  });

  it("live: executes the verified quote with the OWS master transaction signer; recipient = the master's Solana address", async () => {
    const out = captureJson();
    await run(program(), [...SEND, "--min-out", "0.11"]);
    expect(quoteRelaySwap).toHaveBeenCalledWith(expect.objectContaining({ sender: MASTER, recipient: SOL_MASTER }));
    expect(executeRelaySwap).toHaveBeenCalledTimes(1);
    const [network, quote] = executeRelaySwap.mock.calls[0] as unknown as [string, { recipient: string }];
    expect(network).toBe("mainnet");
    expect(quote.recipient).toBe(SOL_MASTER);
    expect(out()).toMatchObject({ ok: true, data: { provider: "relay", status: "success", depositTxHash: "0xd" } });
  });

  it("live: an unknown fill outcome propagates as ORDER_PENDING with the request id", async () => {
    executeRelaySwap.mockRejectedValueOnce(new PerpError("ORDER_PENDING", "fill not confirmed", { requestId: "0xreq", txHash: "0xd" }));
    await expect(run(program(), [...SEND, "--min-out", "0.11"])).rejects.toMatchObject({ structured: { code: "ORDER_PENDING", details: { requestId: "0xreq" } } });
  });

  it("testnet → NO_BRIDGE_ROUTE; a Solana origin → NO_BRIDGE_ROUTE (EVM-origin only)", async () => {
    await expect(program(undefined, "testnet").parseAsync(["--dry-run", ...SEND], { from: "user" })).rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
    await expect(program().parseAsync(["--dry-run", "funds", "bridge", "send", "--provider", "relay", "--from", "solana", "--to", "arbitrum", "--amount", "15"], { from: "user" }))
      .rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
  });
});
