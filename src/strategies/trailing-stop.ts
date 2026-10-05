import type { ExchangeAdapter } from "../exchanges/index.js";
import { assertCanClosePositions } from "../exchanges/trading-v2.js";
import { updateJobState } from "../jobs.js";
import { invalidateCache } from "../cache.js";
import { logExecution } from "../execution-log.js";
import { PerpError } from "../errors.js";
import { closePerpVerified } from "../bot/perp-order.js";
import { isPositionGone } from "../bot/strategies/funding-arb-utils.js";

export interface TrailingStopParams {
  symbol: string;
  trailPct: number;         // e.g. 3 = close when price moves 3% from peak/trough
  intervalSec?: number;     // check interval (default: 5)
  activationPrice?: number; // only start trailing after reaching this price
}

export interface TrailingStopResult {
  triggered: boolean;
  /** position_gone = the position was closed / flipped before the trigger fired (nothing sent). */
  reason: "triggered" | "cancelled" | "no_position" | "position_gone";
  peakPrice?: number;
  triggerPrice?: number;
  changePct?: number;
  positionSide?: string;
  runtime: number; // seconds
}

export async function runTrailingStop(
  adapter: ExchangeAdapter,
  params: TrailingStopParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<TrailingStopResult> {
  const { symbol, trailPct } = params;
  const intervalMs = (params.intervalSec ?? 5) * 1000;
  const activationPrice = params.activationPrice;
  const startedAt = Date.now();

  // Unattended: the close fires later, with nobody watching — refused up front on a gated venue.
  assertCanClosePositions(adapter, `Trailing stop on ${adapter.name}`);

  // Auto-detect position side
  const positions = await adapter.getPositions();
  const pos = positions.find(p => {
    const c = p.symbol.toUpperCase();
    const t = symbol.toUpperCase();
    return c === t || c === `${t}-PERP` || c.replace(/-PERP$/, "") === t;
  });

  if (!pos) {
    log(`[TRAIL] No open position for ${symbol}. Exiting.`);
    return { triggered: false, reason: "no_position", runtime: 0 };
  }

  const positionSide = pos.side;
  const closeSide: "buy" | "sell" = positionSide === "long" ? "sell" : "buy";
  const posSize = pos.size;

  /**
   * At trigger time: re-read the position (it may have shrunk, grown, flipped or closed since
   * start) and close exactly the live size, reduce-only and verified (closePerpVerified: one
   * residual close). Returns the size closed, or null when the position is gone (nothing sent /
   * the venue rejected a reduce-only close of a flat position). An unknown outcome (ORDER_PENDING)
   * or a residual propagates as an error — never resubmitted.
   */
  const closeLive = async (): Promise<string | null> => {
    invalidateCache("acct"); // size the reduce-only close from a fresh read, never a cached position
    const live = (await adapter.getPositions()).find(p => {
      const c = p.symbol.toUpperCase();
      const t = symbol.toUpperCase();
      return (c === t || c === `${t}-PERP` || c.replace(/-PERP$/, "") === t) && p.side === positionSide;
    });
    const liveSize = live === undefined ? null : live.size.replace(/^-/, "");
    if (liveSize === null || !(Number(liveSize) > 0)) return null;
    log(`[TRAIL] Closing ${positionSide} ${liveSize} ${symbol} (live size, reduce-only)...`);
    try {
      const c = await closePerpVerified(adapter, adapter.name, symbol, closeSide, liveSize);
      if (c.residual > 0) {
        throw new PerpError("ORDER_PARTIAL", `trailing stop closed ${c.closed} of ${liveSize} ${symbol}; ${c.residual} still open${c.note !== null ? ` (${c.note})` : ""}`, {
          exchange: adapter.name, remediation: `Do NOT rerun blindly — check the ${symbol} position on ${adapter.name} and close the rest by hand`,
        });
      }
    } catch (e) {
      if (isPositionGone(e)) return null;
      throw e;
    }
    return liveSize;
  };

  log(`[TRAIL] ${symbol} ${positionSide} ${posSize} | Trail: ${trailPct}%${activationPrice ? ` | Activation: $${activationPrice}` : ""}`);

  let peakPrice = 0;
  let activated = !activationPrice;
  let running = true;

  const cleanup = () => { running = false; };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (jobId) {
    updateJobState(jobId, {
      status: "running",
      result: { symbol, positionSide, trailPct, activationPrice },
    });
  }

  try {
    while (running) {
      const markets = await adapter.getMarkets();
      const market = markets.find(m => {
        const c = m.symbol.toUpperCase();
        const t = symbol.toUpperCase();
        return c === t || c === `${t}-PERP` || c.replace(/-PERP$/, "") === t;
      });

      if (!market) {
        log(`[TRAIL] Market data for ${symbol} not found, retrying...`);
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }

      const currentPrice = parseFloat(market.markPrice);

      // Check activation
      if (!activated && activationPrice) {
        if (positionSide === "long" && currentPrice >= activationPrice) {
          activated = true;
          log(`[TRAIL] Activated at $${currentPrice.toFixed(2)} (>= $${activationPrice})`);
        } else if (positionSide === "short" && currentPrice <= activationPrice) {
          activated = true;
          log(`[TRAIL] Activated at $${currentPrice.toFixed(2)} (<= $${activationPrice})`);
        } else {
          log(`[TRAIL] $${currentPrice.toFixed(2)} | Waiting for activation ($${activationPrice})...`);
          await new Promise(r => setTimeout(r, intervalMs));
          continue;
        }
      }

      if (positionSide === "long") {
        if (currentPrice > peakPrice) peakPrice = currentPrice;
        const dropPct = peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0;
        log(`[TRAIL] $${currentPrice.toFixed(2)} | Peak: $${peakPrice.toFixed(2)} | Drop: ${dropPct.toFixed(2)}%`);

        if (dropPct >= trailPct) {
          log(`[TRAIL] TRIGGERED! Price dropped ${dropPct.toFixed(2)}% from peak $${peakPrice.toFixed(2)}`);
          const closedSize = await closeLive();
          if (closedSize === null) {
            log(`[TRAIL] ${symbol} ${positionSide} position is gone — nothing to close. Exiting.`);
            return { triggered: false, reason: "position_gone", peakPrice, positionSide, runtime: (Date.now() - startedAt) / 1000 };
          }
          logExecution({
            type: "market_order", exchange: adapter.name, symbol,
            side: closeSide, size: closedSize, status: "success", dryRun: false,
            meta: { action: "trailing-stop", trailPct, peakPrice, triggerPrice: currentPrice },
          });
          return {
            triggered: true, reason: "triggered",
            peakPrice, triggerPrice: currentPrice, changePct: dropPct,
            positionSide, runtime: (Date.now() - startedAt) / 1000,
          };
        }
      } else {
        // Short: track trough, trigger on rise
        if (peakPrice === 0 || currentPrice < peakPrice) peakPrice = currentPrice;
        const risePct = peakPrice > 0 ? ((currentPrice - peakPrice) / peakPrice) * 100 : 0;
        log(`[TRAIL] $${currentPrice.toFixed(2)} | Trough: $${peakPrice.toFixed(2)} | Rise: ${risePct.toFixed(2)}%`);

        if (risePct >= trailPct) {
          log(`[TRAIL] TRIGGERED! Price rose ${risePct.toFixed(2)}% from trough $${peakPrice.toFixed(2)}`);
          const closedSize = await closeLive();
          if (closedSize === null) {
            log(`[TRAIL] ${symbol} ${positionSide} position is gone — nothing to close. Exiting.`);
            return { triggered: false, reason: "position_gone", peakPrice, positionSide, runtime: (Date.now() - startedAt) / 1000 };
          }
          logExecution({
            type: "market_order", exchange: adapter.name, symbol,
            side: closeSide, size: closedSize, status: "success", dryRun: false,
            meta: { action: "trailing-stop", trailPct, troughPrice: peakPrice, triggerPrice: currentPrice },
          });
          return {
            triggered: true, reason: "triggered",
            peakPrice, triggerPrice: currentPrice, changePct: risePct,
            positionSide, runtime: (Date.now() - startedAt) / 1000,
          };
        }
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
  } finally {
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
  }

  return {
    triggered: false, reason: "cancelled",
    peakPrice: peakPrice || undefined,
    positionSide,
    runtime: (Date.now() - startedAt) / 1000,
  };
}
