/**
 * Bridge payload verification (review 2026-10-13):
 *  - deBridge create-tx EVM transactions are decoded and checked against the request before
 *    anything is signed (pinned DlnSource, give / take token + amount + chain, receiver, order
 *    authorities, value ≤ fixFee, affiliate fee); tampered answers are refused;
 *  - Solana-origin deBridge is refused (NO_BRIDGE_ROUTE);
 *  - approvals are exact (never MaxUint256);
 *  - USDC amounts are exact decimals (> 6 decimals refused);
 *  - CCTP EVM → Solana standard finality: no Solana signer → refused before sending; attestation
 *    timeout / failed receiveMessage → ORDER_PENDING with the burn tx hash;
 *  - HyperCore → Solana CCTP is refused.
 * No network: fetch is mocked; nothing reaches an RPC.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Interface, MaxUint256, Wallet } from "ethers";
import {
  verifyDebridgeEvmTx, executeDebridgeBridge, getDebridgeQuote, executeBestBridge, executeCctpBridge, getCctpQuote,
  completeEvmToSolanaMint, usdcApproveData, usdcUnits, parseUsdcAmount, USDC_ADDRESSES, CHAIN_IDS,
  type BridgeQuote, type DebridgeTxExpectation,
} from "../bridge-engine.js";

const DLN_SOURCE = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66";
const OC = "tuple(address giveTokenAddress, uint256 giveAmount, bytes takeTokenAddress, uint256 takeAmount, uint256 takeChainId, bytes receiverDst, address givePatchAuthoritySrc, bytes orderAuthorityAddressDst, bytes allowedTakerDst, bytes externalCall, bytes allowedCancelBeneficiarySrc)";
const DLN = new Interface([
  `function createOrder(${OC} _orderCreation, bytes _affiliateFee, uint32 _referralCode, bytes _permitEnvelope) payable returns (bytes32)`,
  `function createSaltedOrder(${OC} _orderCreation, uint64 _salt, bytes _affiliateFee, uint32 _referralCode, bytes _permitEnvelope, bytes _metadata) payable returns (bytes32)`,
]);

const wallet = Wallet.createRandom();
const SENDER = wallet.address;
const RECIPIENT = SENDER; // own address on Base
const OTHER = "0x1111111111111111111111111111111111111111";

interface Order {
  giveTokenAddress: string; giveAmount: bigint; takeTokenAddress: string; takeAmount: bigint; takeChainId: bigint;
  receiverDst: string; givePatchAuthoritySrc: string; orderAuthorityAddressDst: string; allowedTakerDst: string;
  externalCall: string; allowedCancelBeneficiarySrc: string;
}

function goodOrder(): Order {
  return {
    giveTokenAddress: USDC_ADDRESSES.arbitrum, giveAmount: 5_000_000n,
    takeTokenAddress: USDC_ADDRESSES.base.toLowerCase(), takeAmount: 4_990_000n, takeChainId: BigInt(CHAIN_IDS.base),
    receiverDst: RECIPIENT.toLowerCase(), givePatchAuthoritySrc: SENDER, orderAuthorityAddressDst: RECIPIENT.toLowerCase(),
    allowedTakerDst: "0x", externalCall: "0x", allowedCancelBeneficiarySrc: "0x",
  };
}

function txOf(order: Order, over: { to?: string; value?: string; affiliate?: string; permit?: string } = {}): Record<string, unknown> {
  const o = [order.giveTokenAddress, order.giveAmount, order.takeTokenAddress, order.takeAmount, order.takeChainId, order.receiverDst,
    order.givePatchAuthoritySrc, order.orderAuthorityAddressDst, order.allowedTakerDst, order.externalCall, order.allowedCancelBeneficiarySrc];
  return {
    to: over.to ?? DLN_SOURCE,
    data: DLN.encodeFunctionData("createSaltedOrder", [o, 42n, over.affiliate ?? "0x", 0, over.permit ?? "0x", "0x"]),
    value: over.value ?? "1000000000000000",
  };
}

const expectation: DebridgeTxExpectation = {
  srcChain: "arbitrum", dstChain: "base", sender: SENDER, recipient: RECIPIENT,
  giveAmount: 5_000_000n, takeAmount: 4_990_000n, fixFee: 1_000_000_000_000_000n, affiliate: null,
};

const refused = { structured: { code: "POLICY_DENIED" } };

afterEach(() => vi.restoreAllMocks());

describe("verifyDebridgeEvmTx", () => {
  it("accepts the expected createSaltedOrder to the pinned DlnSource", async () => {
    const v = await verifyDebridgeEvmTx(txOf(goodOrder()), expectation);
    expect(v.to).toBe(DLN_SOURCE);
    expect(v.value).toBe(1_000_000_000_000_000n);
  });

  it("refuses a tampered tx.to", async () => {
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { to: OTHER }), expectation)).rejects.toMatchObject(refused);
  });

  it("refuses a tampered receiver / destination order authority", async () => {
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), receiverDst: OTHER }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), orderAuthorityAddressDst: OTHER }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), givePatchAuthoritySrc: OTHER }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), allowedCancelBeneficiarySrc: OTHER }), expectation)).rejects.toMatchObject(refused);
  });

  it("refuses a tampered give amount / token, take token / chain / amount", async () => {
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), giveAmount: 5_000_001n }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), giveTokenAddress: OTHER }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), takeTokenAddress: OTHER }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), takeChainId: 1n }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), takeAmount: 1n }), expectation)).rejects.toMatchObject(refused);
  });

  it("refuses a value above the quoted fixFee", async () => {
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { value: "1000000000000001" }), expectation)).rejects.toMatchObject(refused);
  });

  it("refuses an external call, a permit, an unconfigured affiliate fee, and unknown calldata", async () => {
    await expect(verifyDebridgeEvmTx(txOf({ ...goodOrder(), externalCall: "0x1234" }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { permit: "0x12" }), expectation)).rejects.toMatchObject(refused);
    const aff = OTHER + (1000n).toString(16).padStart(64, "0");
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { affiliate: aff }), expectation)).rejects.toMatchObject(refused);
    await expect(verifyDebridgeEvmTx({ to: DLN_SOURCE, data: usdcApproveData(OTHER, 1n), value: "0" }, expectation)).rejects.toMatchObject(refused);
  });

  it("accepts a configured affiliate fee to the configured recipient within feePercent, refuses others", async () => {
    const x = { ...expectation, affiliate: { feePercent: 0.1, feeRecipient: OTHER } };
    const ok = OTHER + (5000n).toString(16).padStart(64, "0"); // 0.1% of 5 USDC
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { affiliate: ok }), x)).resolves.toBeTruthy();
    const tooMuch = OTHER + (50_000n).toString(16).padStart(64, "0");
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { affiliate: tooMuch }), x)).rejects.toMatchObject(refused);
    const wrongTo = SENDER.toLowerCase() + (5000n).toString(16).padStart(64, "0");
    await expect(verifyDebridgeEvmTx(txOf(goodOrder(), { affiliate: wrongTo }), x)).rejects.toMatchObject(refused);
  });
});

describe("executeDebridgeBridge", () => {
  const quote: BridgeQuote = {
    provider: "debridge", srcChain: "arbitrum", dstChain: "base", amountIn: 5, amountOut: 4.99, fee: 0.01, estimatedTime: 5, gasIncluded: true,
    nativeFee: null,
    raw: {
      quote: { estimation: { srcChainTokenIn: { amount: "5000000" }, dstChainTokenOut: { amount: "4990000", recommendedAmount: "4990000" } } },
      senderAddress: SENDER, recipientAddress: RECIPIENT, amountRaw: "5000000", fixFee: "1000000000000000",
    },
  };

  it("refuses a tampered create-tx answer before any RPC call or signature", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("/dln/order/create-tx")) return new Response(JSON.stringify({ tx: txOf({ ...goodOrder(), receiverDst: OTHER }) }), { status: 200 });
      throw new Error(`unexpected network call ${url}`);
    });
    await expect(executeDebridgeBridge("mainnet", quote, wallet.privateKey)).rejects.toMatchObject(refused);
    expect(calls.every(u => u.includes("/dln/order/create-tx"))).toBe(true);
  });

  it("refuses Solana-origin deBridge with NO_BRIDGE_ROUTE (quote, execute, executeBestBridge)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("no network"); });
    await expect(getDebridgeQuote("solana", "arbitrum", "5", "x", SENDER)).rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
    await expect(executeDebridgeBridge("mainnet", { ...quote, srcChain: "solana", dstChain: "arbitrum" }, wallet.privateKey))
      .rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
    await expect(executeBestBridge("mainnet", "solana", "arbitrum", "5", wallet.privateKey, "x", SENDER, undefined, "debridge"))
      .rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
  });
});

describe("exact approvals and amounts", () => {
  it("approve calldata carries the exact amount, never MaxUint256", () => {
    const decoded = new Interface(["function approve(address,uint256)"]).decodeFunctionData("approve", usdcApproveData(DLN_SOURCE, 5_000_000n));
    expect(decoded[1]).toBe(5_000_000n);
    expect(decoded[1]).not.toBe(MaxUint256);
  });

  it("USDC units are exact decimals; > 6 decimals and exponents are refused", () => {
    expect(usdcUnits("0.1")).toBe(100_000n);
    expect(usdcUnits("1234567.654321")).toBe(1_234_567_654_321n);
    expect(usdcUnits(0.3)).toBe(300_000n);
    expect(usdcUnits("4.2949")).toBe(4_294_900n);
    expect(parseUsdcAmount("05.500")).toBe("5.5");
    expect(() => usdcUnits("1.0000001")).toThrow(/more than 6 decimals/);
    expect(() => usdcUnits(0.1 + 0.2)).toThrow(/more than 6 decimals/);
    expect(() => usdcUnits(1e-7)).toThrow();
    expect(() => usdcUnits("1e3")).toThrow();
  });
});

describe("CCTP refusals and unknown outcomes", () => {
  it("HyperCore → Solana is refused (quote and execute)", async () => {
    await expect(getCctpQuote("hyperliquid", "solana", "5")).rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
    await expect(executeCctpBridge("mainnet", "hyperliquid", "solana", "5", wallet.privateKey, "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7"))
      .rejects.toMatchObject({ structured: { code: "NO_BRIDGE_ROUTE" } });
  });

  it("EVM → Solana standard finality without a Solana signer is refused before anything is sent", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("no network"); });
    await expect(executeCctpBridge("mainnet", "arbitrum", "solana", "5", wallet.privateKey, "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7", undefined, false))
      .rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("attestation timeout → ORDER_PENDING with the burn tx hash and Iris URL", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ messages: [{ status: "pending_confirmations" }] }), { status: 200 }));
    const receive = vi.fn();
    const err = await completeEvmToSolanaMint(3, "0xburn", "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7", "payer", { attempts: 2, intervalMs: 0, receive })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ structured: { code: "ORDER_PENDING", details: { txHash: "0xburn" } } });
    expect(String((err as Error).message)).toContain("mint on Solana not confirmed");
    expect(JSON.stringify((err as { structured: unknown }).structured)).toContain("iris-api.circle.com/v2/messages/3?transactionHash=0xburn");
    expect(JSON.stringify((err as { structured: unknown }).structured)).toContain("Do NOT resend");
    expect(receive).not.toHaveBeenCalled();
  });

  it("a failed receiveMessage → ORDER_PENDING (never a normal result)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ messages: [{ status: "complete", message: "0x01", attestation: "0x02" }] }), { status: 200 }));
    const receive = vi.fn(async () => { throw new Error("simulation failed"); });
    await expect(completeEvmToSolanaMint(3, "0xburn", "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7", "payer", { attempts: 1, intervalMs: 0, receive }))
      .rejects.toMatchObject({ structured: { code: "ORDER_PENDING", details: { txHash: "0xburn" } } });
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("a confirmed receiveMessage returns the mint signature", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ messages: [{ status: "complete", message: "0x01", attestation: "0x02" }] }), { status: 200 }));
    const receive = vi.fn(async () => "mintSig");
    await expect(completeEvmToSolanaMint(3, "0xburn", "r", "payer", { attempts: 1, intervalMs: 0, receive })).resolves.toBe("mintSig");
  });
});
