/**
 * On-chain EVM transactions sent by the master wallet (Aster vault deposit, Ondo funding
 * transfer, Relay bridge deposits).
 *
 * One path for all of them: simulate (eth_estimateGas from the sender) → gas balance check →
 * sign through a transaction signer (the digest is derived from the unsigned tx inside the
 * signer — no raw-digest API) → verify the recovered sender → broadcast → wait for the receipt.
 *
 * Unknown outcomes are never reported as failures: once the signed transaction left this
 * process, a lost broadcast response, an RPC error while waiting, or a receipt timeout is
 * ORDER_PENDING carrying the transaction hash ("do NOT resend").
 */

import { Interface, JsonRpcProvider, Network as EthersNetwork, Signature, Transaction, type TransactionReceipt } from "ethers";
import { PerpError, isConnectFailure } from "./errors.js";
import type { CliCredentialOpts } from "./config.js";
import type { VenueId } from "./exchanges/venue-types.js";
import type { OwsEvmSigner } from "./signer/ows-evm.js";

/** Signs an unsigned tx (hashing internally) and returns the 65-byte 0x signature. */
export type TxSigner = (tx: Transaction) => Promise<string>;

export const EVM_RECEIPT_TIMEOUT_MS = 180_000;
/** Gas-limit headroom over eth_estimateGas. */
const GAS_HEADROOM_PCT = 20n;

export const ERC20 = new Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function evmProvider(rpcUrl: string, chainId: number): JsonRpcProvider {
  const net = EthersNetwork.from(chainId);
  return new JsonRpcProvider(rpcUrl, net, { staticNetwork: net });
}

/** The RPC must serve the pinned chain — a wrong endpoint never receives a signed transaction. */
export async function assertRpcChainId(rpc: JsonRpcProvider, rpcUrl: string, chainId: number, venue: string): Promise<void> {
  const served = BigInt(await rpc.send("eth_chainId", []));
  if (served !== BigInt(chainId)) {
    throw new PerpError("EXCHANGE_ERROR", `${venue}: RPC ${rpcUrl} serves chainId ${served}, expected ${chainId} — nothing was sent`, { exchange: venue });
  }
}

/** On-chain decimals() — never assumed from a table. */
export async function erc20Decimals(rpc: JsonRpcProvider, token: string): Promise<number> {
  const raw = await rpc.call({ to: token, data: ERC20.encodeFunctionData("decimals", []) });
  return Number(ERC20.decodeFunctionResult("decimals", raw)[0] as bigint);
}

export async function erc20Balance(rpc: JsonRpcProvider, token: string, owner: string): Promise<bigint> {
  const raw = await rpc.call({ to: token, data: ERC20.encodeFunctionData("balanceOf", [owner]) });
  return ERC20.decodeFunctionResult("balanceOf", raw)[0] as bigint;
}

export async function erc20Allowance(rpc: JsonRpcProvider, token: string, owner: string, spender: string): Promise<bigint> {
  const raw = await rpc.call({ to: token, data: ERC20.encodeFunctionData("allowance", [owner, spender]) });
  return ERC20.decodeFunctionResult("allowance", raw)[0] as bigint;
}

export interface MasterTx {
  /** Venue / provider name for error attribution ("aster", "ondo", "relay"). */
  venue: string;
  /** Human chain name for messages ("BNB Chain"). */
  chainLabel: string;
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: bigint;
  /** What this transaction is, for messages ("USDT approve"). */
  label: string;
}

/** A sent transaction whose result could not be read: unknown outcome carrying the hash. */
export function txOutcomeUnknown(t: MasterTx, txHash: string, why: string): PerpError {
  return new PerpError("ORDER_PENDING", `${t.venue} ${t.label}: transaction ${txHash} was sent on ${t.chainLabel} but its result is unknown — ${why}`, {
    exchange: t.venue, txHash, chainId: t.chainId,
    remediation: `Do NOT resend — the transaction may still confirm. Check ${txHash} on a ${t.chainLabel} explorer, then the balances, before doing anything else`,
  });
}

/**
 * Simulate, sign, broadcast one master-wallet transaction and return its hash + successful receipt.
 * Throws before signing when the simulation reverts or gas is short (nothing sent); a reverted
 * receipt is ACTION_REJECTED (definite); anything unreadable after the broadcast is ORDER_PENDING.
 */
export async function sendMasterTx(rpc: JsonRpcProvider, t: MasterTx, sign: TxSigner): Promise<{ txHash: string; receipt: TransactionReceipt }> {
  let estimate: bigint;
  try {
    estimate = await rpc.estimateGas({ from: t.from, to: t.to, data: t.data, value: t.value });
  } catch (e) {
    throw new PerpError("ACTION_REJECTED", `${t.venue} ${t.label}: simulation on ${t.chainLabel} failed (${e instanceof Error ? e.message : String(e)}) — nothing was sent`, {
      exchange: t.venue, chainId: t.chainId,
    });
  }
  const gasLimit = estimate + (estimate * GAS_HEADROOM_PCT) / 100n;
  const fee = await rpc.getFeeData();
  // EIP-1559 chains price with maxFee / priority; a chain whose blocks carry no base fee (BNB Chain
  // reports baseFeePerGas 0, so ethers returns maxFeePerGas null) is priced with a legacy gasPrice.
  const eip1559 = fee.maxFeePerGas !== null && fee.maxPriorityFeePerGas !== null;
  if (!eip1559 && fee.gasPrice === null) {
    throw new PerpError("EXCHANGE_ERROR", `${t.venue}: the ${t.chainLabel} RPC returned no fee data — nothing was sent`, { exchange: t.venue });
  }
  const pricePerGas = eip1559 ? fee.maxFeePerGas! : fee.gasPrice!;
  const need = gasLimit * pricePerGas + t.value;
  const native = await rpc.getBalance(t.from);
  if (native < need) {
    throw new PerpError("INSUFFICIENT_BALANCE", `${t.label} needs up to ${need} wei of ${t.chainLabel} native token (gas${t.value > 0n ? " + value" : ""}); wallet ${t.from} has ${native}`, {
      exchange: t.venue, remediation: `Fund ${t.from} with native gas token on ${t.chainLabel} (chainId ${t.chainId}), then retry`,
    });
  }
  const nonce = await rpc.getTransactionCount(t.from, "pending");
  const common = { chainId: BigInt(t.chainId), nonce, to: t.to, data: t.data, value: t.value, gasLimit };
  const tx = eip1559
    ? Transaction.from({ ...common, type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas })
    : Transaction.from({ ...common, type: 0, gasPrice: fee.gasPrice });
  tx.signature = Signature.from(await sign(tx));
  if (tx.from === null || !sameAddress(tx.from, t.from)) {
    throw new PerpError("SIGNATURE_FAILED", `${t.label} tx recovered signer ${tx.from}, expected ${t.from} — nothing was sent`, { exchange: t.venue });
  }
  const txHash = tx.hash;
  if (txHash === null) throw new Error(`${t.label}: signed transaction has no hash`);

  try {
    // The raw RPC call only: ethers' broadcastTransaction also reads the block number and
    // re-checks the hash, so it can throw after the node already accepted the transaction.
    await rpc.send("eth_sendRawTransaction", [tx.serialized]);
  } catch (e) {
    // No connection at all → definitely not sent. "insufficient funds" → the node refused it.
    // Anything else (timeout, reset, 5xx, "already known", "nonce too low" from a proxy that
    // retried) may mean the transaction IS in the mempool: wait for the hash below.
    if (isConnectFailure(e)) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `${t.venue} ${t.label}: could not connect to the ${t.chainLabel} RPC — nothing was sent`, { exchange: t.venue });
    }
    if ((e as { code?: unknown }).code === "INSUFFICIENT_FUNDS") {
      throw new PerpError("ACTION_REJECTED", `${t.venue} ${t.label}: the ${t.chainLabel} RPC refused the transaction (${e instanceof Error ? e.message : String(e)}) — nothing was sent`, {
        exchange: t.venue, chainId: t.chainId,
      });
    }
  }

  let receipt: TransactionReceipt | null;
  try {
    receipt = await rpc.waitForTransaction(txHash, 1, EVM_RECEIPT_TIMEOUT_MS);
  } catch (e) {
    throw txOutcomeUnknown(t, txHash, (e as { code?: unknown }).code === "TIMEOUT"
      ? `not mined within ${EVM_RECEIPT_TIMEOUT_MS / 1000}s`
      : `receipt read failed (${e instanceof Error ? e.message : String(e)})`);
  }
  if (receipt === null) throw txOutcomeUnknown(t, txHash, `not mined within ${EVM_RECEIPT_TIMEOUT_MS / 1000}s`);
  if (receipt.status !== 1) {
    throw new PerpError("ACTION_REJECTED", `${t.venue} ${t.label}: transaction ${txHash} reverted on ${t.chainLabel} — nothing was moved`, {
      exchange: t.venue, txHash, chainId: t.chainId,
    });
  }
  return { txHash, receipt };
}

/**
 * The OWS master wallet as a transaction signer. On-chain master transactions are signed only by
 * an OWS wallet (digest derived inside the signer); no master / a raw private key → NO_SIGNER_AVAILABLE.
 */
export async function loadMasterEvmSigner(venue: VenueId, opts: CliCredentialOpts, action: string): Promise<OwsEvmSigner> {
  const { resolveOwsMaster } = await import("./config.js");
  const master = await resolveOwsMaster(venue, opts);
  if (master === null) {
    throw new PerpError("NO_SIGNER_AVAILABLE", `${action} is an on-chain transaction signed by the OWS master wallet, which is not selected on this computer`, {
      exchange: venue,
      remediation: "Import the master wallet into the OWS vault (perp wallet import --name <name> --chain evm), then perp wallet use <name> or pass --ows <name>",
    });
  }
  const { OwsEvmSigner: Signer } = await import("./signer/ows-evm.js");
  return Signer.create(master.wallet, master.passphrase);
}
