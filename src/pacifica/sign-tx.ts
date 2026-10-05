/**
 * Sign a Solana transaction with any SolanaSigner (local keypair or OWS vault).
 *
 * OWS never exposes a raw keypair, so `tx.sign(keypair)` cannot be used for vault
 * wallets: the serialized transaction is signed through OWS and the signature is
 * attached with `addSignature`. The signature is always verified locally before
 * the caller sends anything.
 */
import { PublicKey, type Transaction } from "@solana/web3.js";
import { PerpError } from "../errors.js";
import type { SolanaSigner } from "../signer/index.js";
import { LocalSolanaSigner } from "../signer/index.js";

interface BytesSigner { signTransactionBytes(txBytes: Uint8Array): Uint8Array }

function hasBytesSigner(s: SolanaSigner): s is SolanaSigner & BytesSigner {
  return typeof (s as Partial<BytesSigner>).signTransactionBytes === "function";
}

/**
 * Add `signer`'s signature to `tx`. `partial` = other signatures (e.g. a relayer fee
 * payer) are still missing; otherwise every required signature must be present.
 */
export function signSolanaTransaction(signer: SolanaSigner, tx: Transaction, partial: boolean): void {
  const pubkey = new PublicKey(signer.getPublicKeyBase58());
  if (signer instanceof LocalSolanaSigner) {
    if (partial) signer.partialSignTransaction(tx);
    else signer.signTransaction(tx);
  } else if (hasBytesSigner(signer)) {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    tx.addSignature(pubkey, Buffer.from(signer.signTransactionBytes(bytes)));
  } else {
    throw new PerpError("NO_SIGNER_AVAILABLE", "This Solana signer cannot sign transactions", {
      remediation: "Use an OWS vault wallet or a local key for on-chain Pacifica actions",
    });
  }
  if (!tx.verifySignatures(!partial)) {
    throw new PerpError("SIGNATURE_FAILED", `Solana transaction signature from ${pubkey.toBase58()} did not verify — nothing was sent`, {
      remediation: "Check the wallet; the transaction was not submitted",
    });
  }
}
