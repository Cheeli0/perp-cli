/**
 * Vault ("lake") request payloads — docs.pacifica.fi api-documentation/api/rest-api/vaults.
 * Fields the docs mark optional are `T | null` here (null = not sent).
 */

/** POST /lake/create ("create_lake"): every payload field is optional per the docs. */
export interface CreateLakeParams {
  /** "Manager address. Omit to create a fresh vault with no manager." */
  manager: string | null;
  /** "Display name for the vault" */
  nickname: string | null;
  /** "Seed deposit from the creator in the same request" (decimal string) */
  initial_deposit: string | null;
}

/** POST /lake/deposit ("deposit_to_lake"). */
export interface LakeDepositParams {
  /** "Vault address" */
  lake: string;
  /** "Deposit amount in USDC" */
  amount: string;
}

/** POST /lake/withdraw ("withdraw_from_lake"). */
export interface LakeWithdrawParams {
  /** "Vault address" */
  lake: string;
  /** "Number of shares to redeem" */
  shares: string;
}
