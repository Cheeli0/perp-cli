import { assertCanClosePositions } from "../exchanges/trading-v2.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { resolveAdapterSlippage } from "../exchanges/slippage.js";
import { updateJobState } from "../jobs.js";
import { isIocOutcomeCapable, reportedAvgFillPrice } from "../exchanges/ioc-outcome.js";
import { formatComputedPrice } from "../exchanges/precision.js";
import { venueRateString } from "../utils/numeric.js";

export interface DCAParams {
  symbol: string;
  side: "buy" | "sell";
  amountPerOrder: number; // base size per order
  intervalSec: number;    // seconds between orders
  totalOrders: number;    // how many orders to place (0 = unlimited until stopped)
  priceLimit?: number;    // stop buying above / selling below this price
  maxRuntime?: number;    // max runtime seconds (0 = forever)
}

export interface DCAState {
  ordersPlaced: number;
  totalFilled: number;
  totalCost: number;
  /**
   * Average fill price from the VENUE-reported average fill of every order (reportedAvgFillPrice),
   * never the protection / limit price sent; null when any filled order reported none.
   */
  avgPrice: number | null;
  errors: number;
  startedAt: number;
  running: boolean;
}

export async function runDCA(
  adapter: ExchangeAdapter,
  params: DCAParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<{ ordersPlaced: number; totalFilled: number; avgPrice: number | null; runtime: number }> {
  assertCanClosePositions(adapter, `DCA on ${adapter.name}`);
  const { symbol, side, amountPerOrder, intervalSec, totalOrders } = params;
  const maxRuntime = (params.maxRuntime ?? 0) * 1000;

  const state: DCAState = {
    ordersPlaced: 0,
    totalFilled: 0,
    totalCost: 0,
    avgPrice: null,
    errors: 0,
    startedAt: Date.now(),
    running: true,
  };

  const target = totalOrders > 0 ? `${totalOrders} orders` : "unlimited (Ctrl+C to stop)";
  log(`[DCA] ${side.toUpperCase()} ${amountPerOrder} ${symbol} every ${intervalSec}s | ${target}`);
  if (params.priceLimit) {
    log(`[DCA] Price limit: $${params.priceLimit} (${side === "buy" ? "won't buy above" : "won't sell below"})`);
  }

  // Graceful shutdown
  const shutdown = () => { state.running = false; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let everyOrderPriced = true;
  try {
    while (state.running) {
      // Check if we've reached order limit
      if (totalOrders > 0 && state.ordersPlaced >= totalOrders) {
        log(`[DCA] Reached target of ${totalOrders} orders. Done.`);
        break;
      }

      // Check max runtime
      if (maxRuntime > 0 && Date.now() - state.startedAt > maxRuntime) {
        log(`[DCA] Max runtime reached. Stopping.`);
        break;
      }

      // Check price limit
      if (params.priceLimit) {
        try {
          const markets = await adapter.getMarkets();
          const market = markets.find(m => m.symbol.toUpperCase() === symbol.toUpperCase());
          if (market) {
            const price = parseFloat(market.markPrice);
            if (side === "buy" && price > params.priceLimit) {
              log(`[DCA] Price $${price.toFixed(2)} > limit $${params.priceLimit}. Skipping.`);
              await sleep(intervalSec * 1000);
              continue;
            }
            if (side === "sell" && price < params.priceLimit) {
              log(`[DCA] Price $${price.toFixed(2)} < limit $${params.priceLimit}. Skipping.`);
              await sleep(intervalSec * 1000);
              continue;
            }
          }
        } catch {
          // non-critical, proceed with order
        }
      }

      // Place market order
      try {
        const result = await adapter.marketOrder(symbol, side, String(amountPerOrder), { reduceOnly: false, slippage: resolveAdapterSlippage(adapter, null) }) as Record<string, unknown>;
        state.ordersPlaced++;
        // Filled size: the venue-final IOC outcome when the adapter reports one; else the size sent
        // (marketOrder throws on a definite no-fill / unknown outcome).
        const outcome = isIocOutcomeCapable(adapter) ? adapter.iocOutcomeOf(result) : null;
        const filled = outcome !== null ? Number(outcome.filledSize) : amountPerOrder;
        state.totalFilled = Number(venueRateString(state.totalFilled + filled, "DCA filled total")); // sum without float noise

        // The venue-reported average fill only: the result's `price` is the protection price that was sent.
        const fillPrice = reportedAvgFillPrice(result);
        if (fillPrice === null) everyOrderPriced = false;
        else state.totalCost += filled * Number(fillPrice);
        state.avgPrice = everyOrderPriced && state.totalFilled > 0 ? Number(formatComputedPrice(state.totalCost / state.totalFilled)) : null;

        const progress = totalOrders > 0 ? ` (${state.ordersPlaced}/${totalOrders})` : "";
        log(`[DCA] Order #${state.ordersPlaced}${progress}: ${side} ${filled} ${symbol}${fillPrice !== null ? ` @ $${fillPrice}` : " (fill price not reported)"}${state.avgPrice !== null ? `, avg $${state.avgPrice}` : ""}`);

        // Update job state
        if (jobId) {
          updateJobState(jobId, {
            result: {
              ordersPlaced: state.ordersPlaced,
              totalFilled: state.totalFilled,
              avgPrice: state.avgPrice,
              errors: state.errors,
              runtime: Math.floor((Date.now() - state.startedAt) / 1000),
            },
          });
        }
      } catch (err) {
        state.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        log(`[DCA] Order error: ${msg}`);

        if (state.errors > 10 && state.errors > state.ordersPlaced) {
          log(`[DCA] Too many errors. Stopping.`);
          break;
        }
      }

      // Wait for next interval
      if (state.running && (totalOrders === 0 || state.ordersPlaced < totalOrders)) {
        await sleep(intervalSec * 1000);
      }
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  const runtime = Math.floor((Date.now() - state.startedAt) / 1000);
  log(`[DCA] Done. ${state.ordersPlaced} orders, ${state.totalFilled} filled, avg ${state.avgPrice !== null ? `$${state.avgPrice}` : "not reported by the venue"}, ${state.errors} errors, ${runtime}s`);

  if (jobId) {
    updateJobState(jobId, {
      status: "done",
      result: { ordersPlaced: state.ordersPlaced, totalFilled: state.totalFilled, avgPrice: state.avgPrice, runtime },
    });
  }

  return { ordersPlaced: state.ordersPlaced, totalFilled: state.totalFilled, avgPrice: state.avgPrice, runtime };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
