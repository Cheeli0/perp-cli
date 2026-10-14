/**
 * Merged market state (§3): unknown = null; a field the latest frame did not carry keeps its last
 * value; every carried field gets `asOf` = receive time; `changed` lists carried fields whose value
 * differs from the previous one.
 */

import type {
  CodecDirectory, Dec, MarketDirectoryEntry, MarketField, MarketPatch, MarketUpdate, Source, VenueCodec,
} from "./types.js";

interface Row {
  entry: MarketDirectoryEntry;
  values: {
    mark: Dec | null; index: Dec | null; bestBid: Dec | null; bestAsk: Dec | null; last: Dec | null;
    rate: Dec | null; predictedRate: Dec | null; nextFundingTime: number | null;
    openInterest: Dec | null; volume24hNotional: Dec | null;
  };
  intervalKey: string | null;
  venueTs: number | null;
  asOf: Partial<Record<MarketField, number>>;
}

const PATCH_FIELDS = [
  "mark", "index", "bestBid", "bestAsk", "last", "rate", "predictedRate", "nextFundingTime", "openInterest", "volume24hNotional",
] as const;

export class MarketStore {
  private rows = new Map<string, Row>();
  private bySymbol: Map<string, MarketDirectoryEntry>;

  constructor(private codec: VenueCodec, private dir: CodecDirectory) {
    this.bySymbol = new Map(dir.entries.map(e => [e.symbol, e]));
  }

  entry(symbol: string): MarketDirectoryEntry | undefined {
    return this.bySymbol.get(symbol);
  }

  /** Apply one patch; undefined when the symbol is not in the directory (caller reports it). */
  apply(patch: MarketPatch, recvTs: number, source: Source): MarketUpdate | undefined {
    const entry = this.bySymbol.get(patch.symbol);
    if (entry === undefined) return undefined;
    let row = this.rows.get(patch.symbol);
    if (row === undefined) {
      row = {
        entry,
        values: {
          mark: null, index: null, bestBid: null, bestAsk: null, last: null,
          rate: null, predictedRate: null, nextFundingTime: null, openInterest: null, volume24hNotional: null,
        },
        intervalKey: null,
        venueTs: null,
        asOf: {},
      };
      this.rows.set(patch.symbol, row);
    }
    const changed: MarketField[] = [];
    for (const f of PATCH_FIELDS) {
      if (!(f in patch)) continue;
      const v = patch[f];
      if (v === undefined) continue;
      if (row.values[f] !== v) changed.push(f);
      (row.values as Record<string, unknown>)[f] = v;
      row.asOf[f] = recvTs;
    }
    const meta = this.codec.fundingMeta(entry, this.dir);
    const intervalKey = `${meta.rateIntervalHours}|${meta.settlementIntervalHours}|${meta.intervalSource}`;
    if (meta.intervalAsOf !== null) row.asOf.fundingInterval = meta.intervalAsOf;
    if (row.intervalKey !== intervalKey) {
      if (row.intervalKey !== null || meta.rateIntervalHours !== null) changed.push("fundingInterval");
      row.intervalKey = intervalKey;
    }
    if (patch.venueTs !== null) row.venueTs = patch.venueTs;
    const v = row.values;
    return {
      type: "market",
      schema: 1,
      venue: entry.venue,
      dex: entry.dex,
      symbol: entry.symbol,
      venueSymbol: entry.venueSymbol,
      quote: entry.quote,
      canonical: entry.canonical,
      mark: v.mark,
      index: v.index,
      bestBid: v.bestBid,
      bestAsk: v.bestAsk,
      last: v.last,
      funding: {
        rate: v.rate,
        rateKind: meta.rateKind,
        rateSource: meta.rateSource,
        rateIntervalHours: meta.rateIntervalHours,
        settlementIntervalHours: meta.settlementIntervalHours,
        intervalSource: meta.intervalSource,
        nextFundingTime: v.nextFundingTime,
        predictedRate: v.predictedRate,
        marketClosed: meta.marketClosed,
      },
      openInterest: {
        value: v.openInterest,
        unit: this.codec.openInterest.unit,
        sides: this.codec.openInterest.sides,
      },
      volume24hNotional: v.volume24hNotional,
      venueTs: row.venueTs,
      recvTs,
      source,
      changed,
      asOf: { ...row.asOf },
    };
  }
}
