/**
 * Orderbook-aware split order execution.
 *
 * The USD total is converted ONCE to a base size (at the opening best price, floored to the
 * venue lot) and that size is split across the slices in whole lots. Every slice is an IOC
 * limit at the worst acceptable price within the slippage tolerance (on the venue tick), and
 * its fill is VERIFIED (placePerpVerified: venue-final IOC outcome or measured position delta)
 * — a resolved order call is never counted as a fill.
 *
 * Before anything is sent the plan is checked against the venue minimums: a slice below the
 * venue's minimum size / order value refuses the whole run (SIZE_TOO_SMALL, nothing sent).
 *
 * Flow per slice:
 *   1. Fetch fresh orderbook
 *   2. Slice = remaining size / slices left (whole lots; the last slice takes the rest)
 *   3. Place IOC limit at best price ± slippage tolerance, verify the fill
 *   4. Wait for the book to refresh, then repeat
 * A slice with an unknown outcome stops the run (nothing is resent); a definite rejection
 * (incl. an IOC that filled nothing) leaves its size to the following slices.
 */

import type { ExchangeAdapter } from "../exchanges/index.js";
import { computeExecutableSize } from "../liquidity.js";
import { logExecution } from "../execution-log.js";
import { PerpError, extractErrorMessage, isDefiniteOrderFailure } from "../errors.js";
import { alignProtectionPrice, floorToStep, formatComputedPrice, toUnitsExact, unitsToString } from "../exchanges/precision.js";
import { placePerpVerified } from "../bot/perp-order.js";
import { reportedAvgFillPrice } from "../exchanges/ioc-outcome.js";

export interface SplitOrderParams {
  symbol: string;
  side: "buy" | "sell";
  totalSizeUsd: number;        // total notional to execute
  /** Venue lot step of the market (required: slices are sized in whole lots). */
  stepSize: string;
  /** Venue price tick; null = the venue publishes none (Hyperliquid) → the orderbook's price precision is used. */
  tickSize: string | null;
  /** Venue-published order minimums (null = none published). */
  minSize: string | null;
  minNotional: string | null;
  maxSlippagePct?: number;     // max slippage per slice (default: 0.3%)
  maxSlices?: number;          // max number of slices (default: 10)
  delayMs?: number;            // delay between slices (default: 1000ms)
  minSliceUsd?: number;        // minimum slice size (default: 100)
}

export interface SplitSlice {
  index: number;
  size: string;                // base size sent (on the lot grid)
  price: string;               // IOC limit price sent (NOT the fill price)
  /** Verified filled base size; null = outcome unknown. */
  filledSize: string | null;
  /** Venue-reported average fill price; null = the venue did not report one. */
  avgFillPrice: string | null;
  method: "limit_ioc";
  status: "filled" | "partial" | "rejected" | "unknown";
  error: string | null;
}

export interface SplitOrderResult {
  symbol: string;
  side: "buy" | "sell";
  requestedUsd: number;
  /** Base size the USD total was converted to (opening best price, floored to the lot). */
  requestedSize: string;
  filledSize: string;
  /** Filled notional at the reported fill prices; null when a filled slice has no reported price. */
  filledUsd: number | null;
  /** Size-weighted average of the venue-reported fill prices; null when any filled slice has none. */
  avgPrice: string | null;
  totalSlippagePct: number | null;
  slices: SplitSlice[];
  /** complete = the whole size filled; partial = some; failed = nothing filled (all definite); unknown = a slice's outcome is unknown. */
  status: "complete" | "partial" | "failed" | "unknown";
  runtime: number;
}

/** Decimal places of an orderbook price string. */
function pricePrecision(priceStr: string): number {
  return priceStr.includes(".") ? priceStr.split(".")[1].length : 0;
}

/**
 * IOC limit for a slice: best ± slippage, aligned to the tick TOWARD the best price (never
 * beyond the tolerance); without a tick, cut to the orderbook's own price precision.
 */
function sliceLimitPrice(best: string, side: "buy" | "sell", maxSlippagePct: number, tickSize: string | null): string {
  const raw = Number(best) * (side === "buy" ? 1 + maxSlippagePct / 100 : 1 - maxSlippagePct / 100);
  if (tickSize === null) return raw.toFixed(pricePrecision(best));
  const aligned = alignProtectionPrice(raw.toFixed(12), tickSize, side === "buy" ? "sell" : "buy");
  // A tolerance smaller than one tick aligns back onto / past the best price: the best price itself still crosses.
  const crosses = side === "buy" ? Number(aligned) >= Number(best) : Number(aligned) <= Number(best);
  return crosses ? aligned : best;
}

function belowMinimum(size: string, price: number, p: Pick<SplitOrderParams, "minSize" | "minNotional">): string | null {
  if (p.minSize !== null && Number(size) < Number(p.minSize)) return `size ${p.minSize}`;
  if (p.minNotional !== null && Number(size) * price < Number(p.minNotional)) return `order value $${p.minNotional}`;
  return null;
}

/**
 * The error a split run that did not fill completely must surface (never ok:true): ORDER_PENDING
 * when a slice's outcome is unknown, ORDER_REJECTED when nothing filled and every slice is
 * definite, ORDER_PARTIAL when only part filled. null = complete.
 */
export function splitIncompleteError(venue: string, r: SplitOrderResult): PerpError | null {
  if (r.status === "complete") return null;
  const what = `${venue} split ${r.side} $${r.requestedUsd} ${r.symbol}`;
  const details = { exchange: venue, result: r };
  const check = `perp account positions -e ${venue}`;
  if (r.status === "unknown") {
    return new PerpError("ORDER_PENDING", `${what}: the outcome of slice ${r.slices.findIndex(s => s.status === "unknown") + 1} is unknown; ${r.filledSize} of ${r.requestedSize} verified filled`, {
      ...details, remediation: `Do NOT resubmit — the slice may have executed. Check the position: ${check}`,
    });
  }
  if (r.status === "failed") {
    const why = r.slices.map(s => s.error).filter(e => e !== null).join("; ");
    return new PerpError("ORDER_REJECTED", `${what}: nothing filled${why !== "" ? ` — ${why}` : r.slices.length === 0 ? " — no slice was sent" : ""}`, details);
  }
  return new PerpError("ORDER_PARTIAL", `${what}: ${r.filledSize} of ${r.requestedSize} filled`, {
    ...details, remediation: `The filled part is open. Check the position: ${check}, then send the remainder as a new order if still wanted.`,
  });
}

/**
 * Execute a split order: lot-sized slices of the total, IOC limits, verified fills.
 */
export async function runSplitOrder(
  adapter: ExchangeAdapter,
  params: SplitOrderParams,
  log: (msg: string) => void = console.log,
): Promise<SplitOrderResult> {
  const {
    symbol, side, totalSizeUsd, stepSize, tickSize,
    maxSlippagePct = 0.3,
    maxSlices = 10,
    delayMs = 1000,
    minSliceUsd = 100,
  } = params;
  const startedAt = Date.now();
  if (!(totalSizeUsd > 0) || !(minSliceUsd > 0) || !Number.isInteger(maxSlices) || maxSlices < 1 || !(maxSlippagePct > 0)) {
    throw new PerpError("INVALID_PARAMS", `split ${symbol}: usd, --min-slice and --max-slippage must be > 0 and --max-slices a whole number ≥ 1`);
  }

  // ── Plan (nothing is sent before every slice passes) ──
  const openingBook = await adapter.getOrderbook(symbol);
  const openingLevels = side === "buy" ? openingBook.asks : openingBook.bids;
  if (openingLevels.length === 0) {
    throw new PerpError("PRICE_STALE", `${adapter.name} ${symbol}: no ${side === "buy" ? "asks" : "bids"} in the orderbook — nothing was sent`, { exchange: adapter.name });
  }
  const initialBestPrice = Number(openingLevels[0][0]);
  if (!(initialBestPrice > 0)) {
    throw new PerpError("PRICE_STALE", `${adapter.name} ${symbol}: unusable best price ${openingLevels[0][0]} — nothing was sent`, { exchange: adapter.name });
  }
  const sliceCount = Math.min(maxSlices, Math.floor(totalSizeUsd / minSliceUsd));
  if (sliceCount < 1) {
    throw new PerpError("SIZE_TOO_SMALL", `split ${symbol}: $${totalSizeUsd} is below --min-slice $${minSliceUsd}; nothing was sent`, {
      exchange: adapter.name, remediation: "Lower --min-slice or use a larger total",
    });
  }
  const totalSize = floorToStep(totalSizeUsd / initialBestPrice, stepSize);
  const totalUnits = toUnitsExact(totalSize, stepSize, "size");
  const smallest = unitsToString(totalUnits / BigInt(sliceCount), stepSize);
  const under = totalUnits / BigInt(sliceCount) <= 0n ? `lot ${stepSize}` : belowMinimum(smallest, initialBestPrice, params);
  if (under !== null) {
    throw new PerpError("SIZE_TOO_SMALL",
      `${adapter.name} ${symbol}: $${totalSizeUsd} in ${sliceCount} slice(s) gives a slice of ${smallest} (≈ $${(Number(smallest) * initialBestPrice).toFixed(2)} @ ${openingLevels[0][0]}), below the venue minimum ${under}; nothing was sent`, {
        exchange: adapter.name, slices: sliceCount, sliceSize: smallest, stepSize, minSize: params.minSize, minNotional: params.minNotional,
        remediation: "Use fewer slices (--max-slices) or a larger total so that every slice meets the venue minimum",
      });
  }

  log(`[SPLIT] ${side.toUpperCase()} $${totalSizeUsd} of ${symbol} = ${totalSize} in ${sliceCount} slice(s) | max slippage: ${maxSlippagePct}%`);

  const slices: SplitSlice[] = [];
  let remainingUnits = totalUnits;
  let filledUnits = 0n;
  let stopped = false;

  for (let i = 0; i < sliceCount && remainingUnits > 0n && !stopped; i++) {
    // 1. Fresh orderbook
    const book = i === 0 ? openingBook : await adapter.getOrderbook(symbol);
    const levels = side === "buy" ? book.asks : book.bids;
    if (levels.length === 0) {
      log(`[SPLIT] No ${side === "buy" ? "asks" : "bids"} in orderbook, stopping`);
      break;
    }
    const best = levels[0][0];

    // 2. Slice: an even share of what remains, in whole lots (the last slice takes the rest)
    const slicesLeft = BigInt(sliceCount - i);
    const sliceUnits = slicesLeft === 1n ? remainingUnits : remainingUnits / slicesLeft;
    const size = unitsToString(sliceUnits, stepSize);
    const short = sliceUnits <= 0n ? `lot ${stepSize}` : belowMinimum(size, Number(best), params);
    if (short !== null) {
      log(`[SPLIT] Slice ${i + 1}: ${size} is below the venue minimum ${short}, stopping (not sent)`);
      break;
    }

    // 3. IOC limit at the worst acceptable price, fill verified
    const price = sliceLimitPrice(best, side, maxSlippagePct, tickSize);
    const depth = computeExecutableSize(levels, Number(size) * Number(best), maxSlippagePct);
    log(`[SPLIT] Slice ${i + 1}/${sliceCount}: ${size} @ limit $${price} | depth within ${maxSlippagePct}%: $${depth.depthUsd.toFixed(0)}`);

    let slice: SplitSlice;
    try {
      const fill = await placePerpVerified(adapter, adapter.name, symbol, side, size, {
        stepSize,
        place: () => adapter.limitOrder(symbol, side, price, size, { tif: "IOC" }),
      });
      const filled = floorToStep(fill.filledSize, stepSize);
      const got = toUnitsExact(filled, stepSize, "filled size");
      filledUnits += got;
      remainingUnits -= got;
      slice = {
        index: i, size, price, filledSize: filled, avgFillPrice: reportedAvgFillPrice(fill.raw),
        method: "limit_ioc", status: got >= sliceUnits ? "filled" : "partial", error: null,
      };
    } catch (err) {
      const definite = isDefiniteOrderFailure(err);
      const msg = extractErrorMessage(err);
      log(`[SPLIT] Slice ${i + 1} ${definite ? "refused" : "outcome UNKNOWN"}: ${msg}`);
      slice = {
        index: i, size, price, filledSize: definite ? "0" : null, avgFillPrice: null,
        method: "limit_ioc", status: definite ? "rejected" : "unknown", error: msg,
      };
      // Unknown outcome: the slice may have executed — never send more on top of it.
      if (!definite) stopped = true;
    }
    slices.push(slice);
    logExecution({
      type: "limit_order", exchange: adapter.name, symbol, side, size, price,
      status: slice.status === "unknown" ? "unverified" : slice.status === "rejected" ? "failed" : "success",
      dryRun: false, ...(slice.error !== null ? { error: slice.error } : {}),
      meta: { action: "split-order", slice: i + 1, totalSlices: sliceCount, filledSize: slice.filledSize, avgFillPrice: slice.avgFillPrice },
    });

    // 4. Let the book refresh
    if (!stopped && remainingUnits > 0n && i < sliceCount - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Average = the venue-reported fill prices, size-weighted; unknown when any filled slice has none.
  const filledSlices = slices.filter(s => s.filledSize !== null && Number(s.filledSize) > 0);
  const priced = filledSlices.length > 0 && filledSlices.every(s => s.avgFillPrice !== null);
  const filledSize = unitsToString(filledUnits, stepSize);
  const filledUsd = priced ? filledSlices.reduce((sum, s) => sum + Number(s.filledSize) * Number(s.avgFillPrice), 0) : filledUnits === 0n ? 0 : null;
  const avgNum = priced && filledUsd !== null ? filledUsd / Number(filledSize) : null;
  const avgPrice = avgNum !== null ? formatComputedPrice(avgNum, tickSize) : null;
  const totalSlippagePct = avgNum !== null ? Math.abs((avgNum - initialBestPrice) / initialBestPrice) * 100 : null;

  const status = slices.some(s => s.status === "unknown") ? "unknown"
    : filledUnits >= totalUnits ? "complete"
    : filledUnits > 0n ? "partial"
    : "failed";

  log(`[SPLIT] Done: ${slices.length} slice(s) | filled ${filledSize}/${totalSize} | avg price: ${avgPrice !== null ? `$${avgPrice}` : "not reported"}`);

  return {
    symbol, side,
    requestedUsd: totalSizeUsd,
    requestedSize: totalSize,
    filledSize,
    filledUsd,
    avgPrice,
    totalSlippagePct,
    slices,
    status,
    runtime: (Date.now() - startedAt) / 1000,
  };
}
