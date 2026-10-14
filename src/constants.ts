/**
 * Shared constants for perp-cli.
 */

import { loadSettings } from "./settings.js";

/**
 * Published taker fee per venue (fraction, e.g. 0.00035 = 0.035%) — configuration, not a
 * fallback (SSOT Rule #2 shipped defaults): used when settings.fees has no entry for the venue.
 */
export const TAKER_FEES: Record<string, number> = {
  hyperliquid: 0.00035,
  pacifica: 0.00035,
  lighter: 0,
  aster: 0.0004, // 0.04% taker fee
  // Ondo Perps base rate (docs.ondoperps.xyz/fees, 2026-10-02): taker 5 bps. A limited-time
  // 50% promotion (2.5 bps) is NOT assumed — it can end without notice; set
  // settings.fees.ondo to use the promotional or a volume-tier rate.
  ondo: 0.0005,
  // Arcus mainnet tier 0 "Base" (GET https://api.arcus.xyz/v1/feetiers, read 2026-10-02):
  // taker_fee_ppm 225. The docs publish no rates ("read fees from the API"); higher-volume
  // tiers are cheaper (Bronze 190 … Max 95 ppm). Testnet Base differs (450 ppm).
  arcus: 0.000225,
  // Lighter RH "Standard" (default) account tier: 0% / 0% (apidocs.lighter.xyz lighter-rh).
  // "Plus" is 0.005%/0.005%; "Premium" is 0.0120%/0.0350% (maker/taker) down to
  // 0.0084%/0.0245% by 14-day volume — Premium accounts must set settings.fees["lighter-rh"].
  "lighter-rh": 0,
  // QFEX entry tier ("Tier 5", < $2m 30-day effective volume; docs.qfex.com/qfex/fees, read
  // 2026-10-04): taker 0.10% on single stocks — the HIGHEST class rate, so index / commodity
  // orders (0.05%) are never under-estimated. Lower tiers / the lifetime-tier promotion: set
  // settings.fees.qfex.
  qfex: 0.001,
  // RISEx Tier 1 ($0 rolling 14-day volume; docs.risechain.com/docs/risex/trading/fees, read
  // 2026-10-14): taker 3.00 bps, maker 1.00 bps; higher tiers down to 1.50 / 0.00 bps — set
  // settings.fees.risex for a higher tier.
  risex: 0.0003,
  // TxFlow: no trading in perp-cli (market data only) — no fee entry on purpose.
};

/**
 * Published maker fee per venue (fraction; negative = rebate). Only venues whose base-tier
 * maker rate is published and verified are listed; others resolve to 0 in getMakerFee().
 */
export const MAKER_FEES: Record<string, number> = {
  ondo: 0.0002,        // base 2 bps; promotional 1 bp not assumed (see TAKER_FEES.ondo)
  arcus: 0,            // mainnet Base tier maker_fee_ppm 0
  // Aster perpetuals, Crypto — General (docs.asterdex.com trading/perpetuals/fees-and-specs/fees,
  // read 2026-10-02): maker 0%, taker 0.04% (TAKER_FEES.aster). RWA markets: maker 0 bps.
  aster: 0,
  "lighter-rh": 0,     // Standard tier (Premium: 0.012% under $1M 14-day volume)
  qfex: 0.0005,        // Tier 5 single stocks 0.05% (indices / commodities 0.02%); see TAKER_FEES.qfex
  risex: 0.0001,       // Tier 1 maker 1.00 bps; see TAKER_FEES.risex
};

/**
 * Taker fee for a venue: settings.fees[venue].taker → TAKER_FEES[venue] → DEFAULT_TAKER_FEE
 * (estimate for venues without a published entry). loadSettings() errors (malformed
 * settings.json) propagate — never replaced by the built-in fees.
 */
export function getTakerFee(exchange: string): number {
  const key = exchange.toLowerCase();
  const configured = loadSettings().fees[key]?.taker;
  if (configured !== undefined) return configured;
  return TAKER_FEES[key] ?? DEFAULT_TAKER_FEE;
}

/**
 * Maker fee for a venue: settings.fees[venue].maker → MAKER_FEES[venue] → 0 (no maker fee
 * published/configured). loadSettings() errors propagate.
 */
export function getMakerFee(exchange: string): number {
  const key = exchange.toLowerCase();
  const configured = loadSettings().fees[key]?.maker;
  if (configured !== undefined) return configured;
  return MAKER_FEES[key] ?? 0;
}

/**
 * Taker-fee estimate for an id with no TAKER_FEES entry. Every venue id in VENUE_IDS has
 * a published entry above, so this applies only to genuinely unknown ids — e.g. arb-auto's
 * getTakerFee("default") and trade-validator's venue-agnostic notional fee estimate.
 */
export const DEFAULT_TAKER_FEE = 0.00035;

/**
 * Hyperliquid's minimum order value, venue-wide (native perps and HIP-3 dexes): the venue refuses
 * smaller orders with "Order must have minimum value of $10". It is a documented constant, not a
 * field of `meta` / `metaAndAssetCtxs`, so it is the one order minimum that lives in code.
 */
export const HL_MIN_ORDER_VALUE_USD = "10";
