/**
 * Arb state (per network, src/arb/state.ts) of spot-perp pairs opened by a bot (spot-perp-arb,
 * funding-arb). The bot records its entries like `arb exec` does, so `arb status` confirms the
 * pair and `arb close <SYM>` finds it. The network is the spot adapter's own (the bot's -n).
 * An entry is matched on symbol + spot venue + perp venue.
 */
import { addPosition, getPositions, removePositionEntry, updatePositionEntry, type ArbPositionState } from "../../arb/state.js";
import { spotNetworkOf, spotPairSymbol } from "../../exchanges/spot-factory.js";
import { SPOT_PERP_TOKEN_MAP, type SpotAdapter } from "../../exchanges/spot-interface.js";
import { getVenue } from "../../exchanges/venue.js";

/** A bot spot-perp pair: spot base symbol, spot venue, perp venue (bot adapter names). */
export interface SpotPerpPair { symbol: string; spotExchange: string; perpExchange: string }

/** Arb-state symbol of a spot base: the perp name (UBTC → BTC), as `arb status` matches it. */
export function stateSymbol(base: string): string {
  const upper = base.toUpperCase();
  return SPOT_PERP_TOKEN_MAP[upper] ?? upper;
}

/** This pair's spot-perp entry in the arb state (same symbol, spot venue and perp venue), or undefined. */
export function stateEntryOf(spot: SpotAdapter, pos: SpotPerpPair): ArbPositionState | undefined {
  const sym = stateSymbol(pos.symbol);
  const spotId = getVenue(pos.spotExchange).id;
  const perpId = getVenue(pos.perpExchange).id;
  return getPositions(spotNetworkOf(spot)).find(p => p.mode === "spot-perp" && p.symbol.toUpperCase() === sym
    && (p.spotExchange ?? p.longExchange) === spotId && p.shortExchange === perpId);
}

/** A failed state write never undoes the trade: logged (with `tag`, e.g. "[SPA]") with the manual close command. */
export function stateWriteFailed(tag: string, what: string, pos: SpotPerpPair, err: unknown, log: (msg: string) => void): void {
  log(`  ${tag} WARNING: arb state ${what} failed for ${pos.symbol} (${err instanceof Error ? err.message : String(err)}) — \`perp arb status\` may not confirm it; close with: perp arb close ${stateSymbol(pos.symbol)} --spot-exch ${pos.spotExchange} --perp-exch ${pos.perpExchange}`);
}

/** The opened pair's actual legs: sizes filled, the venue-reported fill prices (null = not reported). */
export interface SpotPerpEntry extends SpotPerpPair {
  id: string;
  entryTime: number;
  /** Annualized funding spread / rate at entry (%). */
  entrySpread: number;
  spotSize: number;
  perpSize: number;
  spotAvgPrice: number | null;
  perpEntryPrice: number | null;
}

/**
 * Record an opened pair as a spot-perp arb-state entry (a failed write is logged, never thrown —
 * including the RISK_VIOLATION of an existing entry of the symbol on other venues / another
 * mode, which is never overwritten).
 */
export function recordSpotPerpEntry(spot: SpotAdapter, e: SpotPerpEntry, tag: string, log: (msg: string) => void): void {
  try {
    const net = spotNetworkOf(spot);
    const now = new Date(e.entryTime).toISOString();
    addPosition(net, {
      id: e.id, symbol: stateSymbol(e.symbol),
      longExchange: getVenue(e.spotExchange).id, shortExchange: getVenue(e.perpExchange).id,
      longSize: e.spotSize, shortSize: e.perpSize,
      entryTime: now, entrySpread: e.entrySpread,
      entryLongPrice: e.spotAvgPrice, entryShortPrice: e.perpEntryPrice,
      accumulatedFunding: 0, lastCheckTime: now,
      mode: "spot-perp", spotExchange: getVenue(e.spotExchange).id, spotSymbol: spotPairSymbol(getVenue(e.spotExchange), net, e.symbol),
    });
  } catch (err) { stateWriteFailed(tag, "entry", e, err, log); }
}

/**
 * Close recorded in the arb state: entry removed (remaining null) or its legs set to the
 * still-hedged remainder. A pair the state does not hold for these venues (e.g. recovered from
 * the venues) is left alone. A failed write is logged, never thrown.
 */
export function recordSpotPerpClose(spot: SpotAdapter, pos: SpotPerpPair, remaining: string | null, tag: string, log: (msg: string) => void): void {
  try {
    const entry = stateEntryOf(spot, pos);
    if (entry === undefined) return;
    // Keyed by symbol + venues + mode: never another pair of the same symbol.
    if (remaining === null) removePositionEntry(spotNetworkOf(spot), entry);
    else updatePositionEntry(spotNetworkOf(spot), entry, { longSize: Number(remaining), shortSize: Number(remaining) });
  } catch (err) {
    stateWriteFailed(tag, remaining === null ? "removal" : "update", pos, err, log);
  }
}
