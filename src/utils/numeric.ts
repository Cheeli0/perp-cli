import { PerpError } from "../errors.js";

/**
 * Coerce a venue payload value to a finite number — or throw.
 *
 * Shared across all 4 exchange adapters (Lighter / Hyperliquid / Aster /
 * Pacifica) to enforce Rule #2 ("no fallback") on venue-returned strings
 * and numbers. Previously each adapter inlined `Number(x ?? 0)` which
 * silently coerced NaN / Infinity / non-numeric strings to 0, masking
 * stale-cache / partial-response corruption as legitimate "$0 balance".
 *
 * Rules:
 *  - `undefined` / `null` → returns `defaultValue` (default 0). Venues
 *    legitimately omit a field for an empty account or zero position;
 *    that is "no data, treat as zero", not a parsing failure.
 *  - empty string `""` → throws. Strict policy (qa/2026-05-16): an
 *    empty string is indistinguishable from a stale-cache partial
 *    response, so `Number("") === 0` would land back in the same
 *    silent-substitution hole. A truly absent field must surface as
 *    `undefined`/`null` at the adapter layer, not `""`.
 *  - finite number / parseable numeric string → returned as-is.
 *  - NaN / ±Infinity / non-numeric string → throws `EXCHANGE_ERROR`
 *    tagged with `exchange` so triage can attribute the failure to the
 *    exact venue endpoint.
 *
 * @param value Raw payload value (untyped — venues lie about SDK types).
 * @param fieldName Field path for the error message (e.g.
 *   `"available_balance"`, `"position.unrealized_pnl"`).
 * @param exchange Exchange tag for the PerpError details payload
 *   (`hyperliquid` / `pacifica` / `aster` / `lighter`).
 * @param opts.defaultValue Value returned for null/undefined. Default `0`.
 */
export function parseFiniteVenueNumber(
  value: unknown,
  fieldName: string,
  exchange: string,
  opts: { defaultValue?: number } = {},
): number {
  const defaultValue = opts.defaultValue ?? 0;
  if (value === undefined || value === null) return defaultValue;
  if (value === "") {
    throw new PerpError(
      "EXCHANGE_ERROR",
      `${exchange} response field \`${fieldName}\` is an empty string (use null for missing data)`,
      { exchange },
    );
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new PerpError(
      "EXCHANGE_ERROR",
      `${exchange} response field \`${fieldName}\` is not a finite number: ${JSON.stringify(value)}`,
      { exchange },
    );
  }
  return n;
}

/** Significant digits kept when a venue rate arrives as a JSON number (IEEE-754 double: 15 are exact). */
const RATE_SIG_DIGITS = 15;

/**
 * A rate the venue sends as a JSON NUMBER, as a plain decimal string without float noise:
 * rounded to 15 significant digits (a double's exact precision) and written without exponent.
 * Lighter /funding-rates sends e.g. `"rate":0.00009599999999999999` → "0.000096";
 * -0.000047999999999999994 → "-0.000048"; 1.2e-7 → "0.00000012". A rate the venue sends as a
 * STRING is passed through verbatim by callers, never through this. Non-finite → EXCHANGE_ERROR.
 */
export function venueRateString(value: number, what = "rate"): string {
  if (!Number.isFinite(value)) throw new PerpError("EXCHANGE_ERROR", `${what} is not a finite number (${value})`);
  if (value === 0) return "0";
  const [mant, expS] = value.toExponential(RATE_SIG_DIGITS - 1).split("e");
  const digits = mant.replace("-", "").replace(".", "").replace(/0+$/, "");
  const point = Number(expS) + 1; // value = 0.<digits> × 10^point
  const sign = value < 0 ? "-" : "";
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * A required venue rate field as a decimal string: a JSON number → venueRateString (no float
 * noise); a numeric string → verbatim. Missing / non-numeric → EXCHANGE_ERROR (never "0").
 */
export function venueRateField(value: unknown, fieldName: string, exchange: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return venueRateString(value, `${exchange} ${fieldName}`);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return value;
  throw new PerpError("EXCHANGE_ERROR", `${exchange} ${fieldName}: not a numeric rate (${JSON.stringify(value)})`, { exchange });
}
