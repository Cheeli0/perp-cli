/** Shared pure helpers for venue codecs. */

import { toDec } from "../dec.js";
import type { WsErrorCode } from "../errors.js";
import type { DecodedEvent, Dec, MarketField, VenueWsCapabilities } from "../types.js";

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseFrame(text: string): { ok: true; v: unknown } | { ok: false; ev: DecodedEvent } {
  try {
    return { ok: true, v: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, ev: protocolError("Frame is not valid JSON") };
  }
}

export function protocolError(message: string, wire: string | null = null): DecodedEvent {
  return { t: "error", code: "WS_PROTOCOL_ERROR", message, wire, fatal: false, remediation: null };
}

export function venueError(code: WsErrorCode, message: string, wire: string | null, fatal: boolean, remediation: string | null): DecodedEvent {
  return { t: "error", code, message, wire, fatal, remediation };
}

export function unrecognised(venue: string): DecodedEvent {
  return protocolError(`Unrecognised ${venue} frame`);
}

/**
 * A Dec field: absent key → undefined (keep last value); JSON null → null; a decimal string or
 * finite number → Dec; anything else → recorded in `bad` and undefined.
 */
export function readDec(o: Obj, key: string, bad: string[]): Dec | null | undefined {
  if (!(key in o)) return undefined;
  const d = toDec(o[key]);
  if (d === undefined) bad.push(key);
  return d;
}

/** Integer timestamp (ms) field, same absent/null/bad rules; `scale` converts s → ms etc. */
export function readTs(o: Obj, key: string, bad: string[], scale = 1): number | null | undefined {
  if (!(key in o)) return undefined;
  const v = o[key];
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v * scale;
  bad.push(key);
  return undefined;
}

/** Drop undefined keys so `key in patch` means "the frame carried it". */
export function compact<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function badFieldsError(venue: string, wire: string, bad: Array<{ symbol: string; fields: string[] }>): DecodedEvent {
  const list = bad.slice(0, 5).map(b => `${b.symbol}: ${b.fields.join("/")}`).join("; ");
  return protocolError(`${venue} ${wire}: unparseable field value(s) left unchanged (${list}${bad.length > 5 ? "; …" : ""})`, wire);
}

/** Start of the next hour after `ts` (hourly-settling venues; intervalSource "venue-definition"). */
export function nextHour(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000 + 3_600_000;
}

export function capabilities(
  p: {
    testnet: boolean;
    fields: Record<Exclude<MarketField, "rate">, boolean>;
    notes: Record<string, string>;
  },
): VenueWsCapabilities {
  return {
    browser: true, // Phase 0: no WS server checks Origin; REST CORS is `*`
    networks: { mainnet: true, testnet: p.testnet },
    channels: { allMarkets: true, market: true, bbo: false, book: false, trades: false, user: false },
    fields: p.fields,
    notes: {
      bbo: "Not in this release (0.14.4 Phase 2)",
      book: "Not in this release (0.14.5)",
      trades: "Not in this release (0.14.5)",
      user: "Not in this release (0.14.4 Phase 2)",
      ...p.notes,
    },
  };
}
