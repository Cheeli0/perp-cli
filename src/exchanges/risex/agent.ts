/**
 * RISEx session signer lifecycle.
 *
 * approve (`perp wallet agent approve risex --master <ows>`):
 *  1. Create OWS wallet `agent-risex-<master>[-testnet]` (EVM key, empty passphrase — the agent
 *     wallet pattern of HL / Arcus).
 *  2. Pre-check the master's RISE-chain gas BEFORE registering (the restriction below is an
 *     on-chain transaction from the master; a signer that could not be restricted is never left
 *     registered on purpose).
 *  3. Master signs RegisterSigner, the signer signs VerifySigner (same nonce pair), POST
 *     /v1/auth/register-signer; poll session-key-status until Active.
 *  4. Restrict ON-CHAIN to trading only (owner decision 2026-10-13): for every permission except
 *     RISEX_TRADING_PERMISSION the SIGNER signs DisablePermission (the contract only accepts the
 *     signer's own signature for giving up a permission — verified by eth_call on testnet
 *     2026-10-14: a master-signed DisablePermission reverts InvalidSignerSignature) and the MASTER
 *     wallet sends Authorization.disablePermission(...) as an on-chain transaction (its signature;
 *     needs RISE-chain ETH for gas). Re-enabling needs an EnablePermission signed by the ACCOUNT
 *     (a signer-signed one reverts), so a leaked signer key cannot undo the restriction.
 *  5. Prove it: hasPermission(account, signer, p) is true for trading and false for every other p.
 *  Any failure in 4–5 revokes the signer (master-signed, gasless REST) so no full-permission signer
 *  is left behind; if even the revoke fails the error says so loudly.
 *
 * revoke: master signs RevokeSigner; POST /v1/auth/revoke-signer.
 */

import { getAddress, type Transaction } from "ethers";
import { PerpError, extractErrorMessage } from "../../errors.js";
import { assertRpcChainId, evmProvider, sendMasterTx } from "../../evm-master-tx.js";
import type { RisexAgentMeta } from "../../settings.js";
import type { EvmSigner } from "../../signer/interface.js";
import type { Network } from "../venue-types.js";
import { RisexSendUnknown, type RisexClient } from "./client.js";
import { risexClient } from "./public.js";
import { allocateAccountNonce, chainReader, loadSigningContext, type RisexChainReader, type RisexSigningContext } from "./session.js";
import {
  RISEX_AUTH_IFACE, RISEX_NON_TRADING_PERMISSIONS, RISEX_PERMISSION_IDS, RISEX_PINS, RISEX_TRADING_PERMISSION, signChecked,
  type NonceSlot,
} from "./typed-data.js";

export const RISEX_SIGNER_MESSAGE = "perp-cli signer";
export const RISEX_DEFAULT_EXPIRY_DAYS = 30;
const STATUS_ACTIVE = 1;
const CONFIRM_ATTEMPTS = 15;
const CONFIRM_INTERVAL_MS = 1_000;
/** Pre-check budget per DisablePermission transaction (gas units); the send re-checks exactly. */
const RESTRICT_GAS_BUDGET = 300_000n;

export function risexAgentWalletName(masterOwsWallet: string, network: Network): string {
  return network === "testnet" ? `agent-risex-${masterOwsWallet}-testnet` : `agent-risex-${masterOwsWallet}`;
}

export async function sessionKeyStatus(client: RisexClient, account: string, signer: string): Promise<number | null> {
  const d = await client.get<{ status?: unknown }>("/v1/auth/session-key-status", { account: account.toLowerCase(), signer: signer.toLowerCase() });
  return typeof d.status === "number" ? d.status : null;
}

/** Master + signer typed-data signatures and the register request. Unknown outcome → ORDER_PENDING. */
export async function registerSigner(p: {
  client: RisexClient; network: Network; ctx: RisexSigningContext; master: EvmSigner; signer: EvmSigner; expiration: number; nonceDir?: string;
}): Promise<{ txHash: string | null }> {
  const account = getAddress(p.master.getAddress());
  const signer = getAddress(p.signer.getAddress());
  const slot = await allocateAccountNonce(p.client, p.network, account, p.nonceDir);
  const accountSignature = await signChecked(p.master, p.ctx.domain, "RegisterSigner", {
    account, signer, message: RISEX_SIGNER_MESSAGE, expiration: p.expiration, nonceAnchor: slot.anchor, nonceBitmap: slot.bit,
  });
  const signerSignature = await signChecked(p.signer, p.ctx.domain, "VerifySigner", { account, nonceAnchor: slot.anchor, nonceBitmap: slot.bit });
  try {
    const res = await p.client.post<{ transaction_hash?: unknown; success?: unknown }>("/v1/auth/register-signer", {
      account, signer, message: RISEX_SIGNER_MESSAGE, expiration: String(p.expiration),
      nonce_anchor: slot.anchor.toString(), nonce_bitmap_index: slot.bit,
      account_signature: accountSignature, signer_signature: signerSignature,
    }, "register-signer");
    if (res.success !== true) {
      throw new PerpError("APPROVE_FAILED", `RISEx register-signer answered success=${String(res.success)}`, { exchange: "risex" });
    }
    return { txHash: typeof res.transaction_hash === "string" && res.transaction_hash !== "" ? res.transaction_hash : null };
  } catch (e) {
    if (e instanceof RisexSendUnknown) {
      throw new PerpError("ORDER_PENDING", `RISEx register-signer outcome unknown: ${extractErrorMessage(e.cause)}`, {
        exchange: "risex", signer,
        remediation: `Do NOT re-run approve yet. Check perp${p.network === "testnet" ? " -n testnet" : ""} wallet agent verify risex, or the signer list in the RISEx app; revoke ${signer} there if it shows up unrestricted`,
      });
    }
    throw e;
  }
}

/** Master-signed RevokeSigner over REST (gasless). */
export async function revokeSigner(p: { client: RisexClient; network: Network; ctx: RisexSigningContext; master: EvmSigner; signer: string; nonceDir?: string }): Promise<{ txHash: string | null }> {
  const account = getAddress(p.master.getAddress());
  const signer = getAddress(p.signer);
  const slot = await allocateAccountNonce(p.client, p.network, account, p.nonceDir);
  const accountSignature = await signChecked(p.master, p.ctx.domain, "RevokeSigner", { account, signer, nonceAnchor: slot.anchor, nonceBitmap: slot.bit });
  try {
    const res = await p.client.post<{ transaction_hash?: unknown; success?: unknown }>("/v1/auth/revoke-signer", {
      account, signer, nonce_anchor: slot.anchor.toString(), nonce_bitmap_index: slot.bit, account_signature: accountSignature,
    }, "revoke-signer");
    if (res.success !== true) throw new PerpError("ACTION_REJECTED", `RISEx revoke-signer answered success=${String(res.success)}`, { exchange: "risex" });
    return { txHash: typeof res.transaction_hash === "string" && res.transaction_hash !== "" ? res.transaction_hash : null };
  } catch (e) {
    if (e instanceof RisexSendUnknown) {
      throw new PerpError("ORDER_PENDING", `RISEx revoke-signer outcome unknown: ${extractErrorMessage(e.cause)}`, {
        exchange: "risex", signer, remediation: "Check the signer status (perp wallet agent verify risex) before retrying",
      });
    }
    throw e;
  }
}

/** Sends one signed disablePermission transaction from the master; resolves with the tx hash once mined successfully. */
export type DisablePermissionSender = (permission: number, slot: NonceSlot, signature: string) => Promise<string>;

/**
 * Restrict an ACTIVE signer to the trading permission and prove the final on-chain state.
 * Returns the permissions disabled by this call (already-disabled ones are skipped).
 */
export async function restrictSignerToTrading(p: {
  client: RisexClient; network: Network; ctx: RisexSigningContext; account: string; signer: EvmSigner;
  chain: RisexChainReader; send: DisablePermissionSender; nonceDir?: string;
}): Promise<{ disabled: Array<{ permission: number; txHash: string }>; verifiedAt: string }> {
  const account = getAddress(p.account);
  const signer = getAddress(p.signer.getAddress());
  const disabled: Array<{ permission: number; txHash: string }> = [];
  for (const permission of RISEX_NON_TRADING_PERMISSIONS) {
    if (!(await p.chain.hasPermission(account, signer, permission))) continue;
    const slot = await allocateAccountNonce(p.client, p.network, account, p.nonceDir);
    const signature = await signChecked(p.signer, p.ctx.domain, "DisablePermission", {
      account, signer, permission, nonceAnchor: slot.anchor, nonceBitmap: slot.bit,
    });
    disabled.push({ permission, txHash: await p.send(permission, slot, signature) });
  }
  const state = await Promise.all(RISEX_PERMISSION_IDS.map(async q => [q, await p.chain.hasPermission(account, signer, q)] as const));
  const wrong = state.filter(([q, on]) => (q === RISEX_TRADING_PERMISSION) !== on);
  if (wrong.length > 0) {
    throw new PerpError("APPROVE_FAILED", `RISEx signer ${signer} is not trading-only on-chain: ${wrong.map(([q, on]) => `permission ${q}=${on}`).join(", ")}`, { exchange: "risex" });
  }
  return { disabled, verifiedAt: new Date().toISOString() };
}

/** Master-wallet transaction sender for disablePermission on the pinned Authorization contract. */
export function masterDisablePermissionSender(network: Network, master: EvmSigner & { signTransaction(tx: Transaction): Promise<string> }, signer: string): DisablePermissionSender {
  const pin = RISEX_PINS[network];
  if (pin.rpcUrl === null) throw new PerpError("NOT_IMPLEMENTED", `RISEx ${network} has no known RPC endpoint`, { exchange: "risex" });
  const rpc = evmProvider(pin.rpcUrl, pin.chainId);
  const account = getAddress(master.getAddress());
  return async (permission, slot, signature) => {
    await assertRpcChainId(rpc, pin.rpcUrl as string, pin.chainId, "risex");
    const { txHash } = await sendMasterTx(rpc, {
      venue: "risex", chainLabel: `RISE chain (${pin.chainId})`, chainId: pin.chainId, from: account, to: pin.auth,
      data: RISEX_AUTH_IFACE.encodeFunctionData("disablePermission", [account, getAddress(signer), slot.anchor, slot.bit, permission, signature]),
      value: 0n, label: `disable signer permission ${permission}`,
    }, tx => master.signTransaction(tx));
    return txHash;
  };
}

/** Refuse before registering when the master cannot pay for the restriction transactions. */
export async function assertRestrictGas(network: Network, account: string): Promise<void> {
  const pin = RISEX_PINS[network];
  if (pin.rpcUrl === null) throw new PerpError("NOT_IMPLEMENTED", `RISEx ${network} has no known RPC endpoint`, { exchange: "risex" });
  const rpc = evmProvider(pin.rpcUrl, pin.chainId);
  await assertRpcChainId(rpc, pin.rpcUrl, pin.chainId, "risex");
  const fee = await rpc.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  if (price === null) throw new PerpError("EXCHANGE_ERROR", "RISE chain RPC returned no fee data — nothing was signed", { exchange: "risex" });
  const need = price * RESTRICT_GAS_BUDGET * BigInt(RISEX_NON_TRADING_PERMISSIONS.length);
  const have = await rpc.getBalance(account);
  if (have < need) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Restricting a RISEx signer to trading-only needs up to ${need} wei of RISE-chain ETH for gas (${RISEX_NON_TRADING_PERMISSIONS.length} on-chain transactions from ${account}); the wallet has ${have} — nothing was registered`, {
      exchange: "risex",
      remediation: `Send a little ETH on RISE chain (chainId ${pin.chainId}) to ${account}, then retry: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve risex`,
    });
  }
}

export interface ApproveRisexAgentOpts {
  agentName: string;
  masterOwsWallet: string;
  passphrase: string | null;
  network: Network;
  expiresAt: Date;
}

/** Full approve with OWS master + OWS agent wallet. Returns the meta (persisting it is the caller's job). */
export async function approveRisexAgent(opts: ApproveRisexAgentOpts): Promise<RisexAgentMeta> {
  const { network, expiresAt } = opts;
  const expiration = Math.floor(expiresAt.getTime() / 1000);
  if (!(expiration > Math.floor(Date.now() / 1000) + 60) || expiration > 0xffffffff) {
    throw new PerpError("INVALID_PARAMS", `RISEx signer expiry ${expiresAt.toISOString()} must be in the future (uint32 seconds)`, { remediation: "Use e.g. --expires-in 30d" });
  }
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const { loadOws } = await import("../../signer/ows-loader.js");
  const master = OwsEvmSigner.create(opts.masterOwsWallet, opts.passphrase ?? "");
  const account = getAddress(master.getAddress());
  const client = risexClient(network);

  // Everything that can refuse without side effects runs first.
  const ctx = await loadSigningContext(client, network);
  await assertRestrictGas(network, account);

  const ows = loadOws();
  const agentWalletName = risexAgentWalletName(opts.masterOwsWallet, network);
  if (ows.listWallets().some((w: { name: string }) => w.name === agentWalletName)) {
    throw new PerpError("INVALID_PARAMS", `OWS wallet "${agentWalletName}" already exists`, {
      remediation: `Replace the existing signer: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve risex --rotate (or delete an orphan wallet: ows wallet delete ${agentWalletName})`,
    });
  }
  const wallet = ows.createWallet(agentWalletName, "");
  const evm = wallet.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"));
  const dropWallet = () => { try { ows.deleteWallet(agentWalletName); } catch { /* reported by the caller's remediation */ } };
  if (!evm) {
    dropWallet();
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no EVM account`, { remediation: "Check OWS vault configuration" });
  }
  const signer = OwsEvmSigner.create(agentWalletName, "");

  try {
    await registerSigner({ client, network, ctx, master, signer, expiration });
  } catch (e) {
    // Unknown outcome: the signer may be registered — keep its key.
    if (!(e instanceof PerpError && e.structured.code === "ORDER_PENDING")) dropWallet();
    throw e;
  }

  let status: number | null = null;
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    status = await sessionKeyStatus(client, account, signer.getAddress());
    if (status === STATUS_ACTIVE) break;
    await new Promise(r => setTimeout(r, CONFIRM_INTERVAL_MS));
  }
  if (status !== STATUS_ACTIVE) {
    throw new PerpError("APPROVE_PARTIAL", `RISEx accepted register-signer but ${signer.getAddress()} is not Active yet (status ${String(status)})`, {
      exchange: "risex",
      remediation: `It may still activate with FULL permissions. Revoke it in the RISEx app (or re-run approve after it is Active to restrict it); the key is kept in OWS wallet "${agentWalletName}"`,
    });
  }

  let restricted: { disabled: Array<{ permission: number; txHash: string }>; verifiedAt: string };
  try {
    restricted = await restrictSignerToTrading({
      client, network, ctx, account, signer, chain: chainReader(network),
      send: masterDisablePermissionSender(network, master, signer.getAddress()),
    });
  } catch (e) {
    const why = extractErrorMessage(e);
    try {
      await revokeSigner({ client, network, ctx: await loadSigningContext(client, network), master, signer: signer.getAddress() });
    } catch (revokeErr) {
      throw new PerpError("APPROVE_PARTIAL", `RISEx signer ${signer.getAddress()} was registered but could NOT be restricted to trading-only (${why}) and the automatic revoke failed (${extractErrorMessage(revokeErr)})`, {
        exchange: "risex",
        remediation: `The signer may hold FULL permissions (including fund movement). Revoke it now in the RISEx app (${account} → API / signers). Its key is in OWS wallet "${agentWalletName}"`,
      });
    }
    dropWallet();
    throw new PerpError("APPROVE_FAILED", `RISEx signer could not be restricted to trading-only (${why}); it was revoked and its key deleted`, {
      exchange: "risex", cause: e instanceof PerpError ? e.structured : undefined,
      remediation: "Fix the cause above (e.g. RISE-chain ETH for gas on the master wallet), then retry: perp wallet agent approve risex",
    });
  }

  return {
    kind: "risex",
    agentName: opts.agentName,
    agentWalletName,
    signerAddress: getAddress(signer.getAddress()) as `0x${string}`,
    accountAddress: account as `0x${string}`,
    expiresAt: new Date(expiration * 1000).toISOString(),
    permissions: { tradingOnly: true, disabled: RISEX_NON_TRADING_PERMISSIONS.slice(), verifiedAt: restricted.verifiedAt },
    network,
    approvedAt: new Date().toISOString(),
    source: "approved",
  };
}

/** Revoke a stored signer with the master wallet that owns it. */
export async function revokeRisexAgent(opts: { meta: RisexAgentMeta; masterOwsWallet: string; passphrase: string | null }): Promise<{ txHash: string | null }> {
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const master = OwsEvmSigner.create(opts.masterOwsWallet, opts.passphrase ?? "");
  if (master.getAddress().toLowerCase() !== opts.meta.accountAddress.toLowerCase()) {
    throw new PerpError("INVALID_PARAMS", `Master wallet ${master.getAddress()} does not own RISEx signer ${opts.meta.signerAddress}`, {
      remediation: `Use the OWS wallet for ${opts.meta.accountAddress}`,
    });
  }
  const client = risexClient(opts.meta.network);
  const ctx = await loadSigningContext(client, opts.meta.network);
  return revokeSigner({ client, network: opts.meta.network, ctx, master, signer: opts.meta.signerAddress });
}

/** Verify a stored signer: Active on the venue and trading-only on-chain. */
export async function verifyRisexAgent(meta: RisexAgentMeta): Promise<{ status: number | null; active: boolean; permissions: Record<number, boolean>; tradingOnly: boolean; expired: boolean }> {
  const client = risexClient(meta.network);
  const status = await sessionKeyStatus(client, meta.accountAddress, meta.signerAddress);
  const chain = chainReader(meta.network);
  const permissions: Record<number, boolean> = {};
  for (const p of RISEX_PERMISSION_IDS) permissions[p] = await chain.hasPermission(meta.accountAddress, meta.signerAddress, p);
  const tradingOnly = RISEX_PERMISSION_IDS.every(p => permissions[p] === (p === RISEX_TRADING_PERMISSION));
  return { status, active: status === STATUS_ACTIVE, permissions, tradingOnly, expired: !(Date.parse(meta.expiresAt) > Date.now()) };
}
