import type { ExchangeAdapter } from "../exchanges/index.js";
import { isIocOutcomeCapable } from "../exchanges/ioc-outcome.js";
import type { OrderResult } from "../exchanges/venue-types.js";

/**
 * Filled base size the venue reported for a placed order: the adapter's venue-final IOC / market
 * outcome (iocOutcomeOf), else a TradingV2 OrderResult's `filledSize`. null = not reported (a
 * resting order, or an unrecognized result) — the caller does not count it as a fill.
 */
export function filledOf(adapter: ExchangeAdapter, raw: unknown): number | null {
  const outcome = isIocOutcomeCapable(adapter) ? adapter.iocOutcomeOf(raw) : null;
  if (outcome !== null) return Number(outcome.filledSize);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Partial<OrderResult>;
  if (typeof r.status !== "string" || typeof r.filledSize !== "string") return null;
  const n = Number(r.filledSize);
  return Number.isFinite(n) ? n : null;
}
