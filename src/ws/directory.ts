/**
 * Labelled REST bootstrap (§3 REST uses (a) directory/metadata and (d) labelled field sources).
 * Every failure is a WsError; there is no fallback value.
 */

import { WsError } from "./errors.js";
import type { FetchLike, VenueId } from "./types.js";

export async function fetchJson(
  fetch: FetchLike,
  venue: VenueId,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<unknown> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new WsError("EXCHANGE_UNREACHABLE", `${venue} REST ${pathOf(url)} unreachable: ${e instanceof Error ? e.message : String(e)}`, {
      exchange: venue,
      remediation: "Check network access to the venue REST host (and CORS in a browser), then subscribe again",
    });
  }
  if (!res.ok) {
    throw new WsError(res.status === 429 ? "RATE_LIMITED" : "EXCHANGE_ERROR", `${venue} REST ${pathOf(url)} returned HTTP ${res.status}`, {
      exchange: venue,
      remediation: res.status === 429 ? "Wait and subscribe again (REST rate limit)" : "Retry later; the venue REST endpoint failed",
    });
  }
  try {
    return await res.json();
  } catch {
    throw new WsError("EXCHANGE_ERROR", `${venue} REST ${pathOf(url)} returned a non-JSON body`, { exchange: venue });
  }
}

export function badShape(venue: VenueId, what: string): WsError {
  return new WsError("EXCHANGE_ERROR", `${venue} ${what}`, {
    exchange: venue,
    remediation: "The venue response shape changed; report it (perp-cli/ws cannot build the market directory)",
  });
}

function pathOf(url: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(url);
  return m !== null && m[1] !== undefined ? m[1] : url;
}
