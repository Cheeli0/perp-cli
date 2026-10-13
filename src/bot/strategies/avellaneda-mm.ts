import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";
import { calculateATR } from "../indicators.js";
import { PerpError } from "../../errors.js";
import { symbolMatch } from "../../utils.js";

interface AvellanedaMmConfig {
  gamma: number;        // risk aversion γ, per price unit (1/$)
  kappa: number;        // order-book liquidity κ, per price unit (1/$)
  sigma: number;        // volatility override in price units per √second (0 = estimate from ATR)
  maxPosition: number;  // maximum inventory (base)
  timeHorizon: number;  // trading session length T in seconds
  size: number;         // order size per level
}

/**
 * Quotes farther than this from mid are refused (an error, never placed): a guard against a
 * mis-scaled γ / κ / σ (live 2026-10-12: SOL ≈ $109 was quoted at $38.62 — the spread term
 * (2/γ)·ln(1+γ/κ) = 1.29 was multiplied by the mid as if it were a fraction).
 */
export const AVELLANEDA_MAX_QUOTE_DISTANCE = 0.05;

/**
 * Avellaneda–Stoikov (2008) in absolute price units, with T − t in seconds:
 *   r = s − q·γ·σ²·(T − t)
 *   δ = γ·σ²·(T − t) + (2/γ)·ln(1 + γ/κ)      (total bid–ask spread)
 *   bid = r − δ/2, ask = r + δ/2
 * σ in $/√s, γ and κ in 1/$ — every term is then in $. Throws when a quote is more than
 * AVELLANEDA_MAX_QUOTE_DISTANCE from mid or not positive.
 */
export function avellanedaQuotes(o: { mid: number; q: number; gamma: number; kappa: number; sigma: number; secondsLeft: number }): { reservation: number; spread: number; bid: number; ask: number } {
  const { mid, q, gamma, kappa, sigma, secondsLeft } = o;
  for (const [k, v] of Object.entries({ mid, gamma, kappa, sigma, secondsLeft })) {
    if (!Number.isFinite(v) || v <= 0) throw new PerpError("INVALID_PARAMS", `avellaneda-mm: ${k} must be a positive number (got ${v})`);
  }
  if (!Number.isFinite(q)) throw new PerpError("INVALID_PARAMS", `avellaneda-mm: inventory is not a number (${q})`);
  const risk = gamma * sigma ** 2 * secondsLeft;
  const reservation = mid - q * risk;
  const spread = risk + (2 / gamma) * Math.log(1 + gamma / kappa);
  const bid = reservation - spread / 2;
  const ask = reservation + spread / 2;
  const far = Math.max(Math.abs(mid - bid), Math.abs(ask - mid)) / mid;
  if (!(bid > 0) || far > AVELLANEDA_MAX_QUOTE_DISTANCE) {
    throw new PerpError("INVALID_PARAMS",
      `avellaneda-mm: quotes ${bid.toFixed(6)} / ${ask.toFixed(6)} are ${(far * 100).toFixed(1)}% from mid ${mid} (limit ${AVELLANEDA_MAX_QUOTE_DISTANCE * 100}%) — γ=${gamma}, κ=${kappa} (per $), σ=${sigma.toPrecision(4)} $/√s, T−t=${secondsLeft.toFixed(0)}s, q=${q}; nothing was placed`, {
        remediation: "γ and κ are per price unit: raise kappa / lower gamma for a tighter spread, or shorten --param timeHorizon",
      });
  }
  return { reservation, spread, bid, ask };
}

export class AvellanedaMmStrategy implements Strategy {
  readonly name = "avellaneda-mm";

  describe() {
    return {
      description: "Avellaneda-Stoikov optimal market making with inventory-adjusted reservation price (absolute price units; quotes > 5% from mid are refused)",
      params: [
        { name: "gamma", type: "number" as const, required: false, default: 0.1, description: "Risk aversion γ, per price unit (1/$)" },
        { name: "kappa", type: "number" as const, required: false, default: 1.5, description: "Order-book liquidity κ, per price unit (1/$)" },
        { name: "sigma", type: "number" as const, required: false, default: 0, description: "Volatility in $ per √second (0 = estimate from the candles' ATR)" },
        { name: "maxPosition", type: "number" as const, required: true, description: "Maximum position size" },
        { name: "timeHorizon", type: "number" as const, required: false, default: 86400, description: "Session length T in seconds" },
        { name: "size", type: "number" as const, required: true, description: "Order size per level" },
      ],
    };
  }

  private get params(): AvellanedaMmConfig {
    return this._config as unknown as AvellanedaMmConfig;
  }

  private _config: Record<string, unknown> = {};

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    ctx.state.set("sessionStart", Date.now());
    const p = this.params;
    ctx.log(`  [AVELLANEDA-MM] gamma=${p.gamma}, kappa=${p.kappa}, sigma=${p.sigma || "auto"}, maxPos=${p.maxPosition}, T=${p.timeHorizon}s`);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const params = this.params;
    const actions: StrategyAction[] = [{ type: "cancel_all" }];

    const gamma = params.gamma || 0.1;
    const kappa = params.kappa || 1.5;
    const mid = snapshot.price;
    const sigma = estimateSigma(snapshot, params.sigma);

    const sessionStart = (ctx.state.get("sessionStart") as number) ?? Date.now();
    const elapsed = (Date.now() - sessionStart) / 1000;
    const timeHorizon = params.timeHorizon || 86400;
    const secondsLeft = Math.max(timeHorizon - elapsed, 1);

    // Inventory q: the venue position (signed base), never an estimate.
    const pos = (await ctx.adapter.getPositions()).find(p => symbolMatch(p.symbol, ctx.symbol));
    const q = pos === undefined ? 0 : (pos.side === "short" ? -1 : 1) * Math.abs(Number(pos.size));

    const { reservation, spread, bid, ask } = avellanedaQuotes({ mid, q, gamma, kappa, sigma, secondsLeft });

    const size = params.size;
    if (q < params.maxPosition) actions.push({ type: "place_order", side: "buy", price: bid.toFixed(8), size: String(size), orderType: "limit" });
    if (q > -params.maxPosition) actions.push({ type: "place_order", side: "sell", price: ask.toFixed(8), size: String(size), orderType: "limit" });

    if (ctx.tick % 10 === 0) {
      ctx.log(`  [AVELLANEDA-MM] mid=$${mid}, r=$${reservation.toFixed(4)}, spread=$${spread.toFixed(4)}, q=${q}, sigma=${sigma.toPrecision(4)} $/√s, T-t=${secondsLeft.toFixed(0)}s`);
    }
    return actions;
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

/**
 * σ in $/√s: the override, else ATR(14) of the snapshot candles (in $ per candle interval)
 * ÷ √(interval in seconds, from the candle timestamps). Too few candles → throws (never a constant).
 */
export function estimateSigma(snapshot: Pick<EnrichedSnapshot, "klines">, sigmaOverride: number): number {
  if (sigmaOverride > 0) return sigmaOverride;
  const k = [...snapshot.klines].sort((a, b) => a.time - b.time);
  if (k.length < 15) {
    throw new PerpError("PRICE_STALE", `avellaneda-mm: ${k.length} candles — at least 15 are needed to estimate σ (or pass --param sigma=<$ per √s>)`);
  }
  const atr = calculateATR(k.map(c => ({ high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close) })), 14);
  const intervalSec = (k[k.length - 1].time - k[0].time) / (k.length - 1) / 1000;
  const last = atr[atr.length - 1];
  if (!(intervalSec > 0) || !(last > 0)) {
    throw new PerpError("PRICE_STALE", `avellaneda-mm: σ cannot be estimated (ATR ${last}, candle interval ${intervalSec}s)`);
  }
  return last / Math.sqrt(intervalSec);
}

registerStrategy("avellaneda-mm", (_config) => new AvellanedaMmStrategy());
