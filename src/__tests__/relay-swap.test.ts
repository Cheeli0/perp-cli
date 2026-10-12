/**
 * Relay swaps: local quote verification (order id, pinned depository, exact approve / deposit),
 * output protection, execution and status polling. Fixtures are real POST /quote responses
 * captured read-only on 2026-10-05 (trimmed). RPC (ethers JsonRpcProvider) and fetch are mocked —
 * nothing is sent anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Interface, SigningKey, Transaction, Wallet } from "ethers";

const KEY = `0x${"42".repeat(32)}`;
const erc20 = new Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const rpc = { chainId: 4663n, decimals: 6, balance: 100_000_000n, gas: 10n ** 18n, broadcasts: [] as Transaction[] };

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
      if (sel === erc20.getFunction("decimals")!.selector) return erc20.encodeFunctionResult("decimals", [rpc.decimals]);
      if (sel === erc20.getFunction("balanceOf")!.selector) return erc20.encodeFunctionResult("balanceOf", [rpc.balance]);
      throw new Error(`unexpected call ${sel}`);
    }
    async estimateGas(): Promise<bigint> { return 100_000n; }
    async getFeeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; }
    async getBalance(): Promise<bigint> { return rpc.gas; }
    async getTransactionCount(): Promise<number> { return rpc.broadcasts.length; }
    async broadcastTransaction(raw: string): Promise<{ hash: string }> {
      const tx = actual.Transaction.from(raw);
      rpc.broadcasts.push(tx);
      return { hash: tx.hash as string };
    }
    async waitForTransaction(): Promise<{ status: number; logs: never[] }> { return { status: 1, logs: [] }; }
  }
  return { ...actual, JsonRpcProvider: FakeProvider };
});

const relay = await import("../relay-swap.js");

type Quote = Record<string, any>;
const FIXTURES = JSON.parse(readFileSync(resolve(__dirname, "fixtures/relay-quotes.json"), "utf8")) as Record<string, Quote>;
const fixture = (name: string): Quote => structuredClone(FIXTURES[name]);

const USER = "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3";
const SOL = "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7";
const NOW = 1_791_130_000; // before the fixtures' deadlines
const REQ = { from: "robinhood", to: "arbitrum", fromAsset: "USDG", toAsset: "USDC", amount: "15", sender: USER, recipient: USER };
const REQ_SOL = { from: "robinhood", to: "solana", fromAsset: "USDG", toAsset: "SOL", amount: "15", sender: USER, recipient: SOL };
const REQ_ETH = { from: "arbitrum", to: "robinhood", fromAsset: "ETH", toAsset: "ETH", amount: "0.0056", sender: USER, recipient: USER };
const DEPOSITORY = relay.RELAY_CHAINS.robinhood.depository as string;
const USDG = relay.RELAY_CHAINS.robinhood.assets.USDG.address;

const denied = { structured: expect.objectContaining({ code: "POLICY_DENIED" }) };

beforeEach(() => { rpc.chainId = 4663n; rpc.decimals = 6; rpc.balance = 100_000_000n; rpc.gas = 10n ** 18n; rpc.broadcasts = []; });
afterEach(() => vi.unstubAllGlobals());

describe("chain table", () => {
  it("pins Robinhood Chain 4663 (USDG, RPC), BNB Chain 56 (USDT 18 decimals), Arbitrum, Solana and one depository", () => {
    expect(relay.RELAY_CHAINS.robinhood).toMatchObject({ chainId: 4663, protocolChainId: "robinhood", rpcUrl: "https://rpc.mainnet.chain.robinhood.com" });
    expect(USDG).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(relay.RELAY_CHAINS.bsc).toMatchObject({ chainId: 56, protocolChainId: "bnb" });
    expect(relay.RELAY_CHAINS.bsc.assets.USDT).toMatchObject({ address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 });
    expect(relay.RELAY_CHAINS.solana).toMatchObject({ chainId: 792703809, vm: "svm" });
    expect(relay.RELAY_CHAINS.solana.assets.SOL.address).toBe("11111111111111111111111111111111");
    expect(relay.RELAY_CHAINS.arbitrum.assets.ETH.address).toBe("0x0000000000000000000000000000000000000000");
    expect(DEPOSITORY.toLowerCase()).toBe("0x4cd00e387622c35bddb9b4c962c136462338bc31");
  });

  it("unknown chain / asset → NO_BRIDGE_ROUTE", () => {
    expect(() => relay.relayChain("tron")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "NO_BRIDGE_ROUTE" }) }));
    expect(() => relay.relayAsset("robinhood", "USDC")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "NO_BRIDGE_ROUTE" }) }));
  });
});

describe("order id (port of settlement-sdk getOrderId)", () => {
  it.each(["usdgToArbUsdc", "usdgToSolanaSol", "arbEthToRhEth"])("recomputes the live order id of %s", (name) => {
    const v2 = fixture(name).protocol.v2;
    expect(relay.relayOrderId(v2.orderData)).toBe(v2.orderId);
  });
});

describe("verifyRelayQuote", () => {
  it("accepts the real USDG → Arbitrum USDC quote: approve (exact, depository) + deposit", () => {
    const q = relay.verifyRelayQuote(fixture("usdgToArbUsdc"), REQ, NOW);
    expect(q).toMatchObject({ provider: "relay", amountInRaw: "15000000", expectedOutRaw: "14969920", minimumOutRaw: "14670522", expectedOut: "14.96992", recipient: USER });
    expect(q.txs.map(t => t.kind)).toEqual(["approve", "deposit"]);
    expect(q.txs[0]).toMatchObject({ to: USDG, value: 0n, chainId: 4663 });
    expect(q.txs[1]).toMatchObject({ to: DEPOSITORY, value: 0n, chainId: 4663 });
    const approve = erc20.parseTransaction({ data: q.txs[0].data })!;
    expect(String(approve.args[0]).toLowerCase()).toBe(DEPOSITORY.toLowerCase());
    expect(approve.args[1]).toBe(15_000_000n);
  });

  it("accepts EVM → Solana (recipient = the Solana address, native SOL) and native ETH → ETH (single deposit carrying the value)", () => {
    const sol = relay.verifyRelayQuote(fixture("usdgToSolanaSol"), REQ_SOL, NOW);
    expect(sol).toMatchObject({ recipient: SOL, toAsset: "SOL", expectedOutRaw: "122775488" });
    const eth = relay.verifyRelayQuote(fixture("arbEthToRhEth"), REQ_ETH, NOW);
    expect(eth.txs).toEqual([expect.objectContaining({ kind: "deposit", value: 5_600_000_000_000_000n, chainId: 42161 })]);
  });

  it("wrong deposit `to` → refused", () => {
    const f = fixture("usdgToArbUsdc");
    f.steps[1].items[0].data.to = "0x000000000000000000000000000000000000bEEF";
    expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(expect.objectContaining(denied));
  });

  it("wrong approve spender → refused", () => {
    const f = fixture("usdgToArbUsdc");
    f.steps[0].items[0].data.data = erc20.encodeFunctionData("approve", ["0x000000000000000000000000000000000000bEEF", 15_000_000n]);
    expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(/approval spender/);
  });

  it("unlimited / different approve amount → refused", () => {
    const f = fixture("usdgToArbUsdc");
    f.steps[0].items[0].data.data = erc20.encodeFunctionData("approve", [DEPOSITORY, 2n ** 256n - 1n]);
    expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(/approval amount/);
  });

  it("wrong step chainId → refused", () => {
    const f = fixture("usdgToArbUsdc");
    f.steps[1].items[0].data.chainId = 1;
    expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(/chainId/);
  });

  it("recipient mismatch (order pays someone else) → refused", () => {
    expect(() => relay.verifyRelayQuote(fixture("usdgToArbUsdc"), { ...REQ, recipient: "0x000000000000000000000000000000000000dEaD" }, NOW)).toThrow(/pays .* not the recipient/);
    // …and a tampered recipient inside the order no longer matches the order id.
    const f = fixture("usdgToArbUsdc");
    f.protocol.v2.orderData.output.payments[0].recipient = "0x000000000000000000000000000000000000dEaD";
    f.protocol.v2.orderData.inputs[0].refunds[1].recipient = "0x000000000000000000000000000000000000dEaD";
    expect(() => relay.verifyRelayQuote(f, { ...REQ, recipient: "0x000000000000000000000000000000000000dEaD" }, NOW)).toThrow(/order id/);
  });

  it("refunds: only (origin chain, input currency, sender) or (destination chain, output currency, recipient) — anything else → refused", () => {
    const DEAD = "0x000000000000000000000000000000000000dEaD";
    const ARB_USDC = relay.RELAY_CHAINS.arbitrum.assets.USDC.address;
    const mutate = (fn: (refunds: Array<Record<string, unknown>>, f: Quote) => void) => {
      const f = fixture("usdgToArbUsdc");
      fn(f.protocol.v2.orderData.inputs[0].refunds, f);
      return () => relay.verifyRelayQuote(f, REQ, NOW);
    };
    // The real quote's two entries are accepted as they are (see "accepts the real USDG → Arbitrum USDC quote").
    expect(mutate(() => {})).not.toThrow();
    expect(mutate((_r, f) => { f.protocol.v2.orderData.inputs[0].refunds = { 0: "x" }; })).toThrow(/no refunds list/);
    expect(mutate((_r, f) => { f.protocol.v2.orderData.inputs[0].refunds = null; })).toThrow(/no refunds list/);
    expect(mutate(r => { r[0] = null as never; })).toThrow(/malformed refund/);
    expect(mutate(r => { r[0].recipient = DEAD; })).toThrow(/refunds .* neither/);        // a third party
    expect(mutate(r => { r[0].chainId = "base"; })).toThrow(/refunds .* neither/);        // origin currency on another chain
    expect(mutate(r => { r[0].currency = ARB_USDC; })).toThrow(/refunds .* neither/);     // another currency on the origin chain
    expect(mutate(r => { r[1].currency = "0x0000000000000000000000000000000000000000"; })).toThrow(/refunds .* neither/); // another currency on the destination
    expect(mutate(r => { r[1].chainId = "robinhood"; })).toThrow(/refunds .* neither/);
    for (const thrower of [mutate(r => { r[0].recipient = DEAD; }), mutate(r => { r[1].chainId = "robinhood"; })]) {
      expect(thrower).toThrow(expect.objectContaining(denied));
    }
  });

  it("deposit mutations: amount / token mismatch, depositNative value mismatch, two deposits → refused", () => {
    const erc = new Interface(["function depositErc20(address depositor, address token, uint256 amount, bytes32 id)"]);
    const nat = new Interface(["function depositNative(address depositor, bytes32 id)"]);
    const ARB_USDC = relay.RELAY_CHAINS.arbitrum.assets.USDC.address;

    const amount = fixture("usdgToArbUsdc");
    amount.steps[1].items[0].data.data = erc.encodeFunctionData("depositErc20", [USER, USDG, 15_000_001n, amount.protocol.v2.orderId]);
    expect(() => relay.verifyRelayQuote(amount, REQ, NOW)).toThrow(/deposit amount 15000001 is not the input amount 15000000/);

    const token = fixture("usdgToArbUsdc");
    token.steps[1].items[0].data.data = erc.encodeFunctionData("depositErc20", [USER, ARB_USDC, 15_000_000n, token.protocol.v2.orderId]);
    expect(() => relay.verifyRelayQuote(token, REQ, NOW)).toThrow(/deposit token .* is not the input token/);

    const erc20WithValue = fixture("usdgToArbUsdc");
    erc20WithValue.steps[1].items[0].data.value = "1";
    expect(() => relay.verifyRelayQuote(erc20WithValue, REQ, NOW)).toThrow(/carries native value/);

    // Native origin: the tx value IS the deposit — one wei more or less is refused.
    for (const value of ["5600000000000001", "5599999999999999", "0"]) {
      const f = fixture("arbEthToRhEth");
      f.steps[0].items[0].data.value = value;
      expect(() => relay.verifyRelayQuote(f, REQ_ETH, NOW)).toThrow(/deposit sends \d+ wei, expected exactly 5600000000000000/);
    }
    // …and a native route must use depositNative, an ERC-20 route depositErc20.
    const wrongFn = fixture("usdgToArbUsdc");
    wrongFn.steps[1].items[0].data.data = nat.encodeFunctionData("depositNative", [USER, wrongFn.protocol.v2.orderId]);
    expect(() => relay.verifyRelayQuote(wrongFn, REQ, NOW)).toThrow(/does not match the input asset/);

    const two = fixture("usdgToArbUsdc");
    two.steps[1].items.push(structuredClone(two.steps[1].items[0]));
    expect(() => relay.verifyRelayQuote(two, REQ, NOW)).toThrow(/expected \[approve,\] deposit — got approve, deposit, deposit/);
    const twoNative = fixture("arbEthToRhEth");
    twoNative.steps.push(structuredClone(twoNative.steps[0]));
    expect(() => relay.verifyRelayQuote(twoNative, REQ_ETH, NOW)).toThrow(/got deposit, deposit/);
  });

  it("wrong output currency / destination chain (in the request or tampered in the order) → refused", () => {
    // The order pays Arbitrum USDC: asking for another asset or chain must not accept it.
    expect(() => relay.verifyRelayQuote(fixture("usdgToArbUsdc"), { ...REQ, toAsset: "ETH" }, NOW)).toThrow(/output currency .* is not ETH/);
    expect(() => relay.verifyRelayQuote(fixture("usdgToArbUsdc"), { ...REQ, to: "base" }, NOW)).toThrow(/pays out on "arbitrum", not base/);
    // Tampered order (currency / chain swapped inside orderData) → the refund pairing or the order id no longer holds.
    const cur = fixture("usdgToArbUsdc");
    cur.protocol.v2.orderData.output.payments[0].currency = "0x0000000000000000000000000000000000000000";
    expect(() => relay.verifyRelayQuote(cur, REQ, NOW)).toThrow(/output currency/);
    const chain = fixture("usdgToArbUsdc");
    chain.protocol.v2.orderData.output.chainId = "base";
    expect(() => relay.verifyRelayQuote(chain, REQ, NOW)).toThrow(/pays out on "base", not arbitrum/);
    for (const f of [cur, chain]) expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(expect.objectContaining(denied));
  });

  it("depository named by the quote differs from the pinned one / tampered minimum / extra calls / expired / amount mismatch → refused", () => {
    const a = fixture("usdgToArbUsdc");
    a.protocol.v2.paymentDetails.depository = "0x000000000000000000000000000000000000bEEF";
    expect(() => relay.verifyRelayQuote(a, REQ, NOW)).toThrow(/depository/);
    const b = fixture("usdgToArbUsdc");
    b.protocol.v2.orderData.output.payments[0].minimumAmount = "1";
    expect(() => relay.verifyRelayQuote(b, REQ, NOW)).toThrow(/order id/);
    const c = fixture("usdgToArbUsdc");
    c.protocol.v2.orderData.output.calls = ["0x1234"];
    expect(() => relay.verifyRelayQuote(c, REQ, NOW)).toThrow(/extra destination calls/);
    expect(() => relay.verifyRelayQuote(fixture("usdgToArbUsdc"), REQ, 1_900_000_000)).toThrow(/expired/);
    expect(() => relay.verifyRelayQuote(fixture("usdgToArbUsdc"), { ...REQ, amount: "14" }, NOW)).toThrow(/input amount/);
  });

  it("a deposit that does not commit to the order id / credits another depositor → refused", () => {
    const dep = new Interface(["function depositErc20(address depositor, address token, uint256 amount, bytes32 id)"]);
    const f = fixture("usdgToArbUsdc");
    f.steps[1].items[0].data.data = dep.encodeFunctionData("depositErc20", [USER, USDG, 15_000_000n, `0x${"11".repeat(32)}`]);
    expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(/order id/);
    const g = fixture("usdgToArbUsdc");
    g.steps[1].items[0].data.data = dep.encodeFunctionData("depositErc20", ["0x000000000000000000000000000000000000dEaD", USDG, 15_000_000n, g.protocol.v2.orderId]);
    expect(() => relay.verifyRelayQuote(g, REQ, NOW)).toThrow(/depositor/);
  });

  it("an unknown step kind (signature) → refused", () => {
    const f = fixture("usdgToArbUsdc");
    f.steps.push({ id: "sign", kind: "signature", requestId: f.steps[0].requestId, items: [] });
    expect(() => relay.verifyRelayQuote(f, REQ, NOW)).toThrow(expect.objectContaining(denied));
  });
});

describe("output protection", () => {
  const q = () => relay.verifyRelayQuote(fixture("usdgToArbUsdc"), REQ, NOW);

  it("stable → stable without --min-out: expected out must be ≥ amount in − 3 %", () => {
    expect(relay.relayMinOutVerdict(q(), null)).toMatchObject({ ok: true, rule: "default", floor: "14.55" });
    const low = { ...q(), expectedOutRaw: "14000000", expectedOut: "14.0" };
    expect(relay.relayMinOutVerdict(low, null)).toMatchObject({ ok: false, rule: "default" });
    expect(() => relay.assertRelayMinOut(low, null)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "RISK_VIOLATION" }) }));
  });

  it("--min-out is checked against the protocol-enforced minimum, not the estimate", () => {
    expect(relay.relayMinOutVerdict(q(), "14.6")).toMatchObject({ ok: true, rule: "explicit" });
    // expected 14.96992 would pass 14.9, the guaranteed 14.670522 does not.
    expect(() => relay.assertRelayMinOut(q(), "14.9")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "RISK_VIOLATION" }) }));
  });

  it("stable → native requires an explicit --min-out", () => {
    const sol = relay.verifyRelayQuote(fixture("usdgToSolanaSol"), REQ_SOL, NOW);
    expect(relay.relayMinOutVerdict(sol, null)).toMatchObject({ ok: false, rule: "required" });
    expect(() => relay.assertRelayMinOut(sol, null)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "INVALID_PARAMS" }) }));
    expect(relay.assertRelayMinOut(sol, "0.12")).toMatchObject({ ok: true });
  });

  it("native ETH → ETH is a same-value pair (3 % rule on the same units)", () => {
    expect(relay.relayMinOutVerdict(relay.verifyRelayQuote(fixture("arbEthToRhEth"), REQ_ETH, NOW), null)).toMatchObject({ ok: true, rule: "default" });
  });
});

describe("executeRelaySwap", () => {
  const sign = async (tx: Transaction): Promise<string> => new SigningKey(KEY).sign(tx.unsignedHash).serialized;
  const SENDER = new Wallet(KEY).address;
  /** The fixture quote re-addressed to the test key (verification is covered above). */
  const quote = () => ({ ...relay.verifyRelayQuote(fixture("usdgToArbUsdc"), REQ, NOW), sender: SENDER });
  const timing = (over: Partial<{ timeoutMs: number }> = {}) => {
    let t = NOW * 1000;
    return { timeoutMs: over.timeoutMs ?? 10_000, pollMs: 1_000, sleep: async (ms: number) => { t += ms; }, now: () => t };
  };
  const statusFetch = (statuses: string[]) => {
    let i = 0;
    return vi.fn(async (url: string) => {
      expect(String(url)).toContain("https://api.relay.link/intents/status/v3?requestId=");
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return new Response(JSON.stringify({ status, txHashes: status === "success" ? ["0xfill"] : [] }));
    });
  };

  it("testnet → NO_BRIDGE_ROUTE before anything", async () => {
    await expect(relay.executeRelaySwap("testnet", quote(), sign, timing())).rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("sends the verified approve + deposit from the sender on the origin chain, then polls to success", async () => {
    vi.stubGlobal("fetch", statusFetch(["waiting", "pending", "success"]));
    const q = quote();
    const res = await relay.executeRelaySwap("mainnet", q, sign, timing());
    expect(rpc.broadcasts).toHaveLength(2);
    expect(rpc.broadcasts.map(t => t.to)).toEqual([USDG, DEPOSITORY]);
    expect(rpc.broadcasts.every(t => t.chainId === 4663n && t.from === SENDER && t.value === 0n)).toBe(true);
    expect(rpc.broadcasts[1].data).toBe(q.txs[1].data);
    expect(res).toMatchObject({ status: "success", requestId: q.requestId, approveTxHash: rpc.broadcasts[0].hash, depositTxHash: rpc.broadcasts[1].hash, destinationTxHashes: ["0xfill"] });
  });

  it("fill not confirmed within the window → ORDER_PENDING with the request id and the deposit tx hash (never failed)", async () => {
    vi.stubGlobal("fetch", statusFetch(["pending"]));
    const q = quote();
    await expect(relay.executeRelaySwap("mainnet", q, sign, timing({ timeoutMs: 3_000 }))).rejects.toMatchObject({
      structured: { code: "ORDER_PENDING", details: { requestId: q.requestId, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } },
    });
    expect(rpc.broadcasts).toHaveLength(2);
  });

  it("status endpoint unreachable → still ORDER_PENDING (unknown), not an error that invites a resend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(relay.executeRelaySwap("mainnet", quote(), sign, timing({ timeoutMs: 2_000 }))).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });

  it("Relay reports refund → ACTION_REJECTED (definite)", async () => {
    vi.stubGlobal("fetch", statusFetch(["refund"]));
    await expect(relay.executeRelaySwap("mainnet", quote(), sign, timing())).rejects.toMatchObject({ structured: { code: "ACTION_REJECTED", details: { relayStatus: "refund" } } });
  });

  it("RPC serving another chain / short balance / no gas / wrong on-chain decimals → refused before signing", async () => {
    rpc.chainId = 1n;
    await expect(relay.executeRelaySwap("mainnet", quote(), sign, timing())).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    rpc.chainId = 4663n; rpc.balance = 1n;
    await expect(relay.executeRelaySwap("mainnet", quote(), sign, timing())).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    rpc.balance = 100_000_000n; rpc.gas = 0n;
    await expect(relay.executeRelaySwap("mainnet", quote(), sign, timing())).rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
    rpc.gas = 10n ** 18n; rpc.decimals = 18;
    await expect(relay.executeRelaySwap("mainnet", quote(), sign, timing())).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("a signature from another key is refused before the broadcast", async () => {
    const other = async (tx: Transaction): Promise<string> => new SigningKey(`0x${"43".repeat(32)}`).sign(tx.unsignedHash).serialized;
    await expect(relay.executeRelaySwap("mainnet", quote(), other, timing())).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });
});

describe("quoteRelaySwap", () => {
  it("POSTs /quote with EXACT_INPUT, chain ids, token addresses, raw amount, user + recipient, and verifies the answer", async () => {
    const f = fixture("usdgToSolanaSol");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(f)));
    vi.stubGlobal("fetch", fetchMock);
    // quoteRelaySwap checks the fixture's deadline against the wall clock: pin it before the deadline.
    vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] });
    let q: Awaited<ReturnType<typeof relay.quoteRelaySwap>>;
    try {
      q = await relay.quoteRelaySwap(REQ_SOL);
    } finally {
      vi.useRealTimers();
    }
    expect(q.expectedOut).toBe("0.122775488");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.relay.link/quote");
    expect(JSON.parse(String(init?.body))).toEqual({
      user: USER, recipient: SOL, originChainId: 4663, destinationChainId: 792703809,
      originCurrency: USDG, destinationCurrency: "11111111111111111111111111111111",
      amount: "15000000", tradeType: "EXACT_INPUT", includeProtocolData: true,
    });
  });

  it("an EVM recipient for a Solana destination → INVALID_PARAMS without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(relay.quoteRelaySwap({ ...REQ_SOL, recipient: USER })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
