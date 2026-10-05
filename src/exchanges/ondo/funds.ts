/**
 * Ondo Perps funding (mainnet only) + withdrawal address book.
 *
 * Deposit = a plain ERC-20 transfer of USDC to the account's own funding address
 * (docs.ondoperps.xyz/funding-ondo-perps, api-reference/integration_guide "Deposit USDC").
 *   - The address comes from POST /v1/wallet/deposit_address/list {coins:["USDC"]}: the FIRST
 *     listed row for (USDC, chosen network, wallet "margin"), whose depositDestination.id must be
 *     this account's id (GET /v1/account accountID) — anything else is refused.
 *   - POST /v1/provision_address creates ANOTHER address on every call, so it is called only when
 *     the list has no address for that network.
 *   - USDC token addresses / chain ids / RPCs are pinned in the venue definition
 *     (venues/ondo.ts ONDO_DEPOSIT_CHAINS); decimals are read on-chain.
 *   - With a probe amount the transfer is two-step: probe → wait until GET /v1/wallet/deposits
 *     shows it confirmed → remainder. A probe that is not credited within the window stops the
 *     flow (ORDER_PENDING with the probe tx hash); the remainder is NOT sent.
 *
 * Address book: withdrawals go only to addresses on the account's address book. An address is
 * added by signing a SIWE challenge with the account's wallet
 * (POST /v1/auth/erc-4361/address_book/get_challenge → personal_sign → …/complete_challenge).
 */

import { formatUnits, parseUnits, verifyMessage } from "ethers";
import { PerpError } from "../../errors.js";
import {
  ERC20, EVM_ADDRESS_RE, assertRpcChainId, erc20Balance, erc20Decimals, evmProvider, sameAddress, sendMasterTx, type TxSigner,
} from "../../evm-master-tx.js";
import { unsupported } from "../trading-v2.js";
import type { Network } from "../venue-types.js";
import { ONDO_DEPOSIT_CHAINS, type OndoDepositChain } from "../venues/ondo.js";

/** The slice of OndoClient these flows use (authenticated calls). */
export interface OndoFundsClient {
  get<T>(path: string, query: null): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  postNoResult(path: string, body: unknown): Promise<void>;
}

export const ONDO_DEPOSIT_CREDIT_TIMEOUT_MS = 600_000;
export const ONDO_DEPOSIT_CREDIT_POLL_MS = 10_000;

export interface PollTiming { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now: () => number }

function venueError(msg: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `ondo: ${msg}`, { exchange: "ondo" });
}

/** Funding by on-chain transfer exists on mainnet only (the sandbox is funded with demo funds). */
export function requireOndoDepositNetwork(net: Network): void {
  if (net === "testnet") {
    throw unsupported("Ondo Perps", "deposit", "the sandbox is funded with demo funds, not on-chain transfers",
      "Fund the sandbox account in the sandbox app (app.ondoperps-sandbox.xyz)");
  }
}

export function ondoDepositChain(raw: string): OndoDepositChain {
  const c = raw.toLowerCase();
  if (c === "arbitrum" || c === "ethereum") return c;
  throw new PerpError("INVALID_PARAMS", `Unsupported Ondo deposit chain "${raw}"`, { remediation: "Use --chain arbitrum or --chain ethereum (USDC only)" });
}

// ── Funding address ──

/**
 * The first listed USDC funding address of `network` for the margin wallet. Returns null when the
 * list has none for that network (the caller may then provision one). Refuses when the first
 * listed address does not belong to `accountId`.
 */
export function selectOndoDepositAddress(rows: unknown, network: OndoDepositChain, accountId: string): string | null {
  if (!Array.isArray(rows)) throw venueError(`deposit_address/list returned ${JSON.stringify(rows).slice(0, 120)}, expected a list`);
  for (const r of rows) {
    const row = (r !== null && typeof r === "object" ? r : {}) as { coin?: unknown; network?: unknown; address?: unknown; depositDestination?: { id?: unknown; wallet?: unknown } | null };
    if (row.coin !== "USDC" || row.network !== network) continue;
    const dest = row.depositDestination;
    if (dest === null || dest === undefined || dest.wallet !== "margin") continue;
    if (String(dest.id) !== accountId) {
      throw venueError(`the first listed USDC ${network} funding address belongs to account ${String(dest.id)}, not this account ${accountId} — refusing to send`);
    }
    if (typeof row.address !== "string" || !EVM_ADDRESS_RE.test(row.address)) {
      throw venueError(`the listed USDC ${network} funding address is not an EVM address (${JSON.stringify(row.address)})`);
    }
    return row.address;
  }
  return null;
}

export interface OndoFundingAddress { accountId: string; address: string; provisioned: boolean }

/** Resolve (or, only when none exists, provision) the account's USDC funding address on `network`. */
export async function resolveOndoDepositAddress(client: OndoFundsClient, network: OndoDepositChain): Promise<OndoFundingAddress> {
  const account = await client.get<{ accountID?: unknown }>("/v1/account", null);
  if (typeof account.accountID !== "string" || account.accountID === "") throw venueError("GET /v1/account returned no accountID");
  const accountId = account.accountID;
  const list = (): Promise<unknown> => client.post<unknown>("/v1/wallet/deposit_address/list", { coins: ["USDC"] });

  const existing = selectOndoDepositAddress(await list(), network, accountId);
  if (existing !== null) return { accountId, address: existing, provisioned: false };

  const created = await client.post<{ accountId?: unknown; address?: unknown }>("/v1/provision_address", {
    network, symbol: "USDC", deposit_destination: { id: accountId, wallet: "margin" },
  });
  if (String(created.accountId) !== accountId) {
    throw venueError(`provision_address answered for account ${String(created.accountId)}, not ${accountId} — refusing to send`);
  }
  const listed = selectOndoDepositAddress(await list(), network, accountId);
  if (listed === null || typeof created.address !== "string" || !sameAddress(listed, created.address)) {
    throw venueError(`the provisioned USDC ${network} address ${String(created.address)} is not the one the address list shows (${String(listed)}) — refusing to send`);
  }
  return { accountId, address: listed, provisioned: true };
}

// ── Deposit ──

export interface OndoDepositPlan {
  network: Network;
  chain: OndoDepositChain;
  chainId: number;
  chainLabel: string;
  rpcUrl: string;
  token: string;
  /** Read on-chain (decimals()). */
  decimals: number;
  amount: string;
  amountRaw: bigint;
  /** null = single transfer. */
  probe: string | null;
  probeRaw: bigint | null;
  depositor: string;
  depositAddress: string;
  accountId: string;
  tokenBalance: bigint;
}

/** Read-only checks on the pinned chain. Throws before anything is signed. */
export async function planOndoDeposit(p: {
  network: Network; chain: OndoDepositChain; amount: string; probe: string | null; depositor: string; funding: OndoFundingAddress;
}): Promise<OndoDepositPlan> {
  requireOndoDepositNetwork(p.network);
  if (!EVM_ADDRESS_RE.test(p.depositor)) {
    throw new PerpError("NO_SIGNER_AVAILABLE", "Ondo deposit needs the master wallet address", {
      remediation: "Run with the master wallet: perp --ows <wallet> funds deposit ondo <amount>",
    });
  }
  const pins = ONDO_DEPOSIT_CHAINS[p.chain];
  const rpc = evmProvider(pins.rpcUrl, pins.chainId);
  await assertRpcChainId(rpc, pins.rpcUrl, pins.chainId, "ondo");
  const decimals = await erc20Decimals(rpc, pins.usdc);
  const raw = (x: string, what: string): bigint => {
    if (!/^\d+(\.\d+)?$/.test(x) || !(Number(x) > 0)) throw new PerpError("INVALID_PARAMS", `${what} must be a positive decimal (got "${x}")`);
    try {
      return parseUnits(x, decimals);
    } catch {
      throw new PerpError("INVALID_PARAMS", `${what} ${x} has more than ${decimals} decimals (USDC on ${pins.label})`);
    }
  };
  const amountRaw = raw(p.amount, "Deposit amount");
  const probeRaw = p.probe === null ? null : raw(p.probe, "--probe");
  if (probeRaw !== null && probeRaw >= amountRaw) {
    throw new PerpError("INVALID_PARAMS", `--probe ${String(p.probe)} must be smaller than the deposit amount ${p.amount} (the remainder is sent after the probe is credited)`);
  }
  const [tokenBalance, gas] = await Promise.all([erc20Balance(rpc, pins.usdc, p.depositor), rpc.getBalance(p.depositor)]);
  if (tokenBalance < amountRaw) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${p.depositor} holds ${formatUnits(tokenBalance, decimals)} USDC on ${pins.label}; the deposit needs ${p.amount}`, {
      exchange: "ondo", remediation: `Fund ${p.depositor} with USDC on ${pins.label} (chainId ${pins.chainId}) first — e.g. perp funds bridge send --to ${p.chain} --to-asset USDC`,
    });
  }
  if (gas === 0n) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${p.depositor} has no ETH for gas on ${pins.label}`, {
      exchange: "ondo", remediation: `Fund ${p.depositor} with ETH on ${pins.label} (chainId ${pins.chainId})`,
    });
  }
  return {
    network: p.network, chain: p.chain, chainId: pins.chainId, chainLabel: pins.label, rpcUrl: pins.rpcUrl, token: pins.usdc, decimals,
    amount: p.amount, amountRaw, probe: p.probe, probeRaw, depositor: p.depositor,
    depositAddress: p.funding.address, accountId: p.funding.accountId, tokenBalance,
  };
}

/**
 * Wait until GET /v1/wallet/deposits lists this transaction as `confirmed`. Not listed / pending /
 * unreadable until the deadline → ORDER_PENDING with the tx hash (the transfer itself is mined).
 */
export async function awaitOndoDepositCredit(readDeposits: () => Promise<unknown>, txHash: string, what: string, timing: PollTiming): Promise<void> {
  const deadline = timing.now() + timing.timeoutMs;
  let last = "not listed yet";
  for (;;) {
    try {
      const rows = await readDeposits();
      if (!Array.isArray(rows)) throw venueError(`GET /v1/wallet/deposits returned ${JSON.stringify(rows).slice(0, 120)}, expected a list`);
      const row = (rows as Array<{ txid?: unknown; status?: unknown }>).find(r => typeof r?.txid === "string" && r.txid.toLowerCase() === txHash.toLowerCase());
      if (row !== undefined) {
        if (row.status === "confirmed") return;
        last = `status ${String(row.status)}`;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (timing.now() + timing.pollMs > deadline) break;
    await timing.sleep(timing.pollMs);
  }
  throw new PerpError("ORDER_PENDING", `ondo: ${what} ${txHash} is mined but not yet credited by Ondo Perps after ${timing.timeoutMs / 1000}s (${last})`, {
    exchange: "ondo", txHash,
    remediation: "Do NOT send again — the transfer is on-chain and deposits can take longer to confirm. Check: perp -e ondo account balance (or the Ondo Perps app → deposits)",
  });
}

export interface OndoDepositResult {
  transfers: Array<{ step: "probe" | "deposit"; txHash: string; amount: string }>;
  depositAddress: string;
}

/**
 * Send the USDC transfer(s). With a probe: probe → credited → remainder → credited; the
 * remainder is never sent while the probe is uncredited (the ORDER_PENDING carries `sent`).
 */
export async function executeOndoDeposit(
  plan: OndoDepositPlan, sign: TxSigner, readDeposits: () => Promise<unknown>, timing: PollTiming,
): Promise<OndoDepositResult> {
  const rpc = evmProvider(plan.rpcUrl, plan.chainId);
  const transfers: OndoDepositResult["transfers"] = [];
  const send = async (step: "probe" | "deposit", raw: bigint): Promise<void> => {
    const amount = formatUnits(raw, plan.decimals);
    const { txHash } = await sendMasterTx(rpc, {
      venue: "ondo", chainLabel: plan.chainLabel, chainId: plan.chainId, from: plan.depositor, to: plan.token, value: 0n,
      data: ERC20.encodeFunctionData("transfer", [plan.depositAddress, raw]), label: `USDC ${step} transfer (${amount})`,
    }, sign);
    transfers.push({ step, txHash, amount });
    try {
      await awaitOndoDepositCredit(readDeposits, txHash, `${step} transfer`, timing);
    } catch (e) {
      if (e instanceof PerpError && e.structured.code === "ORDER_PENDING") {
        const notSent = step === "probe" ? ` The remaining ${formatUnits(plan.amountRaw - raw, plan.decimals)} USDC was NOT sent.` : "";
        throw new PerpError("ORDER_PENDING", `${e.message}.${notSent}`, {
          exchange: "ondo", txHash, sent: transfers, depositAddress: plan.depositAddress,
          remediation: e.structured.remediation,
        });
      }
      throw e;
    }
  };
  if (plan.probeRaw !== null) {
    await send("probe", plan.probeRaw);
    await send("deposit", plan.amountRaw - plan.probeRaw);
  } else {
    await send("deposit", plan.amountRaw);
  }
  return { transfers, depositAddress: plan.depositAddress };
}

// ── Address book ──

const ADDRESS_BOOK_UI = "add the address in the Ondo Perps web app (Withdraw → address book)";

/** Withdrawal addresses on the account's address book (GET /v1/wallet/address_book). */
export async function ondoAddressBook(client: OndoFundsClient): Promise<string[]> {
  const res = await client.get<{ addressBook?: unknown }>("/v1/wallet/address_book", null);
  if (!Array.isArray(res.addressBook)) throw venueError("GET /v1/wallet/address_book returned no addressBook list");
  return (res.addressBook as Array<{ withdrawalAddress?: unknown }>).map(e => {
    if (typeof e?.withdrawalAddress !== "string") throw venueError("address book entry has no withdrawalAddress");
    return e.withdrawalAddress;
  });
}

/** Refusal for a withdraw destination that is not on the address book (nothing was sent). */
export function ondoAddressNotOnBook(destination: string, book: readonly string[]): PerpError {
  return new PerpError("INVALID_PARAMS", `${destination} is not on the Ondo Perps withdrawal address book (${book.length === 0 ? "the book is empty" : `listed: ${book.join(", ")}`}) — nothing was sent`, {
    exchange: "ondo",
    remediation: `Ondo only withdraws to address-book entries. An entry is added by signing a SIWE challenge with the account's wallet (api-reference/auth/get-siwe-address-book-challenge + complete). For the master wallet's own address run: perp funds address-book add ondo ${destination} — otherwise ${ADDRESS_BOOK_UI}`,
  });
}

/** A challenge the master key will sign must be about this address book entry — never an arbitrary message. */
export function assertOndoAddressBookChallenge(message: string, wallet: string, withdrawalAddress: string, restUrl: string): void {
  const refuse = (why: string): never => {
    throw new PerpError("POLICY_DENIED", `Ondo address-book challenge refused: ${why}. Nothing was signed.`, {
      exchange: "ondo", challenge: message.slice(0, 600), remediation: `If this message is expected, ${ADDRESS_BOOK_UI}`,
    });
  };
  if (!message.toLowerCase().includes(withdrawalAddress.toLowerCase())) refuse(`the message does not name the withdrawal address ${withdrawalAddress}`);
  // The endpoint is POST /v1/auth/erc-4361/address_book/get_challenge — "Get a Sign-In with Ethereum
  // challenge for adding a withdrawal address" (Ondo REST spec). ERC-4361 shape:
  // "<domain> wants you to sign in with your Ethereum account:\n<address>\n…". Any other message
  // is refused: the master key never signs free-form text.
  const siwe = /^(\S+) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})\n/.exec(message);
  if (siwe === null) return refuse("the message is not a Sign-In with Ethereum (ERC-4361) message");
  const venueHost = new URL(restUrl).hostname.split(".").slice(-2).join(".");
  const domain = siwe[1].replace(/^[a-z]+:\/\//, "").split(":")[0];
  if (domain !== venueHost && !domain.endsWith(`.${venueHost}`)) refuse(`its domain "${siwe[1]}" is not ${venueHost}`);
  if (!sameAddress(siwe[2], wallet)) refuse(`it is addressed to ${siwe[2]}, not the signing wallet ${wallet}`);
}

/** A venue refusal of the SIWE address-book endpoints, re-raised with the web-app route. */
function addressBookAuthError(e: unknown, step: string): unknown {
  if (!(e instanceof PerpError) || e.structured.code === "ORDER_PENDING") return e;
  return new PerpError(e.structured.code, `${e.message} — Ondo refused the address-book ${step} with API-key auth`, {
    ...e.structured.details, exchange: "ondo",
    remediation: `These endpoints may need a wallet (SIWE/JWT) session instead of an API key: ${ADDRESS_BOOK_UI}`,
  });
}

export interface OndoAddressBookAddResult { address: string; alreadyListed: boolean; listed: boolean; challengeId: string | null }

/**
 * Add the signing wallet's own address to the address book: get_challenge → personal_sign
 * (EIP-191) with the wallet → complete_challenge. Challenge chainId "1" (enum: 1 | 43114).
 */
export async function addOndoAddressBookEntry(client: OndoFundsClient, p: {
  wallet: string; restUrl: string; label: string | null; signMessage: (message: string) => Promise<string>;
}): Promise<OndoAddressBookAddResult> {
  const before = await ondoAddressBook(client);
  if (before.some(a => sameAddress(a, p.wallet))) return { address: p.wallet, alreadyListed: true, listed: true, challengeId: null };

  let challenge: { id?: unknown; message?: unknown };
  try {
    challenge = await client.post<{ id?: unknown; message?: unknown }>("/v1/auth/erc-4361/address_book/get_challenge", {
      walletAddress: p.wallet, chainId: "1", withdrawalAddress: p.wallet,
    });
  } catch (e) {
    throw addressBookAuthError(e, "challenge");
  }
  if (typeof challenge.id !== "string" || typeof challenge.message !== "string" || challenge.message === "") {
    throw venueError("address_book/get_challenge returned no id / message");
  }
  assertOndoAddressBookChallenge(challenge.message, p.wallet, p.wallet, p.restUrl);

  const signature = await p.signMessage(challenge.message);
  if (!sameAddress(verifyMessage(challenge.message, signature), p.wallet)) {
    throw new PerpError("SIGNATURE_FAILED", `The address-book challenge signature does not recover to ${p.wallet} — nothing was submitted`, { exchange: "ondo" });
  }
  try {
    await client.postNoResult("/v1/auth/erc-4361/address_book/complete_challenge", {
      id: challenge.id, signature, ...(p.label !== null ? { addressLabel: p.label } : {}),
    });
  } catch (e) {
    throw addressBookAuthError(e, "completion");
  }
  const after = await ondoAddressBook(client);
  return { address: p.wallet, alreadyListed: false, listed: after.some(a => sameAddress(a, p.wallet)), challengeId: challenge.id };
}
