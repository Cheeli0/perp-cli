/**
 * signSolanaTransaction: vault (OWS-style bytes signer) and local keypair signers both
 * produce a verified signature; a wrong signature is refused before anything is sent.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { signSolanaTransaction } from "../../pacifica/sign-tx.js";
import { LocalSolanaSigner } from "../../signer/index.js";
import type { SolanaSigner } from "../../signer/index.js";

function txFor(payer: PublicKey): Transaction {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.feePayer = payer;
  tx.recentBlockhash = "11111111111111111111111111111111";
  return tx;
}

/** Mimics OwsSolanaSigner: signs the message bytes of a serialized transaction. */
function bytesSigner(kp: Keypair, tamper: boolean): SolanaSigner & { signTransactionBytes(b: Uint8Array): Uint8Array } {
  return {
    getPublicKeyBase58: () => kp.publicKey.toBase58(),
    signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
    signTransaction: () => { throw new Error("no in-place sign"); },
    partialSignTransaction: () => { throw new Error("no in-place sign"); },
    signTransactionBytes: (b) => {
      const msg = Transaction.from(Buffer.from(b)).serializeMessage();
      const sig = nacl.sign.detached(msg, kp.secretKey);
      if (tamper) sig[0] ^= 0xff;
      return sig;
    },
  };
}

describe("signSolanaTransaction", () => {
  it("vault-style signer: attaches a signature that verifies", () => {
    const kp = Keypair.generate();
    const tx = txFor(kp.publicKey);
    signSolanaTransaction(bytesSigner(kp, false), tx, false);
    expect(tx.verifySignatures()).toBe(true);
  });

  it("local keypair signer: full sign verifies", () => {
    const kp = Keypair.generate();
    const tx = txFor(kp.publicKey);
    signSolanaTransaction(new LocalSolanaSigner(kp), tx, false);
    expect(tx.verifySignatures()).toBe(true);
  });

  it("a bad signature is refused (SIGNATURE_FAILED), so the caller never sends it", () => {
    const kp = Keypair.generate();
    expect(() => signSolanaTransaction(bytesSigner(kp, true), txFor(kp.publicKey), false)).toThrow(/did not verify/);
  });
});
