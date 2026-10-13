/**
 * Pacifica TESTNET (Solana devnet) test-USDP faucet — Anchor `mint_test_usdc`.
 *
 * Testnet tooling only: the instruction exists on the devnet program
 * (TESTNET_PROGRAM_ID); there is no mainnet equivalent and callers refuse
 * mainnet before building anything.
 *
 * Instruction (verified on devnet 2026-10-02 with a simulated + sent tx):
 *   data     = sha256("global:mint_test_usdc")[:8] (76904e769bd6b9ba) ‖ u64 LE amount × 1e6
 *   accounts = user (signer, writable), PDA(["user_account", user], program) (writable),
 *              user USDP ATA (writable), USDP mint (writable), central_state (read-only —
 *              the verified tx sent it read-only), ATA program, token program, system program
 *   + ComputeBudget setComputeUnitLimit(400_000).
 * The transaction is always simulated before it is sent; a failed simulation sends nothing.
 */
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { PerpError } from "../errors.js";
import type { SolanaSigner } from "../signer/index.js";
import { getNetworkConfig, USDC_DECIMALS } from "./constants.js";
import { signSolanaTransaction } from "./sign-tx.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const PACIFICA_DEVNET_RPC = "https://api.devnet.solana.com";
export const MINT_TEST_USDC_COMPUTE_UNITS = 400_000;

/** sha256("global:mint_test_usdc")[:8]. */
export function mintTestUsdcDiscriminator(): Buffer {
  return createHash("sha256").update("global:mint_test_usdc").digest().subarray(0, 8);
}

/** Plain positive decimal with ≤ 6 decimals → base units (u64). */
export function testUsdcBaseUnits(amount: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new PerpError("INVALID_PARAMS", `Faucet amount must be a plain decimal with at most ${USDC_DECIMALS} decimals (got "${amount}")`);
  }
  const [ip, fp = ""] = amount.split(".");
  const units = BigInt(ip) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fp.padEnd(USDC_DECIMALS, "0"));
  if (units <= 0n) throw new PerpError("INVALID_PARAMS", `Faucet amount must be positive (got "${amount}")`);
  if (units > 0xffff_ffff_ffff_ffffn) throw new PerpError("INVALID_PARAMS", `Faucet amount ${amount} overflows u64`);
  return units;
}

export interface MintTestUsdcPlan {
  user: string;
  userAccountPda: string;
  userAta: string;
  mint: string;
  centralState: string;
  programId: string;
  amount: string;
  baseUnits: string;
}

/** Accounts + amount the faucet instruction uses (pure; used for --dry-run). */
export function mintTestUsdcPlan(user: PublicKey, amount: string): MintTestUsdcPlan {
  const cfg = getNetworkConfig("testnet");
  const program = new PublicKey(cfg.programId);
  const mint = new PublicKey(cfg.usdcMint);
  const [userAccountPda] = PublicKey.findProgramAddressSync([Buffer.from("user_account"), user.toBuffer()], program);
  const [userAta] = PublicKey.findProgramAddressSync([user.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM);
  return {
    user: user.toBase58(),
    userAccountPda: userAccountPda.toBase58(),
    userAta: userAta.toBase58(),
    mint: mint.toBase58(),
    centralState: cfg.centralState,
    programId: cfg.programId,
    amount,
    baseUnits: testUsdcBaseUnits(amount).toString(),
  };
}

export function buildMintTestUsdcInstruction(plan: MintTestUsdcPlan): TransactionInstruction {
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(BigInt(plan.baseUnits));
  return new TransactionInstruction({
    programId: new PublicKey(plan.programId),
    data: Buffer.concat([mintTestUsdcDiscriminator(), amt]),
    keys: [
      { pubkey: new PublicKey(plan.user), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(plan.userAccountPda), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(plan.userAta), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(plan.mint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(plan.centralState), isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/**
 * Build, sign, SIMULATE, then send + confirm the faucet transaction. A simulation
 * error throws EXCHANGE_ERROR (with the program logs) and nothing is sent.
 */
export async function mintTestUsdc(
  connection: Connection,
  signer: SolanaSigner,
  amount: string,
): Promise<{ signature: string; plan: MintTestUsdcPlan }> {
  const user = new PublicKey(signer.getPublicKeyBase58());
  const plan = mintTestUsdcPlan(user, amount);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_TEST_USDC_COMPUTE_UNITS }),
    buildMintTestUsdcInstruction(plan),
  );
  tx.feePayer = user;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  signSolanaTransaction(signer, tx, false);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err !== null) {
    throw new PerpError("EXCHANGE_ERROR", `Pacifica testnet faucet simulation failed: ${JSON.stringify(sim.value.err)} — nothing was sent`, {
      exchange: "pacifica",
      logs: (sim.value.logs ?? []).slice(-8),
      remediation: "Check the wallet has devnet SOL for fees (solana airdrop) and retry with a smaller amount",
    });
  }
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return { signature, plan };
}
