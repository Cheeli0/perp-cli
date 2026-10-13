/**
 * RISEx signing context: the EIP-712 domain, the permit target (router) and the maintenance flag,
 * fetched at runtime and checked against the per-network pins (typed-data.ts RISEX_PINS) before
 * anything is signed. Also the master / signer nonce allocation and on-chain permission reads.
 */

import { PerpError } from "../../errors.js";
import { assertRpcChainId, evmProvider } from "../../evm-master-tx.js";
import type { Network } from "../venue-types.js";
import type { RisexClient } from "./client.js";
import { allocateNonce, parseRemoteNonceState } from "./nonce.js";
import { assertPinned, RISEX_AUTH_IFACE, RISEX_PERMISSION_IDS, RISEX_PINS, type NonceSlot, type RisexDomain } from "./typed-data.js";

export interface RisexSigningContext {
  domain: RisexDomain;
  router: string;
  auth: string;
}

interface SystemConfig {
  addresses?: { router?: unknown; auth?: unknown };
  is_maintenance_mode?: unknown;
  maintenance_message?: unknown;
  maintenance_end_time?: unknown;
}

/** Refuse writes during venue maintenance (system config `is_maintenance_mode`). */
export function assertNotMaintenance(cfg: SystemConfig): void {
  if (cfg.is_maintenance_mode === true) {
    const end = typeof cfg.maintenance_end_time === "string" && /^\d+$/.test(cfg.maintenance_end_time)
      ? new Date(Number(cfg.maintenance_end_time) * 1000).toISOString() : null;
    throw new PerpError("EXCHANGE_UNREACHABLE", `RISEx is in maintenance${typeof cfg.maintenance_message === "string" && cfg.maintenance_message !== "" ? `: ${cfg.maintenance_message}` : ""} — nothing was sent`, {
      exchange: "risex", sent: false, remediation: end !== null ? `Retry after ${end}` : "Retry after the maintenance window",
    });
  }
}

export async function loadSigningContext(client: RisexClient, net: Network): Promise<RisexSigningContext> {
  const [d, cfg] = await Promise.all([
    client.get<{ name?: unknown; version?: unknown; chain_id?: unknown; verifying_contract?: unknown }>("/v1/auth/eip712-domain"),
    client.get<SystemConfig>("/v1/system/config"),
  ]);
  if (typeof d.name !== "string" || typeof d.version !== "string" || typeof d.chain_id !== "string" || typeof d.verifying_contract !== "string") {
    throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/auth/eip712-domain: malformed response", { exchange: "risex" });
  }
  const router = cfg.addresses?.router;
  const auth = cfg.addresses?.auth;
  if (typeof router !== "string" || typeof auth !== "string") {
    throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/system/config: no addresses.router / addresses.auth", { exchange: "risex" });
  }
  const domain: RisexDomain = { name: d.name, version: d.version, chainId: Number(d.chain_id), verifyingContract: d.verifying_contract };
  assertPinned(net, domain, router, auth);
  assertNotMaintenance(cfg);
  return { domain, router, auth };
}

/** Allocate (and burn) the next nonce pair for `account` (see nonce.ts). */
export function allocateAccountNonce(client: RisexClient, net: Network, account: string, dir?: string): Promise<NonceSlot> {
  return allocateNonce(net, account, async () => parseRemoteNonceState(await client.get(`/v1/nonce-state/${account.toLowerCase()}`)), dir);
}

export interface RisexChainReader {
  hasPermission(account: string, signer: string, permission: number): Promise<boolean>;
  isNonceUsed(account: string, slot: NonceSlot): Promise<boolean>;
}

const NONCE_IFACE_FN = "function isNonceUsed(address account, uint48 nonceAnchor, uint8 nonceBitmap) view returns (bool)";

/** Read-only on-chain reads against the pinned Authorization contract. */
export function chainReader(net: Network): RisexChainReader {
  const pin = RISEX_PINS[net];
  if (pin.rpcUrl === null) {
    throw new PerpError("NOT_IMPLEMENTED", `RISEx ${net} has no known RPC endpoint`, { exchange: "risex" });
  }
  const rpc = evmProvider(pin.rpcUrl, pin.chainId);
  const rpcUrl = pin.rpcUrl;
  // The RPC must serve the pinned chain before any answer from it is trusted (same check as the sender).
  let chainChecked: Promise<void> | null = null;
  const checked = () => (chainChecked ??= assertRpcChainId(rpc, rpcUrl, pin.chainId, "risex").catch(e => { chainChecked = null; throw e; }));
  return {
    async hasPermission(account, signer, permission) {
      if (!RISEX_PERMISSION_IDS.includes(permission)) throw new PerpError("INVALID_PARAMS", `RISEx permission ${permission} is not 0..4`);
      await checked();
      const raw = await rpc.call({ to: pin.auth, data: RISEX_AUTH_IFACE.encodeFunctionData("hasPermission", [account, signer, permission]) });
      return RISEX_AUTH_IFACE.decodeFunctionResult("hasPermission", raw)[0] as boolean;
    },
    async isNonceUsed(account, slot) {
      await checked();
      const { Interface } = await import("ethers");
      const i = new Interface([NONCE_IFACE_FN]);
      const raw = await rpc.call({ to: pin.auth, data: i.encodeFunctionData("isNonceUsed", [account, slot.anchor, slot.bit]) });
      return i.decodeFunctionResult("isNonceUsed", raw)[0] as boolean;
    },
  };
}
