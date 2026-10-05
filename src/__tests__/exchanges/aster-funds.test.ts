/**
 * Aster deposit (vault contract) + withdraw (POST /fapi/v3/aster/user-withdraw).
 * Chain RPC (ethers JsonRpcProvider) and the venue API (fetch) are mocked — nothing is sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Interface, SigningKey, Transaction, TypedDataEncoder, Wallet, id, parseUnits, verifyTypedData, zeroPadValue } from "ethers";

const KEY = `0x${"42".repeat(32)}`;
const WALLET = new Wallet(KEY);
const DEPOSITOR = WALLET.address;
const BSC_VAULT = "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const ARB_VAULT = "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DEPOSIT_TOPIC = "0x18081cde2fa64894914e1080b98cca17bb6d1acf633e57f6e26ebdb945ad830b";

const erc20 = new Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const vault = new Interface([
  "function deposit(address currency, uint256 amount, uint256 broker)",
  "function paused() view returns (bool)",
  "function supportToken(address) view returns (address currency)",
  "event Deposit(address indexed account, address indexed currency, bool isNative, uint256 amount, uint256 broker)",
]);

type Log = { address: string; topics: string[]; data: string };
const depositLog = (o: Partial<{ vault: string; account: string; currency: string; isNative: boolean; amount: bigint; broker: bigint }> = {}): Log => ({
  address: o.vault ?? BSC_VAULT,
  topics: [DEPOSIT_TOPIC, zeroPadValue(o.account ?? DEPOSITOR, 32), zeroPadValue(o.currency ?? BSC_USDT, 32)],
  data: vault.getAbiCoder().encode(["bool", "uint256", "uint256"], [o.isNative ?? false, o.amount ?? parseUnits("5", 18), o.broker ?? 1n]),
});

const rpc = {
  chainId: 56n, decimals: 18, balance: parseUnits("100", 18), allowance: 0n, gas: 10n ** 18n,
  supported: true, paused: false, simulateFails: false, wait: "ok" as "ok" | "timeout" | "revert",
  logs: [] as Log[], broadcasts: [] as Transaction[], calls: [] as string[],
};

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  class FakeProvider {
    async send(method: string, params?: string[]): Promise<string> {
      if (method === "eth_sendRawTransaction") return (await this.broadcastTransaction(params![0])).hash;
      if (method === "eth_chainId") return `0x${rpc.chainId.toString(16)}`;
      throw new Error(`unexpected rpc ${method}`);
    }
    async call(tx: { to: string; data: string }): Promise<string> {
      const sel = tx.data.slice(0, 10);
      rpc.calls.push(sel);
      if (sel === erc20.getFunction("decimals")!.selector) return erc20.encodeFunctionResult("decimals", [rpc.decimals]);
      if (sel === erc20.getFunction("balanceOf")!.selector) return erc20.encodeFunctionResult("balanceOf", [rpc.balance]);
      if (sel === erc20.getFunction("allowance")!.selector) return erc20.encodeFunctionResult("allowance", [rpc.allowance]);
      if (sel === vault.getFunction("paused")!.selector) return vault.encodeFunctionResult("paused", [rpc.paused]);
      if (sel === vault.getFunction("supportToken")!.selector) {
        // The real getter returns the whole Token struct; only the first word matters.
        return `${actual.zeroPadValue(rpc.supported ? tx.data.slice(0, 2) + tx.data.slice(34) : "0x00", 32)}${"00".repeat(160)}`;
      }
      throw new Error(`unexpected call ${sel}`);
    }
    async estimateGas(): Promise<bigint> {
      if (rpc.simulateFails) throw new Error("execution reverted: currency not support");
      return 100_000n;
    }
    async getFeeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; }
    async getBalance(): Promise<bigint> { return rpc.gas; }
    async getTransactionCount(): Promise<number> { return rpc.broadcasts.length; }
    async broadcastTransaction(raw: string): Promise<{ hash: string }> {
      const tx = actual.Transaction.from(raw);
      rpc.broadcasts.push(tx);
      return { hash: tx.hash as string };
    }
    async waitForTransaction(hash: string): Promise<{ status: number; hash: string; logs: Log[] }> {
      if (rpc.wait === "timeout") throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      return { status: rpc.wait === "revert" ? 0 : 1, hash, logs: rpc.logs };
    }
  }
  return { ...actual, JsonRpcProvider: FakeProvider };
});

const funds = await import("../../exchanges/aster-funds.js");
const { buildWithdrawTypedData } = await import("../../exchanges/aster-typed-data.js");
const { ASTER_FUNDS_CHAINS, asterVenue } = await import("../../exchanges/venues/aster.js");

const sign = async (tx: Transaction): Promise<string> => new SigningKey(KEY).sign(tx.unsignedHash).serialized;
const plan = (o: Partial<{ network: "mainnet" | "testnet"; chain: "bsc" | "arbitrum"; asset: "USDT" | "USDC"; amount: string; depositor: string }> = {}) =>
  funds.planAsterDeposit({ network: o.network ?? "mainnet", chain: o.chain ?? "bsc", asset: o.asset ?? "USDT", amount: o.amount ?? "5", depositor: o.depositor ?? DEPOSITOR });

beforeEach(() => {
  Object.assign(rpc, {
    chainId: 56n, decimals: 18, balance: parseUnits("100", 18), allowance: 0n, gas: 10n ** 18n,
    supported: true, paused: false, simulateFails: false, wait: "ok", logs: [depositLog()], broadcasts: [], calls: [],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("pins (venue definition)", () => {
  it("vault / token / chain id / RPC per chain, mainnet depositPins = BNB Chain USDT, withdraw asset USDT", () => {
    expect(ASTER_FUNDS_CHAINS.bsc).toMatchObject({ chainId: 56, vault: BSC_VAULT, withdrawChainName: "BSC", rpcUrl: "https://bsc-dataseed.bnbchain.org" });
    expect(ASTER_FUNDS_CHAINS.bsc.tokens).toEqual({ USDT: BSC_USDT, USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" });
    expect(ASTER_FUNDS_CHAINS.arbitrum).toMatchObject({ chainId: 42161, vault: ARB_VAULT, withdrawChainName: "Arbitrum", rpcUrl: "https://arb1.arbitrum.io/rpc" });
    expect(ASTER_FUNDS_CHAINS.arbitrum.tokens).toEqual({ USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", USDC: ARB_USDC });
    expect(asterVenue.networks.mainnet).toMatchObject({ rpcUrl: ASTER_FUNDS_CHAINS.bsc.rpcUrl, depositPins: { chainId: 56, contract: BSC_VAULT, token: BSC_USDT } });
    expect(asterVenue.networks.testnet).toMatchObject({ rpcUrl: null, depositPins: null });
    expect(asterVenue.capabilities?.withdrawAssets).toEqual(["USDT"]);
  });
});

describe("deposit calldata + event constants", () => {
  it("documented depositFor(address,address,uint256,uint256) selector 0xcf4a0c5e, forAddress = depositor, broker = 1; Deposit topic0 as verified on-chain", () => {
    const depositor = "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3";
    const data = funds.asterDepositCalldata({ token: BSC_USDT, depositor, amountRaw: parseUnits("5", 18), broker: 1n });
    expect(data.slice(0, 10)).toBe("0xcf4a0c5e");
    expect(data).toBe(`0xcf4a0c5e${zeroPadValue(BSC_USDT, 32).slice(2).toLowerCase()}${zeroPadValue(depositor, 32).slice(2).toLowerCase()}${parseUnits("5", 18).toString(16).padStart(64, "0")}${"1".padStart(64, "0")}`);
    expect(id("Deposit(address,address,bool,uint256,uint256)")).toBe(DEPOSIT_TOPIC);
    expect(funds.ASTER_VAULT.getEvent("Deposit")!.topicHash).toBe(DEPOSIT_TOPIC);
  });
});

describe("planAsterDeposit — read-only pre-checks", () => {
  it("BNB Chain USDT: decimals read on-chain (18), approve needed, broker 1", async () => {
    const p = await plan();
    expect(p).toMatchObject({ chainId: 56, vault: BSC_VAULT, token: BSC_USDT, decimals: 18, amountRaw: parseUnits("5", 18), needsApprove: true, broker: 1n });
    expect(rpc.calls).toContain(erc20.getFunction("decimals")!.selector);
  });

  it("Arbitrum USDC uses the chain's own decimals (6), never an assumed value", async () => {
    rpc.chainId = 42161n; rpc.decimals = 6; rpc.balance = parseUnits("100", 6);
    const p = await plan({ chain: "arbitrum", asset: "USDC", amount: "5.25" });
    expect(p).toMatchObject({ chainId: 42161, vault: ARB_VAULT, token: ARB_USDC, decimals: 6, amountRaw: 5_250_000n });
    await expect(plan({ chain: "arbitrum", asset: "USDC", amount: "5.1234567" })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("allowance already covers the amount → no approve", async () => {
    rpc.allowance = parseUnits("5", 18);
    expect((await plan()).needsApprove).toBe(false);
  });

  it("testnet → CAPABILITY_UNSUPPORTED without touching the RPC", async () => {
    await expect(plan({ network: "testnet" })).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED", details: { feature: "deposit" } } });
    expect(rpc.calls).toHaveLength(0);
  });

  it("RPC serving another chain id → EXCHANGE_ERROR", async () => {
    rpc.chainId = 1n;
    await expect(plan()).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("token not supported by the vault (supportToken first word zero) → EXCHANGE_ERROR", async () => {
    rpc.supported = false;
    await expect(plan()).rejects.toThrow(/does not list USDT/);
  });

  it("vault paused → EXCHANGE_ERROR", async () => {
    rpc.paused = true;
    await expect(plan()).rejects.toThrow(/is paused/);
  });

  it("token balance below the amount / no native gas → INSUFFICIENT_BALANCE", async () => {
    rpc.balance = parseUnits("4.99", 18);
    await expect(plan()).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    rpc.balance = parseUnits("100", 18); rpc.gas = 0n;
    await expect(plan()).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
  });

  it("no master address / malformed amount / unknown chain or asset → refused", async () => {
    await expect(plan({ depositor: "" })).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    await expect(plan({ amount: "1e3" })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(() => funds.asterFundsChain("ethereum")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
    expect(() => funds.asterFundsAsset("DAI")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
  });
});

describe("executeAsterDeposit", () => {
  it("approve(vault, EXACT amount) then deposit(token, amount, 1) from the master; never a token transfer", async () => {
    const p = await plan();
    const res = await funds.executeAsterDeposit(p, sign);
    expect(rpc.broadcasts).toHaveLength(2);
    const [approve, deposit] = rpc.broadcasts;
    expect(approve.to).toBe(BSC_USDT);
    expect(erc20.parseTransaction({ data: approve.data })!.args.toArray()).toEqual([BSC_VAULT, parseUnits("5", 18)]);
    expect(deposit.to).toBe(BSC_VAULT);
    expect(funds.ASTER_VAULT.parseTransaction({ data: deposit.data })!.args.toArray()).toEqual([BSC_USDT, DEPOSITOR, parseUnits("5", 18), 1n]);
    expect(rpc.broadcasts.every(t => t.from === DEPOSITOR && t.chainId === 56n && t.value === 0n)).toBe(true);
    expect(res).toEqual({ approveTxHash: approve.hash, depositTxHash: deposit.hash, depositedRaw: parseUnits("5", 18).toString() });
  });

  it("skips the approve when the allowance suffices", async () => {
    rpc.allowance = parseUnits("9", 18);
    const res = await funds.executeAsterDeposit(await plan(), sign);
    expect(rpc.broadcasts).toHaveLength(1);
    expect(res.approveTxHash).toBeNull();
  });

  it("deposit simulation reverts → ACTION_REJECTED, nothing broadcast", async () => {
    rpc.allowance = parseUnits("9", 18); rpc.simulateFails = true;
    await expect(funds.executeAsterDeposit(await plan(), sign)).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it.each([
    ["no Deposit event", []],
    ["event from another contract", [depositLog({ vault: ARB_VAULT })]],
    ["event for another account", [depositLog({ account: "0x000000000000000000000000000000000000dEaD" })]],
    ["event for another currency", [depositLog({ currency: ARB_USDC })]],
    ["broker 1000 (spot account)", [depositLog({ broker: 1000n })]],
    ["native deposit event", [depositLog({ isNative: true })]],
  ])("receipt verification: %s → ORDER_PENDING with the tx hash (mined, not verified)", async (_name, logs) => {
    rpc.allowance = parseUnits("9", 18); rpc.logs = logs;
    await expect(funds.executeAsterDeposit(await plan(), sign)).rejects.toMatchObject({
      structured: { code: "ORDER_PENDING", details: { txHash: rpc.broadcasts[0]?.hash ?? expect.any(String) } },
    });
    expect(rpc.broadcasts).toHaveLength(1);
  });

  it("receipt timeout after the broadcast → ORDER_PENDING with the tx hash, never TIMEOUT / failed", async () => {
    rpc.allowance = parseUnits("9", 18); rpc.wait = "timeout";
    const err = await funds.executeAsterDeposit(await plan(), sign).catch(e => e);
    expect(err.structured).toMatchObject({ code: "ORDER_PENDING", retryable: false, details: { txHash: rpc.broadcasts[0].hash } });
    expect(err.structured.remediation).toContain("Do NOT resend");
  });

  it("reverted deposit → ACTION_REJECTED (definite)", async () => {
    rpc.allowance = parseUnits("9", 18); rpc.wait = "revert";
    await expect(funds.executeAsterDeposit(await plan(), sign)).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED" } });
  });

  it("a signature from another key is refused before the broadcast", async () => {
    const other = async (tx: Transaction): Promise<string> => new SigningKey(`0x${"43".repeat(32)}`).sign(tx.unsignedHash).serialized;
    await expect(funds.executeAsterDeposit(await plan(), other)).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });
});

describe("awaitAsterDepositCredit", () => {
  const TX = `0x${"ab".repeat(32)}`;
  const timing = (timeoutMs = 20_000) => { let t = 0; return { timeoutMs, pollMs: 5_000, sleep: async (ms: number) => { t += ms; }, now: () => t }; };
  const row = (state: string) => ({ id: "1", type: "DEPOSIT", asset: "USDT", amount: "5", state, txHash: TX.toUpperCase().replace("0X", "0x"), time: 1, chainId: 56, accountType: "perp" });

  it("PROCESSING → SUCCESS", async () => {
    const read = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row("PROCESSING")]).mockResolvedValue([row("SUCCESS")]);
    await expect(funds.awaitAsterDepositCredit(read, TX, timing())).resolves.toMatchObject({ state: "SUCCESS", accountType: "perp" });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("-5050 DEPOSIT_REQUIRED from the history endpoint means not credited yet: keeps polling", async () => {
    const { PerpError } = await import("../../errors.js");
    const read = vi.fn().mockRejectedValueOnce(new PerpError("DEPOSIT_REQUIRED", "This function can only be used after deposit.")).mockResolvedValue([row("SUCCESS")]);
    await expect(funds.awaitAsterDepositCredit(read, TX, timing())).resolves.toMatchObject({ state: "SUCCESS" });
  });

  it("not credited within the window → ORDER_PENDING with the tx hash (never failed)", async () => {
    const read = vi.fn().mockResolvedValue([row("PROCESSING")]);
    await expect(funds.awaitAsterDepositCredit(read, TX, timing(10_000))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING", details: { txHash: TX } } });
  });

  it("venue reports FAILED → EXCHANGE_ERROR with the tx hash", async () => {
    await expect(funds.awaitAsterDepositCredit(vi.fn().mockResolvedValue([row("FAILED")]), TX, timing())).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR", details: { txHash: TX } } });
  });
});

describe("withdraw typed data (EVM Withdraw Signature)", () => {
  const P = { chainId: 56, chainName: "BSC", receiver: "0x000ae314e2a2172a039b26378814c252734f556a", asset: "USDT", amount: "31", fee: "0.3", userNonce: "1761210000000000" };

  it("domain Aster/1/<destination chainId>/zero, type Action with the documented field names and order", () => {
    const td = buildWithdrawTypedData(P);
    expect(td.domain).toEqual({ name: "Aster", version: "1", chainId: 56, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(td.primaryType).toBe("Action");
    expect(td.types.Action.map(f => `${f.type} ${f.name}`)).toEqual([
      "string type", "address destination", "string destination Chain", "string token", "string amount", "string fee", "uint256 nonce", "string aster chain",
    ]);
    expect(td.message).toEqual({
      "type": "Withdraw", "destination": P.receiver, "destination Chain": "BSC", "token": "USDT", "amount": "31", "fee": "0.3",
      "nonce": "1761210000000000", "aster chain": "Mainnet",
    });
    expect(buildWithdrawTypedData({ ...P, chainId: 42161, chainName: "Arbitrum" }).domain.chainId).toBe(42161);
  });

  it("vector: type hash and digest are stable; a signature over it recovers the signer", async () => {
    const td = buildWithdrawTypedData(P);
    const types = td.types as unknown as Record<string, Array<{ name: string; type: string }>>;
    expect(TypedDataEncoder.from(types).encodeType("Action")).toBe(
      "Action(string type,address destination,string destination Chain,string token,string amount,string fee,uint256 nonce,string aster chain)");
    // Digest of the docs' example request (chainId 56, USDT, 31, fee 0.3, nonce 1761210000000000).
    expect(TypedDataEncoder.hash(td.domain, types, td.message)).toBe("0xb40add4d990e6389a824e6cb91204a8ff0eed69a54240e7dba67cf64e5b98e6a");
    const sig = await WALLET.signTypedData(td.domain, types, td.message);
    expect(verifyTypedData(td.domain, types, td.message, sig)).toBe(DEPOSITOR);
    expect(() => funds.assertAsterWithdrawSignature(td, sig, DEPOSITOR)).not.toThrow();
    expect(() => funds.assertAsterWithdrawSignature(td, sig, "0x000000000000000000000000000000000000dEaD")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SIGNATURE_FAILED" }) }));
  });
});

describe("withdraw limits", () => {
  const info = { balances: { USDT: { currency: "USDT", chainBalances: { "56": { chainId: 56, perpMaxWithdrawAmount: "300", withdrawFee: "0.5" } } } } };

  it("reads perpMaxWithdrawAmount / withdrawFee for (asset, chain); missing → refusal, never a default", () => {
    expect(funds.parseAsterWithdrawLimits(info, "USDT", 56)).toEqual({ max: "300", fee: "0.5" });
    expect(() => funds.parseAsterWithdrawLimits(info, "USDT", 42161)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INSUFFICIENT_BALANCE" }) }));
    expect(() => funds.parseAsterWithdrawLimits({ balances: { USDT: { chainBalances: { "56": { perpMaxWithdrawAmount: "300" } } } } }, "USDT", 56))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "EXCHANGE_ERROR" }) }));
  });

  it("amount must exceed the fee and not exceed the maximum", () => {
    expect(() => funds.assertAsterWithdrawAmount("10", { max: "300", fee: "0.5" }, "USDT")).not.toThrow();
    expect(() => funds.assertAsterWithdrawAmount("0.5", { max: "300", fee: "0.5" }, "USDT")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SIZE_TOO_SMALL" }) }));
    expect(() => funds.assertAsterWithdrawAmount("300.000001", { max: "300", fee: "0.5" }, "USDT")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INSUFFICIENT_BALANCE" }) }));
  });
});

describe("AsterAdapter.withdraw", () => {
  const AGENT = "0x00000000000000000000000000000000000A6e17";
  const meta = (canWithdraw: boolean) => ({
    agentName: "t", agentWalletName: "agent-aster-main", agentEvmAddress: AGENT as `0x${string}`, userEvmAddress: DEPOSITOR as `0x${string}`,
    masterWalletName: "main", owsApiKeyId: "k", owsPolicyId: "p", expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    approvedAt: new Date().toISOString(), permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw }, asterApprovalNonce: "1", status: "active" as const,
  });
  const agentStrategy = { getAddress: () => AGENT, signTypedData: vi.fn(async () => ({ signature: "0xAgentSig", r: "0x00", s: "0x00", v: 27 })) };
  const masterSigner = (w: Wallet = WALLET) => ({
    getAddress: () => w.address,
    signTypedData: (d: Record<string, unknown>, t: Record<string, Array<{ name: string; type: string }>>, v: Record<string, unknown>) => w.signTypedData(d, t, v),
    signMessage: (m: string | Uint8Array) => w.signMessage(m),
  });

  async function adapter(o: { canWithdraw?: boolean; master?: ReturnType<typeof masterSigner> | null; testnet?: boolean } = {}) {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const a = new AsterAdapter(undefined, o.testnet === true);
    a.setAgent(meta(o.canWithdraw ?? true) as never, agentStrategy as never);
    if (o.master !== null) a.setMasterSigner(o.master ?? masterSigner());
    return a;
  }

  function venue(withdrawResponse: () => Response | Promise<Response> = () => new Response(JSON.stringify({ withdrawId: "777", hash: "0xdigest" }))) {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url));
      calls.push(u);
      if (u.pathname === "/fapi/v3/aster/user-withdraw-info") {
        return new Response(JSON.stringify({ balances: { USDT: { currency: "USDT", chainBalances: {
          "56": { chainId: 56, perpMaxWithdrawAmount: "300", withdrawFee: "0.5" },
          "42161": { chainId: 42161, perpMaxWithdrawAmount: "300", withdrawFee: "0.8" },
        } } } }));
      }
      if (u.pathname === "/fapi/v3/aster/user-withdraw") return withdrawResponse();
      throw new Error(`unexpected fetch ${u.pathname}`);
    }));
    return { calls, withdrawCalls: () => calls.filter(c => c.pathname === "/fapi/v3/aster/user-withdraw") };
  }

  it("sends chainId / asset / amount / fee / receiver / userNonce / userSignature; the master signature covers the identical strings and recovers to the user", async () => {
    const v = venue();
    const res = await (await adapter()).withdraw("10", DEPOSITOR, { chain: "arbitrum" });
    expect(res).toEqual({ withdrawId: "777", hash: "0xdigest", chain: "arbitrum", chainId: 42161, asset: "USDT", amount: "10", fee: "0.8", receiver: DEPOSITOR });
    const [call] = v.withdrawCalls();
    const q = call.searchParams;
    expect([...q.keys()]).toEqual(["chainId", "asset", "amount", "fee", "receiver", "userNonce", "userSignature", "nonce", "user", "signer", "signature"]);
    expect(Object.fromEntries(q)).toMatchObject({ chainId: "42161", asset: "USDT", amount: "10", fee: "0.8", receiver: DEPOSITOR, user: DEPOSITOR, signer: AGENT, signature: "0xAgentSig" });
    expect(q.get("userNonce")).toMatch(/^\d{16}$/);
    const td = buildWithdrawTypedData({ chainId: 42161, chainName: "Arbitrum", receiver: DEPOSITOR, asset: "USDT", amount: q.get("amount")!, fee: q.get("fee")!, userNonce: q.get("userNonce")! });
    expect(verifyTypedData(td.domain, td.types as never, td.message, q.get("userSignature")!)).toBe(DEPOSITOR);
  });

  it("defaults to BNB Chain (fee of chain 56, domain chainId 56)", async () => {
    const v = venue();
    const res = await (await adapter()).withdraw("10", DEPOSITOR);
    expect(res).toMatchObject({ chain: "bsc", chainId: 56, fee: "0.5" });
    expect(v.withdrawCalls()[0].searchParams.get("chainId")).toBe("56");
  });

  it("receiver other than the account's own address → INVALID_PARAMS, no request at all", async () => {
    const v = venue();
    await expect((await adapter()).withdraw("10", "0x000000000000000000000000000000000000dEaD")).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(v.calls).toHaveLength(0);
  });

  it("agent without canWithdraw → POLICY_DENIED with the re-approve remediation, no request", async () => {
    const v = venue();
    const err = await (await adapter({ canWithdraw: false })).withdraw("10", DEPOSITOR).catch(e => e);
    expect(err.structured.code).toBe("POLICY_DENIED");
    expect(err.structured.remediation).toContain("wallet agent approve aster --can-withdraw --ip-whitelist");
    expect(err.structured.remediation).toContain("--rotate");
    expect(v.calls).toHaveLength(0);
  });

  it("no master signer / a master that is not the account owner → refused, nothing sent", async () => {
    const v = venue();
    await expect((await adapter({ master: null })).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    await expect((await adapter({ master: masterSigner(new Wallet(`0x${"43".repeat(32)}`)) })).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(v.calls).toHaveLength(0);
  });

  it("a userSignature that does not recover to the user → SIGNATURE_FAILED before the withdraw request", async () => {
    const v = venue();
    const forged = { ...masterSigner(), signTypedData: (d: never, t: never, m: never) => new Wallet(`0x${"43".repeat(32)}`).signTypedData(d, t, m) };
    await expect((await adapter({ master: forged })).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
    expect(v.withdrawCalls()).toHaveLength(0);
  });

  it("amount ≤ fee / > max → refused before signing", async () => {
    const v = venue();
    const a = await adapter();
    await expect(a.withdraw("0.5", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    await expect(a.withdraw("301", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    expect(v.withdrawCalls()).toHaveLength(0);
  });

  it("testnet → CAPABILITY_UNSUPPORTED", async () => {
    const v = venue();
    await expect((await adapter({ testnet: true })).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(v.calls).toHaveLength(0);
  });

  it("HTTP 5xx / lost response / 2xx without withdrawId after the send → ORDER_PENDING (never resubmit)", async () => {
    venue(() => new Response("bad gateway", { status: 502 }));
    await expect((await adapter()).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    venue(() => { throw new TypeError("fetch failed"); });
    await expect((await adapter()).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
    venue(() => new Response(JSON.stringify({ ok: true })));
    await expect((await adapter()).withdraw("10", DEPOSITOR)).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("a venue refusal (4xx envelope) is definite, not pending", async () => {
    venue(() => new Response(JSON.stringify({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }), { status: 401 }));
    const err = await (await adapter()).withdraw("10", DEPOSITOR).catch(e => e);
    expect(err.structured.code).not.toBe("ORDER_PENDING");
  });
});

describe("agent approve pre-flight + -5050 remediation", () => {
  it("--can-withdraw without --ip-whitelist is refused on any network before anything is signed", async () => {
    const { assertAsterWithdrawIpWhitelist } = await import("../../commands/agent.js");
    expect(() => assertAsterWithdrawIpWhitelist(true, undefined)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
    expect(() => assertAsterWithdrawIpWhitelist(true, " , ")).toThrow(/IP whitelist/);
    expect(() => assertAsterWithdrawIpWhitelist(true, "1.2.3.4")).not.toThrow();
    expect(() => assertAsterWithdrawIpWhitelist(false, undefined)).not.toThrow();
  });

  it("-5050 DEPOSIT_REQUIRED points at `perp funds deposit aster`", async () => {
    const { classifyError } = await import("../../errors.js");
    const s = classifyError(new Error("[-5050] This function can only be used after deposit."), "aster");
    expect(s.code).toBe("DEPOSIT_REQUIRED");
    expect(s.remediation).toContain("perp funds deposit aster");
  });
});
