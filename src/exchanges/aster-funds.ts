/**
 * Aster on-chain deposit + API withdraw helpers (mainnet only).
 *
 * Deposit (github.com/asterdex/api-docs demo/aster-deposit-withdrawal.md): "Call the `depositFor`
 * method of the vault contract … the deposited asset is credited to the `forAddress` account";
 * broker: "pass `1000` to deposit to the spot account; any other value deposits to the futures account".
 *
 *   ERC-20 approve(vault, exact amount) → vault.depositFor(address currency, address forAddress, uint256 amount, uint256 broker)
 *
 * with forAddress = the depositor itself and broker = 1 (futures account). NEVER a plain token transfer. Vault / token / chain id are
 * PINNED in the venue definition (venues/aster.ts ASTER_FUNDS_CHAINS). Before anything is signed,
 * read-only checks on the pinned RPC: eth_chainId, on-chain decimals(), supportToken(token)
 * non-zero, paused() false, token balance ≥ amount, native gas > 0, allowance. The deposit tx is
 * simulated from the depositor (eth_estimateGas) after the approve; its receipt must carry
 * Deposit(account = depositor, currency = token, broker = 1); the venue credit is then polled
 * (POST /fapi/v3/aster/deposit-withdraw-history) — a timeout is ORDER_PENDING with the tx hash,
 * never "failed".
 *
 * Withdraw: POST /fapi/v3/aster/user-withdraw — see AsterAdapter.withdraw; this module holds the
 * pure checks (fee / max from user-withdraw-info, signature recovery).
 */

import { Interface, formatUnits, parseUnits, verifyTypedData, zeroPadValue } from "ethers";
import { venueRateString } from "../utils/numeric.js";
import { PerpError } from "../errors.js";
import {
  ERC20, EVM_ADDRESS_RE, assertRpcChainId, erc20Allowance, erc20Balance, erc20Decimals, evmProvider,
  sameAddress, sendMasterTx, txOutcomeUnknown, type MasterTx, type TxSigner,
} from "../evm-master-tx.js";
import { buildWithdrawTypedData } from "./aster-typed-data.js";
import { unsupported } from "./trading-v2.js";
import type { Network } from "./venue-types.js";
import {
  ASTER_DEPOSIT_BROKER_PERP, ASTER_FUNDS_CHAINS, ASTER_FUNDS_TESTNET_UNSUPPORTED,
  type AsterFundsAsset, type AsterFundsChain,
} from "./venues/aster.js";

export const ASTER_VAULT = new Interface([
  "function depositFor(address currency, address forAddress, uint256 amount, uint256 broker) payable",
  "function paused() view returns (bool)",
  "function supportToken(address) view returns (address currency)",
  "event Deposit(address indexed account, address indexed currency, bool isNative, uint256 amount, uint256 broker)",
]);
const DEPOSIT_TOPIC = ASTER_VAULT.getEvent("Deposit")!.topicHash;

/** Venue credit polling (deposit-withdraw-history). */
export const ASTER_DEPOSIT_CREDIT_TIMEOUT_MS = 180_000;
export const ASTER_DEPOSIT_CREDIT_POLL_MS = 5_000;

/** Deposit / withdraw exist on mainnet only; testnet → uniform CAPABILITY_UNSUPPORTED. */
export function requireAsterFundsNetwork(net: Network, feature: "deposit" | "withdraw"): void {
  if (net === "testnet") {
    throw unsupported("Aster", feature, ASTER_FUNDS_TESTNET_UNSUPPORTED.reason, ASTER_FUNDS_TESTNET_UNSUPPORTED.remediation);
  }
}

export function asterFundsChain(raw: string): AsterFundsChain {
  const c = raw.toLowerCase();
  if (c === "bsc" || c === "arbitrum") return c;
  throw new PerpError("INVALID_PARAMS", `Unsupported Aster chain "${raw}"`, { remediation: "Use --chain bsc or --chain arbitrum" });
}

export function asterFundsAsset(raw: string): AsterFundsAsset {
  const a = raw.toUpperCase();
  if (a === "USDT" || a === "USDC") return a;
  throw new PerpError("INVALID_PARAMS", `Unsupported Aster deposit asset "${raw}"`, { remediation: "Use --asset USDT or --asset USDC" });
}

function requireDecimal(amount: string, what: string): void {
  if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) {
    throw new PerpError("INVALID_PARAMS", `${what} must be a positive decimal (got "${amount}")`);
  }
}

// ── Deposit ──

export interface AsterDepositPlan {
  network: Network;
  chain: AsterFundsChain;
  chainId: number;
  chainLabel: string;
  rpcUrl: string;
  vault: string;
  asset: AsterFundsAsset;
  token: string;
  /** Read on-chain (decimals()). */
  decimals: number;
  amount: string;
  amountRaw: bigint;
  depositor: string;
  tokenBalance: bigint;
  allowance: bigint;
  needsApprove: boolean;
  broker: bigint;
}

export interface AsterDepositResult {
  approveTxHash: string | null;
  depositTxHash: string;
  /** Amount of the vault's Deposit event (token base units). */
  depositedRaw: string;
}

/** Read-only pre-checks on the pinned chain. Throws before anything is signed. */
export async function planAsterDeposit(p: {
  network: Network; chain: AsterFundsChain; asset: AsterFundsAsset; amount: string; depositor: string;
}): Promise<AsterDepositPlan> {
  requireAsterFundsNetwork(p.network, "deposit");
  if (!EVM_ADDRESS_RE.test(p.depositor)) {
    throw new PerpError("NO_SIGNER_AVAILABLE", "Aster deposit needs the master wallet address", {
      remediation: "Run with the master wallet: perp --ows <wallet> funds deposit aster <amount>",
    });
  }
  requireDecimal(p.amount, "Deposit amount");
  const pins = ASTER_FUNDS_CHAINS[p.chain];
  const token = pins.tokens[p.asset];
  const rpc = evmProvider(pins.rpcUrl, pins.chainId);
  await assertRpcChainId(rpc, pins.rpcUrl, pins.chainId, "aster");

  const decimals = await erc20Decimals(rpc, token);
  let amountRaw: bigint;
  try {
    amountRaw = parseUnits(p.amount, decimals);
  } catch {
    throw new PerpError("INVALID_PARAMS", `Deposit amount ${p.amount} has more than ${decimals} decimals (${p.asset} on ${pins.label})`);
  }

  const [supportRaw, pausedRaw] = await Promise.all([
    rpc.call({ to: pins.vault, data: ASTER_VAULT.encodeFunctionData("supportToken", [token]) }),
    rpc.call({ to: pins.vault, data: ASTER_VAULT.encodeFunctionData("paused", []) }),
  ]);
  // supportToken(address) returns the Token struct; its first word (currency) is zero for an unsupported token.
  if (supportRaw.length < 66 || BigInt(supportRaw.slice(0, 66)) === 0n) {
    throw new PerpError("EXCHANGE_ERROR", `aster: vault ${pins.vault} on ${pins.label} does not list ${p.asset} (${token}) as a supported deposit token — nothing was sent`, { exchange: "aster" });
  }
  if (ASTER_VAULT.decodeFunctionResult("paused", pausedRaw)[0] === true) {
    throw new PerpError("EXCHANGE_ERROR", `aster: vault ${pins.vault} on ${pins.label} is paused — nothing was sent`, {
      exchange: "aster", remediation: "Wait until Aster resumes the vault (status: asterdex.com), then retry",
    });
  }

  const [tokenBalance, allowance, gas] = await Promise.all([
    erc20Balance(rpc, token, p.depositor),
    erc20Allowance(rpc, token, p.depositor, pins.vault),
    rpc.getBalance(p.depositor),
  ]);
  if (tokenBalance < amountRaw) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${p.depositor} holds ${formatUnits(tokenBalance, decimals)} ${p.asset} on ${pins.label}; the deposit needs ${p.amount}`, {
      exchange: "aster", remediation: `Fund ${p.depositor} with ${p.asset} on ${pins.label} (chainId ${pins.chainId}) first — e.g. perp funds bridge send --to ${p.chain} --to-asset ${p.asset}`,
    });
  }
  if (gas === 0n) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${p.depositor} has no native gas token on ${pins.label}`, {
      exchange: "aster", remediation: `Fund ${p.depositor} with ${p.chain === "bsc" ? "BNB" : "ETH"} on ${pins.label} (chainId ${pins.chainId}) for gas`,
    });
  }
  return {
    network: p.network, chain: p.chain, chainId: pins.chainId, chainLabel: pins.label, rpcUrl: pins.rpcUrl,
    vault: pins.vault, asset: p.asset, token, decimals, amount: p.amount, amountRaw, depositor: p.depositor,
    tokenBalance, allowance, needsApprove: allowance < amountRaw, broker: ASTER_DEPOSIT_BROKER_PERP,
  };
}

export function asterDepositCalldata(plan: Pick<AsterDepositPlan, "token" | "depositor" | "amountRaw" | "broker">): string {
  return ASTER_VAULT.encodeFunctionData("depositFor", [plan.token, plan.depositor, plan.amountRaw, plan.broker]);
}

interface ReceiptLog { address: string; topics: readonly string[]; data: string }

/**
 * The vault's Deposit event for this deposit: account = depositor, currency = token, broker = 1.
 * Returns the event amount; null when the receipt carries no such event.
 */
export function findAsterDepositEvent(logs: readonly ReceiptLog[], plan: Pick<AsterDepositPlan, "vault" | "depositor" | "token" | "broker">): bigint | null {
  const account = zeroPadValue(plan.depositor, 32).toLowerCase();
  const currency = zeroPadValue(plan.token, 32).toLowerCase();
  for (const log of logs) {
    if (!sameAddress(log.address, plan.vault) || log.topics.length !== 3) continue;
    if (log.topics[0] !== DEPOSIT_TOPIC || log.topics[1].toLowerCase() !== account || log.topics[2].toLowerCase() !== currency) continue;
    const [isNative, amount, broker] = ASTER_VAULT.decodeEventLog("Deposit", log.data, [...log.topics]).slice(2) as unknown as [boolean, bigint, bigint];
    if (isNative || broker !== plan.broker) continue;
    return amount;
  }
  return null;
}

/** Sends approve (only when the allowance is short — exact amount) then deposit; verifies the Deposit event. */
export async function executeAsterDeposit(plan: AsterDepositPlan, sign: TxSigner): Promise<AsterDepositResult> {
  const rpc = evmProvider(plan.rpcUrl, plan.chainId);
  const base = { venue: "aster", chainLabel: plan.chainLabel, chainId: plan.chainId, from: plan.depositor, value: 0n };
  let approveTxHash: string | null = null;
  if (plan.needsApprove) {
    approveTxHash = (await sendMasterTx(rpc, {
      ...base, to: plan.token, data: ERC20.encodeFunctionData("approve", [plan.vault, plan.amountRaw]), label: `${plan.asset} approve`,
    }, sign)).txHash;
  }
  const depositTx: MasterTx = { ...base, to: plan.vault, data: asterDepositCalldata(plan), label: "Aster vault deposit" };
  const { txHash, receipt } = await sendMasterTx(rpc, depositTx, sign);
  const deposited = findAsterDepositEvent(receipt.logs, plan);
  if (deposited === null) {
    throw txOutcomeUnknown(depositTx, txHash, `it was mined, but its receipt has no Deposit(account ${plan.depositor}, currency ${plan.token}, broker ${plan.broker}) event from vault ${plan.vault}`);
  }
  return { approveTxHash, depositTxHash: txHash, depositedRaw: deposited.toString() };
}

export interface AsterHistoryRow { type: string; state: string; txHash: string; asset: string; amount: string; accountType: string | null }

/** Rows of POST /fapi/v3/aster/deposit-withdraw-history (an array; anything else is a venue error). */
export function parseAsterHistory(raw: unknown): AsterHistoryRow[] {
  if (!Array.isArray(raw)) {
    throw new PerpError("EXCHANGE_ERROR", `aster: unrecognized deposit-withdraw-history response ${JSON.stringify(raw).slice(0, 160)}`, { exchange: "aster" });
  }
  return raw.map((r): AsterHistoryRow => {
    const row = (r !== null && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return {
      type: String(row.type), state: String(row.state), txHash: String(row.txHash), asset: String(row.asset), amount: String(row.amount),
      accountType: typeof row.accountType === "string" ? row.accountType : null,
    };
  });
}

/**
 * Poll the venue's deposit history until this tx is SUCCESS. FAILED → EXCHANGE_ERROR (definite,
 * venue-reported). Not listed / PROCESSING / unreadable until the deadline → ORDER_PENDING with
 * the tx hash (the on-chain deposit is confirmed; only the venue credit is unknown).
 * The history endpoint itself answers -5050 DEPOSIT_REQUIRED until the first deposit is credited —
 * that is "not credited yet", so polling continues.
 */
export async function awaitAsterDepositCredit(
  readHistory: () => Promise<unknown>,
  txHash: string,
  timing: { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<AsterHistoryRow> {
  const deadline = timing.now() + timing.timeoutMs;
  let last = "not listed yet";
  for (;;) {
    try {
      const row = parseAsterHistory(await readHistory()).find(r => r.type === "DEPOSIT" && r.txHash.toLowerCase() === txHash.toLowerCase());
      if (row !== undefined) {
        if (row.state === "SUCCESS") return row;
        if (row.state === "FAILED") {
          throw new PerpError("EXCHANGE_ERROR", `aster: the venue reports deposit ${txHash} as FAILED — the tokens are in the vault but were not credited`, {
            exchange: "aster", txHash, remediation: "Contact Aster support with the transaction hash; do NOT deposit again until it is resolved",
          });
        }
        last = `state ${row.state}`;
      }
    } catch (e) {
      if (e instanceof PerpError && e.structured.code === "EXCHANGE_ERROR" && e.structured.details?.txHash === txHash) throw e;
      last = e instanceof Error ? e.message : String(e);
    }
    if (timing.now() + timing.pollMs > deadline) break;
    await timing.sleep(timing.pollMs);
  }
  throw new PerpError("ORDER_PENDING", `aster: deposit ${txHash} is confirmed on-chain but not yet shown as credited by the venue after ${timing.timeoutMs / 1000}s (${last})`, {
    exchange: "aster", txHash,
    remediation: `Do NOT deposit again — the vault holds the funds and the credit usually follows. Check: perp -e aster account balance (or the Aster app → Assets → History)`,
  });
}

// ── Withdraw ──

export interface AsterWithdrawLimits {
  /** balances.<asset>.chainBalances.<chainId>.perpMaxWithdrawAmount */
  max: string;
  /** balances.<asset>.chainBalances.<chainId>.withdrawFee */
  fee: string;
}

/** Fee + max of POST /fapi/v3/aster/user-withdraw-info for (asset, chain). Missing → refusal, never a default. */
export function parseAsterWithdrawLimits(raw: unknown, asset: string, chainId: number): AsterWithdrawLimits {
  const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const chain = rec(rec(rec(rec(rec(raw)?.balances)?.[asset])?.chainBalances)?.[String(chainId)]);
  if (chain === null) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Aster reports no withdrawable ${asset} balance on chain ${chainId}`, {
      exchange: "aster", remediation: "Check the perp balance (perp -e aster account balance) and that the asset can be withdrawn on that chain",
    });
  }
  // The venue sends these as JSON numbers (live 2026-10-13: `"perpMaxWithdrawAmount":8.7451191,
  // "withdrawFee":0.51`) or numeric strings; either becomes a plain decimal string.
  const decimal = (v: unknown): string | null => {
    const str = typeof v === "number" && Number.isFinite(v) && v >= 0 ? venueRateString(v, `aster ${asset} withdraw limit`) : typeof v === "string" ? v : null;
    return str !== null && /^\d+(\.\d+)?$/.test(str) ? str : null;
  };
  const max = decimal(chain.perpMaxWithdrawAmount);
  const fee = decimal(chain.withdrawFee);
  if (max === null || fee === null) {
    throw new PerpError("EXCHANGE_ERROR", `aster: user-withdraw-info has no readable perpMaxWithdrawAmount / withdrawFee for ${asset} on chain ${chainId}`, { exchange: "aster" });
  }
  return { max, fee };
}

/** amount > fee and amount ≤ max (exact decimal comparison). */
export function assertAsterWithdrawAmount(amount: string, limits: AsterWithdrawLimits, asset: string): void {
  requireDecimal(amount, "Withdraw amount");
  const u = (x: string): bigint => parseUnits(x, 18);
  if (u(amount) <= u(limits.fee)) {
    throw new PerpError("SIZE_TOO_SMALL", `Aster withdraw amount ${amount} ${asset} does not exceed the withdrawal fee ${limits.fee} ${asset}`, { exchange: "aster" });
  }
  if (u(amount) > u(limits.max)) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Aster withdraw amount ${amount} ${asset} exceeds the withdrawable perp balance ${limits.max} ${asset} on that chain`, { exchange: "aster" });
  }
}

/** The withdraw `userSignature` must recover to the account owner before the request is sent. */
export function assertAsterWithdrawSignature(typed: ReturnType<typeof buildWithdrawTypedData>, signature: string, user: string): void {
  let recovered: string;
  try {
    recovered = verifyTypedData(typed.domain, typed.types as unknown as Record<string, Array<{ name: string; type: string }>>, typed.message, signature);
  } catch (e) {
    throw new PerpError("SIGNATURE_FAILED", `Aster withdraw signature is unreadable (${e instanceof Error ? e.message : String(e)}) — nothing was sent`, { exchange: "aster" });
  }
  if (!sameAddress(recovered, user)) {
    throw new PerpError("SIGNATURE_FAILED", `Aster withdraw signature recovers to ${recovered}, not the account owner ${user} — nothing was sent`, { exchange: "aster" });
  }
}

export interface AsterWithdrawResult {
  withdrawId: string;
  /** Digest of the user signature (venue response `hash`). */
  hash: string;
  chain: AsterFundsChain;
  chainId: number;
  asset: string;
  amount: string;
  fee: string;
  receiver: string;
}
