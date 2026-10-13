/** Default market canonicalization (injectable via opts.canonicalize / comparator canonicalize). */

import type { Canonicalize } from "./types.js";

/**
 * Quotes that collapse to "<BASE>". USDG is included because lighter-rh and Arcus settle in USDG
 * (USD-pegged); a caller who wants them apart passes its own `canonicalize`.
 */
export const USD_LIKE_QUOTES: ReadonlySet<string> = new Set(["USDT", "USD1", "USDC", "USD", "USDG"]);

/**
 * HIP-3 (dex set) → "<dex>:<BASE>". A USD-like quote → "<BASE>". Any other quote, or an unknown
 * quote (null), → null (not comparable by default).
 */
export const defaultCanonicalize: Canonicalize = (_venue, m) => {
  const base = m.base.toUpperCase();
  if (m.dex !== null && m.dex !== "") return `${m.dex}:${base}`;
  if (m.quote === null) return null;
  return USD_LIKE_QUOTES.has(m.quote.toUpperCase()) ? base : null;
};
