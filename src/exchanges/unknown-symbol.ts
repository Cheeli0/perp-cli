/**
 * Unknown-symbol handling shared by the adapters' public market-data reads.
 *
 * Several venues answer a read for a market they do not list with an empty success
 * (Pacifica /trades, /kline, /funding_rate/history; Ondo /v1/perps/trades and candles; Aster
 * /fapi/v3/fundingRate — all `200 []`, live 2026-10-14). An empty list must not stand for
 * "no such market": after an empty answer the symbol is checked against the venue's own market
 * directory (getMarkets) — SYMBOL_NOT_FOUND when it is not listed, the empty list when it is
 * (a listed market with no trades / candles in the window is a real empty result).
 */

import { PerpError } from "../errors.js";
import type { ExchangeMarketInfo } from "./interface.js";

/** SYMBOL_NOT_FOUND for `symbol` on `venue`, with the listing command as remediation. */
export function symbolNotFound(venue: string, symbol: string, message?: string): PerpError {
  return new PerpError("SYMBOL_NOT_FOUND", message ?? `${venue} has no market ${symbol.toUpperCase()}`, {
    exchange: venue,
    remediation: `List markets: perp -e ${venue} market list`,
  });
}

/** Directory match: case-insensitive, a "-PERP" display suffix ignored on either side. */
export function listsSymbol(markets: readonly Pick<ExchangeMarketInfo, "symbol">[], symbol: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/-PERP$/, "");
  const want = norm(symbol);
  return markets.some(m => norm(m.symbol) === want);
}

/**
 * `rows` as returned by the venue, unless they are empty and `symbol` is not in the venue's
 * market directory — then SYMBOL_NOT_FOUND. The directory is read only for an empty answer.
 */
export async function nonEmptyOrListed<T>(
  adapter: { readonly name: string; getMarkets(): Promise<Pick<ExchangeMarketInfo, "symbol">[]> },
  symbol: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length > 0) return rows;
  if (!listsSymbol(await adapter.getMarkets(), symbol)) throw symbolNotFound(adapter.name, symbol);
  return rows;
}
