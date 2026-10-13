/**
 * Master-wallet signers for the USDC bridge (`funds bridge send / exchange`, `funds rebalance
 * execute --auto-bridge`).
 *
 * The master is either an OWS vault wallet (the supported secret store, SSOT Rule #3) or a raw
 * private key (--private-key / wallets.json / legacy env). Addresses are read without decrypting
 * anything (OWS: the vault's public account list; raw key: derived locally). Signing goes through
 * the existing signers: OwsEvmSigner / OwsSolanaSigner for vault wallets (digest derived inside the
 * signer), a local SigningKey / Keypair for raw keys.
 */
import { SigningKey, computeAddress, verifyTypedData, type Transaction } from "ethers";
import { PublicKey, type Keypair, type VersionedTransaction } from "@solana/web3.js";
import { PerpError } from "./errors.js";
import type { CliCredentialOpts } from "./config.js";
import type { VenueId } from "./exchanges/venue-types.js";
import type { SolanaSigner } from "./signer/interface.js";
import { LocalSolanaSigner } from "./signer/solana-local.js";
import { unsignedTxDigest } from "./signer/ows-evm.js";

type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

/** EVM signer the bridge engine uses. OwsEvmSigner satisfies it; raw keys use pkEvmSigner. */
export interface BridgeEvmSigner {
  getAddress(): string;
  /** Signs an unsigned, chain-bound tx (digest derived inside); returns the 65-byte 0x signature. */
  signTransaction(tx: Transaction): Promise<string>;
  signTypedData(domain: Record<string, unknown>, types: TypedDataTypes, value: Record<string, unknown>): Promise<string>;
}

/** Signs with a raw EVM private key (legacy raw-key masters). */
export function pkEvmSigner(privateKey: string): BridgeEvmSigner {
  const key = new SigningKey(privateKey);
  const address = computeAddress(key);
  return {
    getAddress: () => address,
    signTransaction: async (tx) => key.sign(unsignedTxDigest(tx)).serialized,
    signTypedData: async (domain, types, value) => {
      const { TypedDataEncoder } = await import("ethers");
      return key.sign(TypedDataEncoder.hash(domain, types, value)).serialized;
    },
  };
}

/** Signs with a raw Solana secret key (base58 or JSON byte array). */
export async function pkSolanaSigner(secret: string): Promise<SolanaSigner> {
  const { parseSolanaKeypair } = await import("./config.js");
  return new LocalSolanaSigner(parseSolanaKeypair(secret));
}

export function isBridgeEvmSigner(x: unknown): x is BridgeEvmSigner {
  const o = x as Partial<BridgeEvmSigner> | null;
  return typeof o === "object" && o !== null && typeof o.getAddress === "function"
    && typeof o.signTransaction === "function" && typeof o.signTypedData === "function";
}

export function isSolanaSigner(x: unknown): x is SolanaSigner {
  const o = x as Partial<SolanaSigner> | null;
  return typeof o === "object" && o !== null && typeof o.getPublicKeyBase58 === "function";
}

/**
 * EIP-712 signature from the bridge signer, checked locally: the recovered address must be the
 * signer's own address before anything is submitted.
 */
export async function signTypedDataChecked(
  signer: BridgeEvmSigner, domain: Record<string, unknown>, types: TypedDataTypes, value: Record<string, unknown>, what: string,
): Promise<string> {
  const sig = await signer.signTypedData(domain, types, value);
  const recovered = verifyTypedData(domain, types, value, sig);
  if (recovered.toLowerCase() !== signer.getAddress().toLowerCase()) {
    throw new PerpError("SIGNATURE_FAILED", `${what}: signature recovered ${recovered}, expected ${signer.getAddress()} — nothing was sent`, {
      remediation: "Check the selected master wallet (perp wallet list); nothing was submitted",
    });
  }
  return sig;
}

/**
 * Add the master's signature to a v0 Solana transaction (plus any locally generated keypairs,
 * e.g. a CCTP event-data account). OWS never exposes a keypair, so the serialized transaction is
 * signed inside the vault and the signature attached. The signature is verified locally before
 * the caller sends anything.
 */
export async function signVersionedSolanaTx(signer: SolanaSigner, tx: VersionedTransaction, extra: Keypair[] = []): Promise<void> {
  if (extra.length > 0) tx.sign(extra);
  const pubkey = new PublicKey(signer.getPublicKeyBase58());
  const message = tx.message.serialize();
  let sig: Uint8Array;
  if (signer instanceof LocalSolanaSigner) {
    sig = await signer.signMessage(message);
  } else if (typeof (signer as { signTransactionBytes?: unknown }).signTransactionBytes === "function") {
    sig = (signer as SolanaSigner & { signTransactionBytes(b: Uint8Array): Uint8Array }).signTransactionBytes(tx.serialize());
  } else {
    throw new PerpError("NO_SIGNER_AVAILABLE", "This Solana signer cannot sign transactions", {
      remediation: "Use an OWS vault wallet (perp wallet use <name>) or a local Solana key",
    });
  }
  const nacl = (await import("tweetnacl")).default;
  if (sig.length !== 64 || !nacl.sign.detached.verify(message, sig, pubkey.toBytes())) {
    throw new PerpError("SIGNATURE_FAILED", `Solana transaction signature from ${pubkey.toBase58()} did not verify — nothing was sent`, {
      remediation: "Check the selected master wallet; the transaction was not submitted",
    });
  }
  tx.addSignature(pubkey, sig);
}

// ── Master wallet resolution ──

type BridgeMaster = { kind: "ows"; wallet: string; passphrase: string } | { kind: "pk"; key: string };

/** The venue whose master key signs on a bridge chain (Solana → Pacifica's, EVM → the given EVM venue). */
export function bridgeVenueForChain(chain: string, evmVenue: VenueId = "hyperliquid"): VenueId {
  return chain === "solana" ? "pacifica" : evmVenue;
}

async function resolveBridgeMaster(venue: VenueId, opts: CliCredentialOpts): Promise<BridgeMaster> {
  const { resolveOwsMaster, loadPrivateKey, isOwsKey } = await import("./config.js");
  const ows = await resolveOwsMaster(venue, opts);
  if (ows !== null) return { kind: "ows", ...ows };
  // Not an OWS wallet: a raw-key master (throws NO_SIGNER_AVAILABLE when none is configured).
  const key = await loadPrivateKey(venue, opts.privateKey ?? undefined, opts.wallet ?? undefined);
  if (isOwsKey(key)) {
    throw new PerpError("NO_SIGNER_AVAILABLE", `The ${venue} master resolved to an OWS wallet reference that the vault does not serve`, {
      remediation: "Select the master wallet explicitly: --ows <name> (or perp wallet use <name>)",
    });
  }
  return { kind: "pk", key };
}

function owsAccountMissing(wallet: string, vm: "EVM" | "Solana", e: unknown): PerpError {
  return new PerpError("NO_SIGNER_AVAILABLE", `OWS wallet "${wallet}" has no ${vm} account usable for bridging (${e instanceof Error ? e.message : String(e)})`, {
    remediation: `Use an OWS wallet with an ${vm} account (perp wallet list), or pass --ows <name>`,
  });
}

/**
 * The master wallet's own PUBLIC address on a bridge chain. Nothing is decrypted: OWS reads the
 * vault's public account list, a raw key is derived locally.
 */
export async function bridgeAddress(chain: string, venue: VenueId, opts: CliCredentialOpts): Promise<string> {
  const master = await resolveBridgeMaster(venue, opts);
  if (master.kind === "ows") {
    if (chain === "solana") {
      const { OwsSolanaSigner } = await import("./signer/ows-solana.js");
      try { return OwsSolanaSigner.create(master.wallet, master.passphrase).getPublicKeyBase58(); }
      catch (e) { throw owsAccountMissing(master.wallet, "Solana", e); }
    }
    const { OwsEvmSigner } = await import("./signer/ows-evm.js");
    try { return OwsEvmSigner.create(master.wallet, master.passphrase).getAddress(); }
    catch (e) { throw owsAccountMissing(master.wallet, "EVM", e); }
  }
  if (chain === "solana") return (await pkSolanaSigner(master.key)).getPublicKeyBase58();
  return computeAddress(new SigningKey(master.key));
}

/** The master wallet's signer on a bridge chain (OWS vault signer, or a raw-key signer). */
export async function loadBridgeSigner(chain: string, venue: VenueId, opts: CliCredentialOpts): Promise<BridgeEvmSigner | SolanaSigner> {
  const master = await resolveBridgeMaster(venue, opts);
  if (master.kind === "ows") {
    if (chain === "solana") {
      const { OwsSolanaSigner } = await import("./signer/ows-solana.js");
      try { return OwsSolanaSigner.create(master.wallet, master.passphrase); }
      catch (e) { throw owsAccountMissing(master.wallet, "Solana", e); }
    }
    const { OwsEvmSigner } = await import("./signer/ows-evm.js");
    try { return OwsEvmSigner.create(master.wallet, master.passphrase); }
    catch (e) { throw owsAccountMissing(master.wallet, "EVM", e); }
  }
  return chain === "solana" ? pkSolanaSigner(master.key) : pkEvmSigner(master.key);
}
