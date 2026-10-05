/**
 * Pre-mainnet review H3: a relayer-built Pacifica deposit is never blind-signed with the master
 * Solana key. assertRelayedDepositTransaction accepts ONLY the pinned deposit (+ compute budget,
 * + the declared, capped fee transfer); the relayer is opt-in (`--relay`), direct is the default.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assertRelayedDepositTransaction, buildDepositInstruction, PACIFICA_RELAY_FEE_CAP_USDC } from "../../pacifica/deposit.js";
import { getNetworkConfig } from "../../pacifica/constants.js";
import { depositOutcomeUnknown, fundsFailStatus } from "../../commands/funds.js";
import { PerpError } from "../../errors.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const user = Keypair.generate().publicKey;
const relayer = Keypair.generate().publicKey;
const feeAccount = Keypair.generate().publicKey;
const mint = new PublicKey(getNetworkConfig("mainnet").usdcMint);
const userAta = PublicKey.findProgramAddressSync([user.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];

function tokenTransfer(source: PublicKey, dest: PublicKey, authority: PublicKey, units: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(units, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM, data,
    keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }],
  });
}

async function tx(ixs: TransactionInstruction[], feePayer: PublicKey = relayer): Promise<Transaction> {
  const t = new Transaction().add(...ixs);
  t.feePayer = feePayer;
  t.recentBlockhash = "11111111111111111111111111111111";
  // round-trip through the wire format, as the CLI receives it
  return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

const ctx = (over: Partial<{ fee: number; netAmount: number; feeRecipient: string | null; requestedAmount: string }> = {}) => ({
  user, requestedAmount: over.requestedAmount ?? "100", network: "mainnet" as const,
  declared: { fee: over.fee ?? 0.5, netAmount: over.netAmount ?? 99.5, feeRecipient: over.feeRecipient === undefined ? feeAccount.toBase58() : over.feeRecipient },
});

async function refused(t: Transaction, c = ctx()): Promise<string> {
  try { await assertRelayedDepositTransaction(t, c); } catch (e) {
    expect(e).toBeInstanceOf(PerpError);
    expect((e as PerpError).structured.code).toBe("POLICY_DENIED");
    expect((e as PerpError).message).toMatch(/Nothing was signed/);
    return (e as PerpError).message;
  }
  throw new Error("expected the transaction to be refused");
}

describe("assertRelayedDepositTransaction", () => {
  it("accepts: compute budget + the declared fee transfer + the pinned deposit of netAmount", async () => {
    const t = await tx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      tokenTransfer(userAta, feeAccount, user, 500_000n),
      await buildDepositInstruction(user, "99.5", "mainnet"),
    ]);
    await expect(assertRelayedDepositTransaction(t, ctx())).resolves.toBeUndefined();
  });

  it("accepts a fee-free deposit of the whole amount", async () => {
    const t = await tx([await buildDepositInstruction(user, "100", "mainnet")]);
    await expect(assertRelayedDepositTransaction(t, ctx({ fee: 0, netAmount: 100, feeRecipient: null }))).resolves.toBeUndefined();
  });

  it("refuses an extra instruction (a SOL transfer draining the user)", async () => {
    const t = await tx([await buildDepositInstruction(user, "99.5", "mainnet"), tokenTransfer(userAta, feeAccount, user, 500_000n),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: relayer, lamports: 1_000_000_000 })]);
    expect(await refused(t)).toMatch(/is not a Pacifica deposit/);
  });

  it("refuses a token transfer to an undeclared destination, of another amount, or undeclared at all", async () => {
    const dep = await buildDepositInstruction(user, "99.5", "mainnet");
    expect(await refused(await tx([dep, tokenTransfer(userAta, Keypair.generate().publicKey, user, 500_000n)]))).toMatch(/not the declared/);
    expect(await refused(await tx([dep, tokenTransfer(userAta, feeAccount, user, 50_000_000n)]))).toMatch(/not the declared 0.5 USDC/);
    expect(await refused(await tx([dep, tokenTransfer(userAta, feeAccount, user, 500_000n)]), ctx({ feeRecipient: null }))).toMatch(/did not declare/);
    expect(await refused(await tx([dep, tokenTransfer(userAta, feeAccount, user, 500_000n), tokenTransfer(userAta, feeAccount, user, 500_000n)]))).toMatch(/more than one fee transfer/);
  });

  it("refuses a deposit with another vault / program / amount, or no deposit at all", async () => {
    const dep = await buildDepositInstruction(user, "99.5", "mainnet");
    const otherVault = new TransactionInstruction({ programId: dep.programId, data: dep.data, keys: dep.keys.map((k, i) => i === 3 ? { ...k, pubkey: Keypair.generate().publicKey } : k) });
    const fee = tokenTransfer(userAta, feeAccount, user, 500_000n);
    expect(await refused(await tx([fee, otherVault]))).toMatch(/pinned user \/ vault \/ mint/);
    expect(await refused(await tx([fee, await buildDepositInstruction(user, "1", "mainnet")]))).toMatch(/deposit data/);
    expect(await refused(await tx([fee, await buildDepositInstruction(user, "99.5", "testnet")]))).toMatch(/is not a Pacifica deposit/);
    expect(await refused(await tx([fee]))).toMatch(/0 Pacifica deposit instructions/);
    expect(await refused(await tx([fee, dep, dep]))).toMatch(/2 Pacifica deposit instructions/);
  });

  it("refuses a fee above the cap, a fee + net that is not the requested amount, and a user-paid gas fee", async () => {
    const big = PACIFICA_RELAY_FEE_CAP_USDC + 4;
    const t = await tx([tokenTransfer(userAta, feeAccount, user, BigInt(big) * 1_000_000n), await buildDepositInstruction(user, String(100 - big), "mainnet")]);
    expect(await refused(t, ctx({ fee: big, netAmount: 100 - big }))).toMatch(/above the cap/);
    const ok = [tokenTransfer(userAta, feeAccount, user, 500_000n), await buildDepositInstruction(user, "99.5", "mainnet")];
    expect(await refused(await tx(ok), ctx({ requestedAmount: "50" }))).toMatch(/is not the requested 50 USDC/);
    expect(await refused(await tx(ok, user))).toMatch(/fee payer is not the relayer/);
  });
});

describe("relay is opt-in; direct is the default (funds deposit pacifica / hyperliquid)", () => {
  const src = readFileSync(join(__dirname, "../../commands/funds.ts"), "utf8");

  it("--relay opts in, --no-relay stays accepted, and no path tries the relayer by default", () => {
    expect(src.match(/\.option\("--relay",/g)).toHaveLength(2);
    expect(src.match(/\.option\("--no-relay",/g)).toHaveLength(2);
    expect(src.match(/const opts = \{ relay: rawOpts\.relay === true \};/g)).toHaveLength(2);
    expect(src).not.toMatch(/opts\.relay && await relayerAvailable\(\)/);
  });

  it("the relayer transaction is validated before the master key signs it", () => {
    const validate = src.indexOf("await assertRelayedDepositTransaction(tx,");
    const sign = src.indexOf("signSolanaTransaction(pacAdapter.masterSolanaSigner(), tx, true)");
    expect(validate).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(validate);
  });
});

describe("unknown outcomes are not logged / reported as failed", () => {
  it("a broadcast deposit whose confirmation timed out → ORDER_PENDING carrying the signature", () => {
    const e = depositOutcomeUnknown("5sig", new Error("Transaction was not confirmed in 30.00 seconds"));
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.structured.details?.signature).toBe("5sig");
    expect(e.structured.remediation).toMatch(/Do NOT deposit again/);
    expect(fundsFailStatus(e)).toBe("unverified");
  });

  it("a definite failure is still logged failed", () => {
    expect(fundsFailStatus(new PerpError("ACTION_REJECTED", "x"))).toBe("failed");
    expect(fundsFailStatus(new Error("boom"))).toBe("failed");
  });
});

describe("buildDepositInstruction amount scaling (exact, no float math)", () => {
  const amountOf = async (amount: string): Promise<bigint> => {
    const ix = await buildDepositInstruction(user, amount, "mainnet");
    return Buffer.from(ix.data).readBigUInt64LE(8); // 8-byte discriminator, then the u64 LE amount
  };

  it("scales the decimal STRING exactly to 6 decimals", async () => {
    expect(await amountOf("100")).toBe(100_000_000n);
    expect(await amountOf("99.5")).toBe(99_500_000n);
    expect(await amountOf("0.000001")).toBe(1n);
    // Float math got these wrong or imprecise: 1.005 * 1e6 = 1004999.9999999999, 9007199254.740993 is not a double.
    expect(await amountOf("1.005")).toBe(1_005_000n);
    expect(await amountOf("9007199254.740993")).toBe(9_007_199_254_740_993n);
  });

  it("more than 6 decimals, exponents, signs, empty or zero → INVALID_PARAMS; nothing is built", async () => {
    for (const bad of ["1.0000001", "1e3", "-5", "", "abc", "0", "0.000000", ".5", "5."]) {
      const err = await buildDepositInstruction(user, bad, "mainnet").catch(e => e);
      expect(err).toBeInstanceOf(PerpError);
      expect((err as PerpError).structured.code).toBe("INVALID_PARAMS");
    }
  });
});
