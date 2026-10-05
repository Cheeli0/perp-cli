/**
 * Relay cross-chain swaps (https://api.relay.link, docs https://docs.relay.link) with local
 * verification of every quote before the master wallet signs anything.
 *
 * Flow: POST /quote (EXACT_INPUT, includeProtocolData) → verify → execute the EVM-origin steps
 * (ERC-20 approve for the exact amount + depository deposit, signed by the OWS master) →
 * poll GET /intents/status/v3 until success / failure (bounded; unknown → ORDER_PENDING with
 * the request id).
 *
 * Verification follows Relay's "Input Validation" guide
 * (docs.relay.link/references/api/api_core_concepts/input-validation):
 *   1. the protocol order (`protocol.v2.orderData`) pays the expected recipient the expected
 *      currency on the expected chain, takes exactly the requested input, has no extra calls,
 *      refunds only to the sender / recipient and is not expired;
 *   2. the order id is recomputed locally (EIP-712 struct hash of the order — a port of
 *      `getOrderId` from @relay-protocol/settlement-sdk) and must equal `protocol.v2.orderId`;
 *   3. the deposit transaction pays Relay's canonical depository — PINNED below per chain, never
 *      taken from the quote — commits to that order id, credits the sender as depositor and moves
 *      exactly the order's input; an approve step may only approve that depository for the exact
 *      amount on the origin token. Any other step, target, spender, amount or chain id is refused.
 *
 * Mainnet only. Origin must be an EVM chain (the master EVM wallet signs); the destination may be
 * EVM or Solana. The recipient is always the master wallet's own address — enforced by the CLI.
 */

import { Interface, TypedDataEncoder, formatUnits, getBytes, hexlify, parseUnits } from "ethers";
import bs58 from "bs58";
import { PerpError } from "./errors.js";
import {
  ERC20, EVM_ADDRESS_RE, assertRpcChainId, erc20Balance, erc20Decimals, evmProvider, sameAddress, sendMasterTx, type TxSigner,
} from "./evm-master-tx.js";
import type { Network } from "./exchanges/venue-types.js";

export const RELAY_API = "https://api.relay.link";

export interface RelayAsset {
  /** Token address; native = zero address (EVM) / system program (Solana), per Relay docs. */
  address: string;
  /** Pinned decimals — cross-checked against the quote and, for an ERC-20 origin, the chain. */
  decimals: number;
  /** USD stablecoin or the chain's native gas token. */
  kind: "stable" | "native";
}

export interface RelayChainDef {
  /** Relay chain id (EVM chain id; Solana = 792703809). */
  chainId: number;
  /** `protocol.v2.chainId` of the chain in Relay orders. */
  protocolChainId: string;
  vm: "evm" | "svm";
  label: string;
  /** Public JSON-RPC (EVM origins). */
  rpcUrl: string | null;
  /** Relay depository (EVM origins) — GET /chains `protocol.v2.depository`. */
  depository: string | null;
  assets: Readonly<Record<string, RelayAsset>>;
}

const EVM_NATIVE = "0x0000000000000000000000000000000000000000";
const SOLANA_NATIVE = "11111111111111111111111111111111";
/** Same depository address on every EVM chain below (GET https://api.relay.link/chains, 2026-10-05). */
const EVM_DEPOSITORY = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";

/**
 * Chains + assets the CLI bridges with Relay. Chain ids, protocol chain ids, depository and token
 * addresses verified 2026-10-05 against GET https://api.relay.link/chains (4663 "robinhood" with
 * USDG, 792703809 "solana", 56 "bnb", 42161 "arbitrum", 8453 "base") and the token issuers'
 * address lists (Circle USDC, Tether USDT, Paxos USDG on Robinhood Chain).
 */
export const RELAY_CHAINS: Readonly<Record<string, RelayChainDef>> = {
  arbitrum: {
    chainId: 42161, protocolChainId: "arbitrum", vm: "evm", label: "Arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc", depository: EVM_DEPOSITORY,
    assets: {
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, kind: "stable" },
      USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, kind: "stable" },
      ETH: { address: EVM_NATIVE, decimals: 18, kind: "native" },
    },
  },
  robinhood: {
    chainId: 4663, protocolChainId: "robinhood", vm: "evm", label: "Robinhood Chain",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com", depository: EVM_DEPOSITORY,
    assets: {
      USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, kind: "stable" },
      ETH: { address: EVM_NATIVE, decimals: 18, kind: "native" },
    },
  },
  bsc: {
    chainId: 56, protocolChainId: "bnb", vm: "evm", label: "BNB Chain",
    rpcUrl: "https://bsc-dataseed.bnbchain.org", depository: EVM_DEPOSITORY,
    assets: {
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, kind: "stable" },
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, kind: "stable" },
      BNB: { address: EVM_NATIVE, decimals: 18, kind: "native" },
    },
  },
  base: {
    chainId: 8453, protocolChainId: "base", vm: "evm", label: "Base",
    rpcUrl: "https://mainnet.base.org", depository: EVM_DEPOSITORY,
    assets: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, kind: "stable" },
      ETH: { address: EVM_NATIVE, decimals: 18, kind: "native" },
    },
  },
  solana: {
    chainId: 792703809, protocolChainId: "solana", vm: "svm", label: "Solana",
    rpcUrl: null, depository: null,
    assets: {
      USDC: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, kind: "stable" },
      SOL: { address: SOLANA_NATIVE, decimals: 9, kind: "native" },
    },
  },
};

/** Default slippage floor for same-value pairs: expected out ≥ amount in × (1 − 3 %). */
export const RELAY_MAX_SLIPPAGE_BPS = 300n;
/**
 * Floor on the protocol-GUARANTEED minimum (docs.relay.link: "Compare `minimumAmount`, not
 * `expectedAmount`"): the order's minimum may be at most this far below the amount in.
 */
export const RELAY_MAX_GUARANTEED_LOSS_BPS = 600n;
export const RELAY_STATUS_TIMEOUT_MS = 300_000;
export const RELAY_STATUS_POLL_MS = 3_000;

function noRoute(msg: string, remediation: string): PerpError {
  return new PerpError("NO_BRIDGE_ROUTE", msg, { remediation });
}

function refuse(msg: string): PerpError {
  return new PerpError("POLICY_DENIED", `Relay quote refused: ${msg}. Nothing was signed or sent.`, {
    exchange: "relay", remediation: "Do not retry blindly — the quote does not match what was requested. Re-run with --dry-run and compare, or bridge in the Relay app",
  });
}

export function relayChain(name: string): RelayChainDef {
  const def = RELAY_CHAINS[name.toLowerCase()];
  if (def === undefined) {
    throw noRoute(`Relay: unsupported chain "${name}"`, `Supported chains: ${Object.keys(RELAY_CHAINS).join(", ")}`);
  }
  return def;
}

export function relayAsset(chain: string, symbol: string): RelayAsset {
  const def = relayChain(chain);
  const key = Object.keys(def.assets).find(k => k.toLowerCase() === symbol.toLowerCase());
  if (key === undefined) {
    throw noRoute(`Relay: ${symbol} is not a supported asset on ${def.label}`, `Assets on ${chain.toLowerCase()}: ${Object.keys(def.assets).join(", ")}`);
  }
  return def.assets[key];
}

function sameOnChain(vm: "evm" | "svm", a: string, b: string): boolean {
  return vm === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validAddress(vm: "evm" | "svm", a: string): boolean {
  if (vm === "evm") return EVM_ADDRESS_RE.test(a);
  try {
    return bs58.decode(a).length === 32;
  } catch {
    return false;
  }
}

// ── Order id (port of @relay-protocol/settlement-sdk getOrderId, v1 order) ──

const ORDER_TYPES = {
  Order: [
    { name: "version", type: "string" }, { name: "solverChainId", type: "string" }, { name: "solver", type: "address" },
    { name: "salt", type: "uint256" }, { name: "inputs", type: "Input[]" }, { name: "output", type: "Output" }, { name: "fees", type: "Fee[]" },
  ],
  Input: [{ name: "payment", type: "InputPayment" }, { name: "refunds", type: "InputRefund[]" }],
  InputPayment: [
    { name: "chainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }, { name: "weight", type: "uint256" },
  ],
  InputRefund: [
    { name: "chainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" }, { name: "deadline", type: "uint32" }, { name: "extraData", type: "bytes" },
  ],
  Output: [
    { name: "chainId", type: "string" }, { name: "payments", type: "OutputPayment[]" }, { name: "deadline", type: "uint32" },
    { name: "calls", type: "bytes[]" }, { name: "extraData", type: "bytes" },
  ],
  OutputPayment: [
    { name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "expectedAmount", type: "uint256" },
  ],
  Fee: [
    { name: "recipientChainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currencyChainId", type: "string" },
    { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" },
  ],
};

interface RelayOrderData {
  version: string; solverChainId: string; solver: string; salt: string;
  inputs: Array<{
    payment: { chainId: string; currency: string; amount: string; weight: string };
    refunds: Array<{ chainId: string; recipient: string; currency: string; minimumAmount: string; deadline: number; extraData: string }>;
  }>;
  output: {
    chainId: string; deadline: number; calls: string[]; extraData: string;
    payments: Array<{ recipient: string; currency: string; minimumAmount: string; expectedAmount: string }>;
  };
  fees: Array<{ recipientChainId: string; recipient: string; currencyChainId: string; currency: string; amount: string }>;
}

function vmOfProtocolChain(protocolChainId: string): "evm" | "svm" {
  const def = Object.values(RELAY_CHAINS).find(c => c.protocolChainId === protocolChainId);
  if (def === undefined) throw refuse(`the order references chain "${protocolChainId}", which is not in the pinned chain table`);
  return def.vm;
}

/** Address → the bytes the order hash commits to: 20 bytes (EVM) / 32-byte public key (Solana). */
function addressBytes(address: string, protocolChainId: string): string {
  const vm = vmOfProtocolChain(protocolChainId);
  if (!validAddress(vm, address)) throw refuse(`the order carries an invalid ${protocolChainId} address ${JSON.stringify(address)}`);
  return vm === "evm" ? address.toLowerCase() : hexlify(bs58.decode(address));
}

/** EIP-712 struct hash of a Relay v1 order — must equal `protocol.v2.orderId`. */
export function relayOrderId(o: RelayOrderData): string {
  return TypedDataEncoder.hashStruct("Order", ORDER_TYPES, {
    version: o.version, solverChainId: o.solverChainId, solver: o.solver, salt: BigInt(o.salt),
    inputs: o.inputs.map(i => ({
      payment: { chainId: i.payment.chainId, currency: addressBytes(i.payment.currency, i.payment.chainId), amount: BigInt(i.payment.amount), weight: BigInt(i.payment.weight) },
      refunds: i.refunds.map(r => ({
        chainId: r.chainId, recipient: addressBytes(r.recipient, r.chainId), currency: addressBytes(r.currency, r.chainId),
        minimumAmount: BigInt(r.minimumAmount), deadline: r.deadline, extraData: hexlify(getBytes(r.extraData)),
      })),
    })),
    output: {
      chainId: o.output.chainId,
      payments: o.output.payments.map(p => ({
        recipient: addressBytes(p.recipient, o.output.chainId), currency: addressBytes(p.currency, o.output.chainId),
        minimumAmount: BigInt(p.minimumAmount), expectedAmount: BigInt(p.expectedAmount),
      })),
      deadline: o.output.deadline, calls: o.output.calls.map(c => hexlify(getBytes(c))), extraData: hexlify(getBytes(o.output.extraData)),
    },
    fees: o.fees.map(f => ({
      recipientChainId: f.recipientChainId, recipient: addressBytes(f.recipient, f.recipientChainId),
      currencyChainId: f.currencyChainId, currency: addressBytes(f.currency, f.currencyChainId), amount: BigInt(f.amount),
    })),
  });
}

// ── Quote ──

export interface RelaySwapRequest {
  from: string; to: string; fromAsset: string; toAsset: string;
  /** Input amount in token units (decimal string). */
  amount: string;
  sender: string; recipient: string;
}

/** One transaction of the quote, already checked against the order (see verifyRelaySteps). */
export interface RelayTx { kind: "approve" | "deposit"; to: string; data: string; value: bigint; chainId: number }

export interface RelaySwapQuote {
  provider: "relay";
  requestId: string;
  orderId: string;
  from: string; to: string; fromAsset: string; toAsset: string;
  sender: string; recipient: string;
  amountIn: string; amountInRaw: string;
  /** Quoted estimate (order `expectedAmount`). */
  expectedOut: string; expectedOutRaw: string;
  /** Floor the protocol enforces at settlement (order `minimumAmount`). */
  minimumOut: string; minimumOutRaw: string;
  amountInUsd: string | null; expectedOutUsd: string | null;
  fees: { originGasUsd: string | null; relayerUsd: string; relayerGasUsd: string | null; relayerServiceUsd: string | null; appUsd: string | null };
  /** Relay's `details.totalImpact.percent` (negative = cost). */
  totalImpactPercent: string | null;
  timeEstimateSec: number | null;
  /** Unix seconds after which the order can no longer fill. */
  deadline: number;
  /** Verified transactions to send, in order. */
  txs: RelayTx[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

const DEPOSITORY = new Interface([
  "function depositNative(address depositor, bytes32 id)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);

/**
 * The quote's transactions, each checked: chain id = origin, `from` = sender, the approve targets
 * the origin token and approves only the pinned depository for exactly the input, the deposit pays
 * the pinned depository, commits to the verified order id, credits the sender and moves exactly
 * the input. Anything else → POLICY_DENIED.
 */
export function verifyRelaySteps(steps: unknown, ctx: {
  origin: RelayChainDef; asset: RelayAsset; amountInRaw: bigint; sender: string; orderId: string;
}): RelayTx[] {
  if (!Array.isArray(steps) || steps.length === 0) throw refuse("the quote has no steps");
  const depository = ctx.origin.depository;
  if (depository === null) throw new Error(`relay: ${ctx.origin.label} has no pinned depository`);
  const native = ctx.asset.kind === "native";
  const txs: RelayTx[] = [];
  for (const s of steps) {
    const step = rec(s);
    if (step === null || step.kind !== "transaction" || !Array.isArray(step.items)) {
      throw refuse(`unsupported step ${JSON.stringify(step?.id)} of kind ${JSON.stringify(step?.kind)} (only approve / deposit transactions are executed)`);
    }
    for (const it of step.items) {
      const d = rec(rec(it)?.data);
      const to = str(d?.to);
      const data = str(d?.data);
      if (d === null || to === null || data === null || !EVM_ADDRESS_RE.test(to)) throw refuse(`step ${String(step.id)} has no transaction data`);
      if (d.chainId !== ctx.origin.chainId) throw refuse(`step ${String(step.id)} targets chainId ${JSON.stringify(d.chainId)}, expected ${ctx.origin.chainId} (${ctx.origin.label})`);
      const from = str(d.from);
      if (from !== null && !sameAddress(from, ctx.sender)) throw refuse(`step ${String(step.id)} is sent from ${from}, not the sender ${ctx.sender}`);
      const value = BigInt(typeof d.value === "string" || typeof d.value === "number" ? d.value : 0);

      if (sameAddress(to, depository)) {
        let fn: string;
        let args: readonly unknown[];
        try {
          const parsed = DEPOSITORY.parseTransaction({ data });
          if (parsed === null) throw new Error("unknown selector");
          fn = parsed.name;
          args = parsed.args;
        } catch {
          throw refuse(`the depository call of step ${String(step.id)} is neither depositNative nor depositErc20`);
        }
        if (String(args[args.length - 1]).toLowerCase() !== ctx.orderId.toLowerCase()) throw refuse("the deposit does not commit to the verified order id");
        if (!sameAddress(String(args[0]), ctx.sender)) throw refuse(`the deposit credits depositor ${String(args[0])}, not the sender ${ctx.sender}`);
        if (native !== (fn === "depositNative")) throw refuse(`the deposit function ${fn} does not match the input asset`);
        if (native) {
          if (value !== ctx.amountInRaw) throw refuse(`the deposit sends ${value} wei, expected exactly ${ctx.amountInRaw}`);
        } else {
          if (!sameAddress(String(args[1]), ctx.asset.address)) throw refuse(`the deposit token ${String(args[1])} is not the input token ${ctx.asset.address}`);
          if (BigInt(args[2] as bigint) !== ctx.amountInRaw) throw refuse(`the deposit amount ${String(args[2])} is not the input amount ${ctx.amountInRaw}`);
          if (value !== 0n) throw refuse("the ERC-20 deposit carries native value");
        }
        txs.push({ kind: "deposit", to: depository, data, value, chainId: ctx.origin.chainId });
        continue;
      }

      if (!native && sameAddress(to, ctx.asset.address)) {
        let spender: string;
        let amount: bigint;
        try {
          const parsed = ERC20.parseTransaction({ data });
          if (parsed === null || parsed.name !== "approve") throw new Error("not approve");
          spender = String(parsed.args[0]);
          amount = BigInt(parsed.args[1] as bigint);
        } catch {
          throw refuse(`step ${String(step.id)} calls the input token with something other than approve(spender, amount)`);
        }
        if (!sameAddress(spender, depository)) throw refuse(`the approval spender ${spender} is not the Relay depository ${depository}`);
        if (amount !== ctx.amountInRaw) throw refuse(`the approval amount ${amount} is not the exact input amount ${ctx.amountInRaw}`);
        if (value !== 0n) throw refuse("the approval carries native value");
        txs.push({ kind: "approve", to: ctx.asset.address, data, value: 0n, chainId: ctx.origin.chainId });
        continue;
      }

      throw refuse(`step ${String(step.id)} sends a transaction to ${to}, which is neither the Relay depository ${depository} nor the input token`);
    }
  }
  const deposits = txs.filter(t => t.kind === "deposit").length;
  const approves = txs.filter(t => t.kind === "approve").length;
  if (deposits !== 1 || approves > 1 || txs[txs.length - 1].kind !== "deposit") {
    throw refuse(`expected [approve,] deposit — got ${txs.map(t => t.kind).join(", ") || "nothing"}`);
  }
  return txs;
}

/** Verify a raw POST /quote response against the request; returns the typed, checked quote. */
export function verifyRelayQuote(raw: unknown, req: RelaySwapRequest, nowSec: number): RelaySwapQuote {
  const origin = relayChain(req.from);
  const dest = relayChain(req.to);
  const inAsset = relayAsset(req.from, req.fromAsset);
  const outAsset = relayAsset(req.to, req.toAsset);
  const amountInRaw = parseUnits(req.amount, inAsset.decimals);

  const q = rec(raw);
  const v2 = rec(rec(q?.protocol)?.v2);
  const orderId = str(v2?.orderId);
  const order = rec(v2?.orderData) as unknown as RelayOrderData | null;
  const requestId = str(rec(Array.isArray(q?.steps) ? q.steps[q.steps.length - 1] : null)?.requestId) ?? str(q?.requestId);
  if (q === null || v2 === null || orderId === null || order === null) throw refuse("the response carries no protocol.v2 order to verify");
  if (requestId === null) throw refuse("the response carries no requestId");

  // 1. Order properties.
  if (!Array.isArray(order.inputs) || order.inputs.length !== 1 || !Array.isArray(order.output?.payments) || order.output.payments.length !== 1) {
    throw refuse("the order does not have exactly one input and one output payment");
  }
  const pay = order.inputs[0].payment;
  const out = order.output.payments[0];
  if (pay.chainId !== origin.protocolChainId) throw refuse(`the order is paid on "${pay.chainId}", not ${origin.protocolChainId}`);
  if (!sameOnChain(origin.vm, pay.currency, inAsset.address)) throw refuse(`the order input currency ${pay.currency} is not ${req.fromAsset} (${inAsset.address})`);
  if (BigInt(pay.amount) !== amountInRaw) throw refuse(`the order input amount ${pay.amount} is not the requested ${amountInRaw}`);
  if (order.output.chainId !== dest.protocolChainId) throw refuse(`the order pays out on "${order.output.chainId}", not ${dest.protocolChainId}`);
  if (!sameOnChain(dest.vm, out.currency, outAsset.address)) throw refuse(`the order output currency ${out.currency} is not ${req.toAsset} (${outAsset.address})`);
  if (!sameOnChain(dest.vm, out.recipient, req.recipient)) throw refuse(`the order pays ${out.recipient}, not the recipient ${req.recipient}`);
  if (!Array.isArray(order.output.calls) || order.output.calls.length !== 0) throw refuse("the order carries extra destination calls");
  // Refund options. Relay docs (api_core_concepts/refunds): "Refunds are paid on the origin chain
  // to the `refundTo` address supplied on the quote" / "Relay will always attempt to refund the user
  // in the original currency they sent". Real /quote orders (fixtures captured 2026-10-05) list two
  // entries: the origin chain in the origin currency to the sender, and the destination chain in
  // the output currency to the recipient. Exactly those two shapes are accepted — any other
  // chain, currency or recipient is refused.
  const refunds: unknown = order.inputs[0].refunds;
  if (!Array.isArray(refunds)) throw refuse("the order input carries no refunds list");
  for (const r of refunds as RelayOrderData["inputs"][number]["refunds"]) {
    if (r === null || typeof r !== "object" || typeof r.chainId !== "string" || typeof r.recipient !== "string" || typeof r.currency !== "string") {
      throw refuse(`the order carries a malformed refund entry ${JSON.stringify(r)}`);
    }
    const onOrigin = r.chainId === origin.protocolChainId && sameOnChain(origin.vm, r.currency, inAsset.address) && sameOnChain(origin.vm, r.recipient, req.sender);
    const onDestination = r.chainId === dest.protocolChainId && sameOnChain(dest.vm, r.currency, outAsset.address) && sameOnChain(dest.vm, r.recipient, req.recipient);
    if (!onOrigin && !onDestination) {
      throw refuse(`the order refunds ${r.currency} to ${r.recipient} on "${r.chainId}" — neither ${req.fromAsset} to the sender on ${origin.protocolChainId} nor ${req.toAsset} to the recipient on ${dest.protocolChainId}`);
    }
  }
  if (!(order.output.deadline > nowSec)) throw refuse(`the order expired (deadline ${order.output.deadline})`);
  const minimumOutRaw = BigInt(out.minimumAmount);
  const expectedOutRaw = BigInt(out.expectedAmount);
  if (minimumOutRaw <= 0n || expectedOutRaw < minimumOutRaw) throw refuse(`the order amounts are inconsistent (minimum ${out.minimumAmount}, expected ${out.expectedAmount})`);

  // 2. Order id.
  const computed = relayOrderId(order);
  if (computed.toLowerCase() !== orderId.toLowerCase()) throw refuse(`the order id ${orderId} does not match the order data (computed ${computed})`);

  // 3. Display data must agree with the pinned table (decimals drive every printed amount).
  const details = rec(q.details);
  const cIn = rec(details?.currencyIn);
  const cOut = rec(details?.currencyOut);
  const checkCurrency = (c: Record<string, unknown> | null, chain: RelayChainDef, asset: RelayAsset, what: string): void => {
    const cur = rec(c?.currency);
    if (cur === null || cur.chainId !== chain.chainId || typeof cur.address !== "string" || !sameOnChain(chain.vm, cur.address, asset.address) || cur.decimals !== asset.decimals) {
      throw refuse(`details.${what} (${JSON.stringify(cur?.symbol)}, ${JSON.stringify(cur?.address)}, decimals ${JSON.stringify(cur?.decimals)}) does not match the pinned ${chain.label} asset ${asset.address} / ${asset.decimals} decimals`);
    }
  };
  checkCurrency(cIn, origin, inAsset, "currencyIn");
  checkCurrency(cOut, dest, outAsset, "currencyOut");
  const fees = rec(q.fees);
  const usd = (name: string): string | null => str(rec(fees?.[name])?.amountUsd);
  const relayerUsd = usd("relayer");
  if (relayerUsd === null || !Number.isFinite(Number(relayerUsd))) throw refuse("the quote has no fees.relayer.amountUsd");

  // 4. Transactions (EVM origins only; a Solana-origin quote can be shown but not executed here).
  let txs: RelayTx[] = [];
  if (origin.vm === "evm") {
    if (origin.depository === null) throw new Error(`relay: ${origin.label} has no pinned depository`);
    const named = str(rec(v2.paymentDetails)?.depository);
    if (named === null || !sameAddress(named, origin.depository)) throw refuse(`the quote names depository ${String(named)}, not the pinned ${origin.depository}`);
    txs = verifyRelaySteps(q.steps, { origin, asset: inAsset, amountInRaw, sender: req.sender, orderId });
  }

  const time = details?.timeEstimate;
  return {
    provider: "relay", requestId, orderId,
    from: req.from.toLowerCase(), to: req.to.toLowerCase(), fromAsset: req.fromAsset.toUpperCase(), toAsset: req.toAsset.toUpperCase(),
    sender: req.sender, recipient: req.recipient,
    amountIn: req.amount, amountInRaw: amountInRaw.toString(),
    expectedOut: formatUnits(expectedOutRaw, outAsset.decimals), expectedOutRaw: expectedOutRaw.toString(),
    minimumOut: formatUnits(minimumOutRaw, outAsset.decimals), minimumOutRaw: minimumOutRaw.toString(),
    amountInUsd: str(cIn?.amountUsd), expectedOutUsd: str(cOut?.amountUsd),
    fees: { originGasUsd: usd("gas"), relayerUsd, relayerGasUsd: usd("relayerGas"), relayerServiceUsd: usd("relayerService"), appUsd: usd("app") },
    totalImpactPercent: str(rec(details?.totalImpact)?.percent),
    timeEstimateSec: typeof time === "number" && Number.isFinite(time) ? time : null,
    deadline: order.output.deadline,
    txs,
  };
}

/** POST /quote (a read) + local verification. */
export async function quoteRelaySwap(req: RelaySwapRequest): Promise<RelaySwapQuote> {
  const origin = relayChain(req.from);
  const dest = relayChain(req.to);
  const inAsset = relayAsset(req.from, req.fromAsset);
  const outAsset = relayAsset(req.to, req.toAsset);
  if (origin.chainId === dest.chainId) throw noRoute("Relay: source and destination chain are the same", "Pick two different chains");
  if (!/^\d+(\.\d+)?$/.test(req.amount) || !(Number(req.amount) > 0)) throw new PerpError("INVALID_PARAMS", `Bridge amount must be a positive decimal (got "${req.amount}")`);
  let amountInRaw: bigint;
  try {
    amountInRaw = parseUnits(req.amount, inAsset.decimals);
  } catch {
    throw new PerpError("INVALID_PARAMS", `Bridge amount ${req.amount} has more than ${inAsset.decimals} decimals (${req.fromAsset} on ${origin.label})`);
  }
  if (!validAddress(origin.vm, req.sender)) throw new PerpError("INVALID_PARAMS", `Sender ${JSON.stringify(req.sender)} is not a ${origin.label} address`);
  if (!validAddress(dest.vm, req.recipient)) throw new PerpError("INVALID_PARAMS", `Recipient ${JSON.stringify(req.recipient)} is not a ${dest.label} address`);

  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: req.sender, recipient: req.recipient,
      originChainId: origin.chainId, destinationChainId: dest.chainId,
      originCurrency: inAsset.address, destinationCurrency: outAsset.address,
      amount: amountInRaw.toString(), tradeType: "EXACT_INPUT", includeProtocolData: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new PerpError("NO_BRIDGE_ROUTE", `Relay quote failed (HTTP ${res.status}): ${text.slice(0, 300)}`, {
      exchange: "relay", remediation: "Check the amount (Relay refuses amounts below its fees) and the route; nothing was sent",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `Relay quote returned non-JSON: ${text.slice(0, 200)}`, { exchange: "relay" });
  }
  return verifyRelayQuote(raw, req, Math.floor(Date.now() / 1000));
}

// ── Minimum output ──

export interface RelayMinOutVerdict {
  ok: boolean;
  /** "explicit" = --min-out against the protocol-enforced minimum; "default" = the 3 % rule against the expected output. */
  rule: "explicit" | "default" | "required";
  floor: string | null;
  reason: string;
}

/**
 * Output protection:
 *   --min-out given → the order's protocol-enforced `minimumAmount` must be ≥ it (Relay docs:
 *     "Compare minimumAmount, not expectedAmount");
 *   no --min-out, same-value pair (stable → stable, or the same native asset) → the expected
 *     output must be ≥ amount in × (1 − 3 %);
 *   no --min-out, any other pair (stable → native, …) → refused: an explicit --min-out is required.
 */
export function relayMinOutVerdict(q: RelaySwapQuote, minOut: string | null): RelayMinOutVerdict {
  const inAsset = relayAsset(q.from, q.fromAsset);
  const outAsset = relayAsset(q.to, q.toAsset);
  if (minOut !== null) {
    if (!/^\d+(\.\d+)?$/.test(minOut) || !(Number(minOut) > 0)) throw new PerpError("INVALID_PARAMS", `--min-out must be a positive decimal in ${q.toAsset} (got "${minOut}")`);
    let floorRaw: bigint;
    try {
      floorRaw = parseUnits(minOut, outAsset.decimals);
    } catch {
      throw new PerpError("INVALID_PARAMS", `--min-out ${minOut} has more than ${outAsset.decimals} decimals (${q.toAsset})`);
    }
    const ok = BigInt(q.minimumOutRaw) >= floorRaw;
    return {
      ok, rule: "explicit", floor: minOut,
      reason: ok
        ? `guaranteed minimum ${q.minimumOut} ${q.toAsset} ≥ --min-out ${minOut}`
        : `the order guarantees only ${q.minimumOut} ${q.toAsset} (expected ${q.expectedOut}), below --min-out ${minOut}`,
    };
  }
  const sameValue = (inAsset.kind === "stable" && outAsset.kind === "stable") || (inAsset.kind === "native" && outAsset.kind === "native" && q.fromAsset === q.toAsset);
  if (!sameValue) {
    return {
      ok: false, rule: "required", floor: null,
      reason: `${q.fromAsset} → ${q.toAsset} has no fixed rate: pass --min-out <amount in ${q.toAsset}> (this quote: expected ${q.expectedOut}, guaranteed minimum ${q.minimumOut})`,
    };
  }
  // amount in, scaled to the output asset's decimals, × (1 − 3 %).
  const scaled = outAsset.decimals >= inAsset.decimals
    ? BigInt(q.amountInRaw) * 10n ** BigInt(outAsset.decimals - inAsset.decimals)
    : BigInt(q.amountInRaw) / 10n ** BigInt(inAsset.decimals - outAsset.decimals);
  const floorRaw = (scaled * (10_000n - RELAY_MAX_SLIPPAGE_BPS)) / 10_000n;
  const floor = formatUnits(floorRaw, outAsset.decimals);
  const minFloorRaw = (scaled * (10_000n - RELAY_MAX_GUARANTEED_LOSS_BPS)) / 10_000n;
  const minFloor = formatUnits(minFloorRaw, outAsset.decimals);
  const expectedOk = BigInt(q.expectedOutRaw) >= floorRaw;
  const guaranteedOk = BigInt(q.minimumOutRaw) >= minFloorRaw;
  const ok = expectedOk && guaranteedOk;
  return {
    ok, rule: "default", floor,
    reason: ok
      ? `expected ${q.expectedOut} ${q.toAsset} ≥ ${floor} (amount in − 3 %) and guaranteed minimum ${q.minimumOut} ≥ ${minFloor} (amount in − 6 %)`
      : !expectedOk
        ? `expected ${q.expectedOut} ${q.toAsset} is below ${floor} (amount in − 3 %) — fees are too large for this amount; pass --min-out to accept a lower output`
        : `guaranteed minimum ${q.minimumOut} ${q.toAsset} is below ${minFloor} (amount in − 6 %) — the order could settle far below the estimate; pass --min-out to accept a lower output`,
  };
}

/** Throws when the quote does not satisfy the output protection (nothing was sent). */
export function assertRelayMinOut(q: RelaySwapQuote, minOut: string | null): RelayMinOutVerdict {
  const v = relayMinOutVerdict(q, minOut);
  if (v.ok) return v;
  throw new PerpError(v.rule === "required" ? "INVALID_PARAMS" : "RISK_VIOLATION", `Relay bridge refused: ${v.reason}. Nothing was sent.`, {
    exchange: "relay", remediation: "Re-run with --dry-run to see the quote, then pass --min-out <amount> you accept (in the destination asset)",
  });
}

// ── Execute ──

export interface RelaySwapResult {
  provider: "relay";
  requestId: string;
  status: "success";
  approveTxHash: string | null;
  depositTxHash: string;
  /** Destination transaction hashes reported by Relay. */
  destinationTxHashes: string[];
  from: string; to: string; fromAsset: string; toAsset: string;
  amountIn: string; expectedOut: string; minimumOut: string;
  recipient: string;
}

export interface RelayPollTiming { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now: () => number }

const DEFAULT_TIMING: RelayPollTiming = {
  timeoutMs: RELAY_STATUS_TIMEOUT_MS, pollMs: RELAY_STATUS_POLL_MS,
  sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(),
};

/**
 * Poll GET /intents/status/v3 until the intent is terminal. success → destination tx hashes;
 * failure / refund → ACTION_REJECTED (definite: Relay did not fill; a refund returns the input);
 * anything else until the deadline → ORDER_PENDING with the request id and the deposit tx hash.
 */
export async function awaitRelayFill(requestId: string, depositTxHash: string, timing: RelayPollTiming): Promise<string[]> {
  const deadline = timing.now() + timing.timeoutMs;
  let last = "no status yet";
  for (;;) {
    try {
      const res = await fetch(`${RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(15_000) });
      const body = rec(JSON.parse(await res.text()));
      const status = str(body?.status);
      if (res.ok && status !== null) {
        if (status === "success") return Array.isArray(body?.txHashes) ? body.txHashes.map(String) : [];
        if (status === "refund") {
          throw new PerpError("ACTION_REJECTED", `Relay did not fill request ${requestId} (status refund${typeof body?.details === "string" ? `: ${body.details}` : ""}) — deposit ${depositTxHash} was refunded to the sender on the origin chain`, {
            exchange: "relay", requestId, txHash: depositTxHash, relayStatus: status,
            remediation: `Check the request on https://relay.link/transaction/${requestId} before bridging again`,
          });
        }
        if (status === "failure") {
          // The deposit is still held by the depository until the refund lands: not a known end state.
          throw new PerpError("ORDER_PENDING", `Relay did not fill request ${requestId} (status failure${typeof body?.details === "string" ? `: ${body.details}` : ""}) — deposit ${depositTxHash} is held by the Relay depository pending a refund`, {
            exchange: "relay", requestId, txHash: depositTxHash, relayStatus: status,
            remediation: `Do NOT bridge again until the refund is visible: https://relay.link/transaction/${requestId}`,
          });
        }
        last = `status ${status}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (e) {
      if (e instanceof PerpError) throw e;
      last = e instanceof Error ? e.message : String(e);
    }
    if (timing.now() + timing.pollMs > deadline) break;
    await timing.sleep(timing.pollMs);
  }
  throw new PerpError("ORDER_PENDING", `Relay request ${requestId}: the deposit ${depositTxHash} is confirmed on the origin chain but the fill is not confirmed after ${timing.timeoutMs / 1000}s (${last})`, {
    exchange: "relay", requestId, txHash: depositTxHash,
    remediation: `Do NOT bridge again — the request may still fill or refund. Track it: https://relay.link/transaction/${requestId} (GET ${RELAY_API}/intents/status/v3?requestId=${requestId})`,
  });
}

/**
 * Execute a verified quote: read-only origin checks (chain id, on-chain decimals, balance), the
 * approve (when the quote has one) and the deposit, then wait for the fill.
 */
export async function executeRelaySwap(network: Network, q: RelaySwapQuote, sign: TxSigner, timing: RelayPollTiming = DEFAULT_TIMING): Promise<RelaySwapResult> {
  if (network !== "mainnet") {
    throw noRoute(`Relay bridging has no ${network} route — the chains, depository and tokens are mainnet deployments`, "Run without -n testnet");
  }
  const origin = relayChain(q.from);
  const asset = relayAsset(q.from, q.fromAsset);
  if (origin.vm !== "evm" || origin.rpcUrl === null) {
    throw noRoute(`Relay: bridging FROM ${origin.label} is not implemented (only EVM-origin deposits are verified and signed)`, "Bridge from an EVM chain, or use --provider cctp / debridge for a Solana-origin USDC bridge");
  }
  if (q.txs.length === 0) throw new Error("relay: verified quote carries no transactions");
  if (!(q.deadline > Math.floor(timing.now() / 1000))) throw refuse(`the quote expired (deadline ${q.deadline}) — request a new one`);

  const rpc = evmProvider(origin.rpcUrl, origin.chainId);
  await assertRpcChainId(rpc, origin.rpcUrl, origin.chainId, "relay");
  const amountInRaw = BigInt(q.amountInRaw);
  if (asset.kind === "native") {
    const bal = await rpc.getBalance(q.sender);
    if (bal <= amountInRaw) {
      throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${q.sender} holds ${formatUnits(bal, asset.decimals)} ${q.fromAsset} on ${origin.label}; bridging ${q.amountIn} also needs gas`, { exchange: "relay" });
    }
  } else {
    const onChain = await erc20Decimals(rpc, asset.address);
    if (onChain !== asset.decimals) {
      throw new PerpError("EXCHANGE_ERROR", `relay: ${q.fromAsset} on ${origin.label} reports ${onChain} decimals on-chain, the pinned table says ${asset.decimals} — nothing was sent`, { exchange: "relay" });
    }
    const [bal, gas] = await Promise.all([erc20Balance(rpc, asset.address, q.sender), rpc.getBalance(q.sender)]);
    if (bal < amountInRaw) {
      throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${q.sender} holds ${formatUnits(bal, asset.decimals)} ${q.fromAsset} on ${origin.label}; the bridge needs ${q.amountIn}`, { exchange: "relay" });
    }
    if (gas === 0n) {
      throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${q.sender} has no native gas token on ${origin.label}`, {
        exchange: "relay", remediation: `Fund ${q.sender} with gas on ${origin.label} first (e.g. bridge native gas TO ${q.from} from a chain that has it)`,
      });
    }
  }

  let approveTxHash: string | null = null;
  let depositTxHash = "";
  for (const tx of q.txs) {
    if (tx.chainId !== origin.chainId) throw new Error(`relay: verified tx chainId ${tx.chainId} != origin ${origin.chainId}`);
    const { txHash } = await sendMasterTx(rpc, {
      venue: "relay", chainLabel: origin.label, chainId: origin.chainId, from: q.sender, to: tx.to, data: tx.data, value: tx.value,
      label: tx.kind === "approve" ? `${q.fromAsset} approve (Relay depository)` : `Relay deposit (${q.amountIn} ${q.fromAsset})`,
    }, sign);
    if (tx.kind === "approve") approveTxHash = txHash;
    else depositTxHash = txHash;
  }
  const destinationTxHashes = await awaitRelayFill(q.requestId, depositTxHash, timing);
  return {
    provider: "relay", requestId: q.requestId, status: "success", approveTxHash, depositTxHash, destinationTxHashes,
    from: q.from, to: q.to, fromAsset: q.fromAsset, toAsset: q.toAsset,
    amountIn: q.amountIn, expectedOut: q.expectedOut, minimumOut: q.minimumOut, recipient: q.recipient,
  };
}
