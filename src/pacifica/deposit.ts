import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  type TransactionSignature,
} from "@solana/web3.js";
import { getNetworkConfig, USDC_DECIMALS, type Network } from "./constants.js";
import { PerpError } from "../errors.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

/**
 * Build the Anchor "global:deposit" discriminator.
 * sha256("global:deposit")[:8]
 */
async function getDepositDiscriminator(): Promise<Uint8Array> {
  const data = new TextEncoder().encode("global:deposit");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash).slice(0, 8);
}

/**
 * Derive the Associated Token Account for a user.
 */
function getATA(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  return ata;
}

/**
 * Derive the event authority PDA.
 */
function getEventAuthority(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );
  return pda;
}

/**
 * Build a Pacifica deposit instruction.
 *
 * @param userPubkey - User's wallet public key
 * @param amount - Amount in USDC as a plain decimal string with at most 6 decimals (e.g. "100", "99.5");
 *                 scaled exactly (no float math). Anything else → INVALID_PARAMS.
 * @param network - mainnet or testnet
 */
export async function buildDepositInstruction(
  userPubkey: PublicKey,
  amount: string,
  network: Network = "mainnet"
): Promise<TransactionInstruction> {
  const config = getNetworkConfig(network);
  const programId = new PublicKey(config.programId);
  const centralState = new PublicKey(config.centralState);
  const pacificaVault = new PublicKey(config.pacificaVault);
  const usdcMint = new PublicKey(config.usdcMint);

  const userATA = getATA(userPubkey, usdcMint);
  const eventAuthority = getEventAuthority(programId);

  // Build instruction data: discriminator + amount (u64 LE)
  const discriminator = await getDepositDiscriminator();
  const amountLamports = usdcUnits(amount);
  if (amountLamports === null || amountLamports <= 0n) {
    throw new PerpError("INVALID_PARAMS", `Pacifica deposit amount "${amount}" is not a positive USDC amount with at most ${USDC_DECIMALS} decimals; nothing was built`, {
      exchange: "pacifica", remediation: `Pass a plain decimal with at most ${USDC_DECIMALS} decimals, e.g. 100 or 99.5`,
    });
  }
  const amountBytes = new Uint8Array(8);
  const view = new DataView(amountBytes.buffer);
  view.setBigUint64(0, amountLamports, true); // little-endian

  const data = new Uint8Array(discriminator.length + amountBytes.length);
  data.set(discriminator, 0);
  data.set(amountBytes, discriminator.length);

  // Account metas (ORDER IS CRITICAL)
  const keys = [
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: userATA, isSigner: false, isWritable: true },
    { pubkey: centralState, isSigner: false, isWritable: true },
    { pubkey: pacificaVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId, data: Buffer.from(data) });
}

/**
 * Build and send a deposit transaction.
 */
export async function deposit(
  connection: Connection,
  userPubkey: PublicKey,
  amount: string,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  network: Network = "mainnet"
): Promise<TransactionSignature> {
  const instruction = await buildDepositInstruction(userPubkey, amount, network);

  const tx = new Transaction().add(instruction);
  tx.feePayer = userPubkey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const signed = await signTransaction(tx);
  return connection.sendRawTransaction(signed.serialize());
}

const COMPUTE_BUDGET_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");

/** Highest relayer fee (USDC) the CLI signs for a relayed deposit. Above it the transaction is refused. */
export const PACIFICA_RELAY_FEE_CAP_USDC = 1;

/** Decimal USDC string → integer base units (6 decimals), exact; null when not a plain decimal with ≤ 6 decimals. */
function usdcUnits(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (m === null) return null;
  return BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

function readU64LE(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

/**
 * Verify a RELAYER-BUILT transaction before the master Solana key signs it. The relayer is an
 * untrusted HTTP service (PERP_RELAYER_URL): whatever it returns is signed only when it is
 * exactly
 *  - ONE pinned Pacifica deposit instruction — the program id, every account (user, user USDC
 *    ATA, central state, vault, mint, …, in order, same signer / writable flags) and the data
 *    `buildDepositInstruction` would produce for `declared.netAmount`;
 *  - any number of ComputeBudget instructions (they move no funds);
 *  - at most ONE relayer fee transfer: an SPL Token Transfer / TransferChecked of exactly
 *    `declared.fee` USDC from the user's USDC account, authority = user, to the token account the
 *    build response declared (`feeRecipient`), with fee ≤ PACIFICA_RELAY_FEE_CAP_USDC;
 * and fee + netAmount equals the amount the user asked to deposit, and the fee payer is not the
 * user (the relayer sponsors gas). Anything else → POLICY_DENIED, nothing is signed.
 */
export async function assertRelayedDepositTransaction(
  tx: Transaction,
  ctx: { user: PublicKey; requestedAmount: string; network: Network; declared: { fee: number; netAmount: number; feeRecipient: string | null } },
): Promise<void> {
  const refuse = (why: string): PerpError => new PerpError("POLICY_DENIED", `Refusing to sign the relayer-built Pacifica deposit: ${why}. Nothing was signed`, {
    exchange: "pacifica", remediation: "Drop --relay for a direct deposit (you pay gas, ~0.005 SOL)",
  });
  const { user, declared } = ctx;
  const requested = usdcUnits(ctx.requestedAmount);
  if (requested === null || requested <= 0n) throw refuse(`the requested amount "${ctx.requestedAmount}" is not a USDC amount with at most ${USDC_DECIMALS} decimals`);
  if (!Number.isFinite(declared.fee) || !Number.isFinite(declared.netAmount) || declared.fee < 0 || declared.netAmount <= 0) {
    throw refuse(`the build response declares fee ${declared.fee} / netAmount ${declared.netAmount}`);
  }
  const feeUnits = BigInt(Math.round(declared.fee * 10 ** USDC_DECIMALS));
  const netUnits = BigInt(Math.round(declared.netAmount * 10 ** USDC_DECIMALS));
  if (feeUnits + netUnits !== requested) throw refuse(`declared fee ${declared.fee} + netAmount ${declared.netAmount} is not the requested ${ctx.requestedAmount} USDC`);
  if (declared.fee > PACIFICA_RELAY_FEE_CAP_USDC) throw refuse(`the relayer fee ${declared.fee} USDC is above the cap of ${PACIFICA_RELAY_FEE_CAP_USDC} USDC`);
  if (tx.feePayer === undefined || tx.feePayer === null || tx.feePayer.equals(user)) throw refuse("the fee payer is not the relayer (a sponsored deposit never makes the user pay gas)");

  const config = getNetworkConfig(ctx.network);
  const usdcMint = new PublicKey(config.usdcMint);
  const userAta = getATA(user, usdcMint);
  const netDecimal = `${netUnits / 10n ** BigInt(USDC_DECIMALS)}.${(netUnits % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0")}`;
  const expected = await buildDepositInstruction(user, netDecimal, ctx.network);
  let deposits = 0;
  let feeTransfers = 0;
  for (const [i, ix] of tx.instructions.entries()) {
    const at = `instruction ${i} (${ix.programId.toBase58()})`;
    if (ix.programId.equals(COMPUTE_BUDGET_PROGRAM)) {
      if (ix.keys.length !== 0) throw refuse(`${at}: a compute-budget instruction with accounts`);
      continue;
    }
    if (ix.programId.equals(expected.programId)) {
      const sameKeys = ix.keys.length === expected.keys.length && ix.keys.every((k, j) =>
        k.pubkey.equals(expected.keys[j].pubkey) && k.isSigner === expected.keys[j].isSigner && k.isWritable === expected.keys[j].isWritable);
      if (!sameKeys) throw refuse(`${at}: the deposit accounts are not the pinned user / vault / mint accounts`);
      if (!Buffer.from(ix.data).equals(Buffer.from(expected.data))) throw refuse(`${at}: the deposit data is not "deposit ${declared.netAmount} USDC"`);
      deposits++;
      continue;
    }
    if (ix.programId.equals(TOKEN_PROGRAM)) {
      // SPL Token Transfer (3): [source, destination, authority]; TransferChecked (12): [source, mint, destination, authority].
      const tag = ix.data[0];
      const checked = tag === 12;
      if (tag !== 3 && !checked) throw refuse(`${at}: an SPL token instruction that is not a transfer`);
      if (ix.data.length !== (checked ? 10 : 9) || ix.keys.length !== (checked ? 4 : 3)) throw refuse(`${at}: a malformed token transfer`);
      const [source, dest, authority] = checked ? [ix.keys[0], ix.keys[2], ix.keys[3]] : [ix.keys[0], ix.keys[1], ix.keys[2]];
      if (checked && (!ix.keys[1].pubkey.equals(usdcMint) || ix.data[9] !== USDC_DECIMALS)) throw refuse(`${at}: the fee transfer is not in the deposit token`);
      if (!source.pubkey.equals(userAta) || !authority.pubkey.equals(user)) throw refuse(`${at}: the token transfer is not from the user's own USDC account`);
      if (declared.feeRecipient === null) throw refuse(`${at}: a fee transfer the build response did not declare (no feeRecipient)`);
      let recipient: PublicKey;
      try { recipient = new PublicKey(declared.feeRecipient); } catch { throw refuse(`the declared feeRecipient "${declared.feeRecipient}" is not a Solana address`); }
      if (!dest.pubkey.equals(recipient)) throw refuse(`${at}: the fee transfer goes to ${dest.pubkey.toBase58()}, not the declared ${recipient.toBase58()}`);
      if (readU64LE(ix.data, 1) !== feeUnits) throw refuse(`${at}: the fee transfer amount is not the declared ${declared.fee} USDC`);
      if (++feeTransfers > 1) throw refuse("more than one fee transfer");
      continue;
    }
    throw refuse(`${at} is not a Pacifica deposit, a compute-budget instruction or the declared fee transfer`);
  }
  if (deposits !== 1) throw refuse(`it contains ${deposits} Pacifica deposit instructions (exactly one expected)`);
  if (feeUnits > 0n && feeTransfers !== 1) throw refuse(`the declared fee ${declared.fee} USDC is not transferred by the transaction`);
  if (feeUnits === 0n && feeTransfers !== 0) throw refuse("a fee transfer although the declared fee is 0");
}
