/**
 * Hyperliquid signing — L1 actions (phantom agent, agent- or master-signable) and
 * user-signed actions (HyperliquidSignTransaction EIP-712, master only). Mirrors
 * hyperliquid-python-sdk `utils/signing.py` (action_hash, sign_l1_action,
 * sign_user_signed_action and the *_SIGN_TYPES tables).
 *
 * Note: src/commands/agent.ts (approveAgent / userSetAbstraction) and
 * src/commands/builder.ts (approveBuilderFee) still carry their own copies of the
 * user-signed domain; they produce the same payload as signHlUserSignedAction.
 */

import type { EvmSigner } from "../signer/index.js";
import type { Network } from "./venue.js";
import { HL_USER_SIGNED } from "./venues/hyperliquid.js";
import { PerpError } from "../errors.js";

export interface HlSignature { r: string; s: string; v: number }

type Eip712Field = { name: string; type: string };

/**
 * keccak(msgpack(action) ‖ nonce u64be ‖ vault flag [‖ vault 20B] [‖ 0x00 ‖ expiresAfter u64be])
 * — python SDK `action_hash`.
 */
export async function hlL1ActionHash(
  action: Record<string, unknown>,
  nonce: number,
  vaultAddress: string | null,
  expiresAfter: number | null,
): Promise<string> {
  const { encode } = await import("@msgpack/msgpack");
  const { keccak256, getBytes } = await import("ethers");
  const packed = encode(action);
  const vault = vaultAddress === null ? new Uint8Array(0) : getBytes(vaultAddress);
  const len = packed.length + 8 + 1 + vault.length + (expiresAfter === null ? 0 : 9);
  const data = new Uint8Array(len);
  const view = new DataView(data.buffer);
  data.set(packed);
  let off = packed.length;
  view.setBigUint64(off, BigInt(nonce), false); off += 8;
  data[off] = vaultAddress === null ? 0 : 1; off += 1;
  data.set(vault, off); off += vault.length;
  if (expiresAfter !== null) {
    data[off] = 0; off += 1;
    view.setBigUint64(off, BigInt(expiresAfter), false);
  }
  return keccak256(data);
}

/** Sign an L1 action (phantom agent, domain "Exchange"/1337) — python `sign_l1_action`. */
export async function signHlL1Action(
  signer: EvmSigner,
  action: Record<string, unknown>,
  nonce: number,
  isMainnet: boolean,
  vaultAddress: string | null = null,
  expiresAfter: number | null = null,
): Promise<HlSignature> {
  const { ethers } = await import("ethers");
  const connectionId = await hlL1ActionHash(action, nonce, vaultAddress, expiresAfter);
  const sig = await signer.signTypedData(
    { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    { source: isMainnet ? "a" : "b", connectionId },
  );
  const p = ethers.Signature.from(sig);
  return { r: p.r, s: p.s, v: p.v };
}

/**
 * User-signed action types (python SDK *_SIGN_TYPES). `hyperliquidChain` is always
 * the first field; the remaining fields are copied from the action into the message.
 */
export const HL_USER_SIGNED_TYPES = {
  withdraw3: {
    primaryType: "HyperliquidTransaction:Withdraw",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  },
  usdSend: {
    primaryType: "HyperliquidTransaction:UsdSend",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  },
  approveBuilderFee: {
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" },
      { name: "nonce", type: "uint64" },
    ],
  },
  tokenDelegate: {
    primaryType: "HyperliquidTransaction:TokenDelegate",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "validator", type: "address" },
      { name: "wei", type: "uint64" },
      { name: "isUndelegate", type: "bool" },
      { name: "nonce", type: "uint64" },
    ],
  },
  // CCTP withdrawal (native USDC): HyperCore → HyperEVM burn → CCTP mint on the destination chain.
  // Field order per the Circle guide "Withdraw USDC from HyperCore to EVM chains"
  // (developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm) and the HL exchange endpoint docs.
  sendToEvmWithData: {
    primaryType: "HyperliquidTransaction:SendToEvmWithData",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "sourceDex", type: "string" },
      { name: "destinationRecipient", type: "string" },
      { name: "addressEncoding", type: "string" },
      { name: "destinationChainId", type: "uint32" },
      { name: "gasLimit", type: "uint64" },
      { name: "data", type: "bytes" },
      { name: "nonce", type: "uint64" },
    ],
  },
  usdClassTransfer: {
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    fields: [
      { name: "hyperliquidChain", type: "string" },
      { name: "amount", type: "string" },
      { name: "toPerp", type: "bool" },
      { name: "nonce", type: "uint64" },
    ],
  },
} as const satisfies Record<string, { primaryType: string; fields: readonly Eip712Field[] }>;

export type HlUserSignedType = keyof typeof HL_USER_SIGNED_TYPES;

/** The action field that carries the nonce (withdraw3/usdSend use `time`). */
export function hlUserSignedNonceField(type: HlUserSignedType): "time" | "nonce" {
  return type === "withdraw3" || type === "usdSend" ? "time" : "nonce";
}

/** Action object for a user-signed type: type + signatureChainId + hyperliquidChain + fields. */
export function buildHlUserSignedAction(
  type: HlUserSignedType,
  network: Network,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const { hyperliquidChain, signatureChainIdHex } = HL_USER_SIGNED[network];
  return { type, signatureChainId: signatureChainIdHex, hyperliquidChain, ...fields };
}

/** EIP-712 domain/types/message for a user-signed action (python `user_signed_payload`). */
export function hlUserSignedTypedData(action: Record<string, unknown>): {
  domain: Record<string, unknown>;
  types: Record<string, Eip712Field[]>;
  message: Record<string, unknown>;
} {
  const type = action.type as HlUserSignedType;
  const spec = HL_USER_SIGNED_TYPES[type];
  if (spec === undefined) {
    throw new PerpError("INVALID_PARAMS", `Not a Hyperliquid user-signed action type: ${String(action.type)}`, { exchange: "hyperliquid" });
  }
  const message: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (action[f.name] === undefined) {
      throw new PerpError("INVALID_PARAMS", `Hyperliquid ${type}: missing field ${f.name}`, { exchange: "hyperliquid" });
    }
    message[f.name] = action[f.name];
  }
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: parseInt(String(action.signatureChainId), 16),
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: { [spec.primaryType]: spec.fields.map(f => ({ ...f })) },
    message,
  };
}

/** Sign a user-signed action with the MASTER signer (python `sign_user_signed_action`). */
export async function signHlUserSignedAction(signer: EvmSigner, action: Record<string, unknown>): Promise<HlSignature> {
  const { ethers } = await import("ethers");
  const { domain, types, message } = hlUserSignedTypedData(action);
  const p = ethers.Signature.from(await signer.signTypedData(domain, types, message));
  return { r: p.r, s: p.s, v: p.v };
}
