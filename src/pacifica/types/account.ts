export interface AccountInfo {
  balance: string;
  fee_level: number;
  maker_fee: string;
  taker_fee: string;
  account_equity: string;
  available_to_spend: string;
  available_to_withdraw: string;
  pending_balance: string;
  pending_interest: string;
  total_margin_used: string;
  cross_mmr: string;
  positions_count: number;
  orders_count: number;
  stop_orders_count: number;
}

/**
 * One `margin_settings` entry of GET /account/settings (docs.pacifica.fi
 * api-documentation/api/rest-api/account/get-account-settings): `isolated` = "If the account is set
 * to isolated margining for this symbol", `leverage` = "Current leverage set by the user (default to max)".
 */
export interface AccountMarginSetting {
  symbol: string;
  isolated: boolean;
  leverage: number;
  created_at: number;
  updated_at: number;
}

/**
 * GET /account/settings `data`. Only markets changed from their defaults are listed — docs: "Upon
 * account creation, all markets have margin settings default to cross margin and leverage default
 * to max. When querying this endpoint, all markets with default margin and leverage settings on
 * this account will return blank."
 */
export interface AccountSettings {
  auto_lend_disabled: boolean | null;
  margin_settings: AccountMarginSetting[];
  spot_settings?: Array<{ symbol: string; unified_margin_excluded: boolean }>;
}

/**
 * POST /account/subaccount/transfer. Docs (rest-api/subaccounts/subaccount-fund-transfer): the
 * sender is the signing `account` ("Sender account address"); the signed payload is only
 * `to_account` ("Recipient wallet address") and `amount` ("Transfer amount (in USDC)").
 */
export interface TransferFundsParams {
  to_account: string;
  amount: string;
}

export interface WithdrawParams {
  amount: string;
  // No destination field: Pacifica withdrawals always go to the account owner's
  // own connected wallet (per the request-withdrawal REST spec).
}

export interface UpdateLeverageParams {
  symbol: string;
  leverage: number;
}
