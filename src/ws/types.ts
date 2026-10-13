/**
 * perp-cli/ws public types (plan ws-0.14.4 §4). @experimental through 0.14.x: breaking changes
 * only in a minor bump; every event carries `schema: 1`.
 *
 * Null rules (§3): unknown = null. A field the venue never sent is null; a field the latest frame
 * did not carry keeps its last value with a per-field `asOf`. `Dec` = the venue's JSON value as a
 * string (a JSON string verbatim, a JSON number via String(value) — precision bounded by JSON
 * parsing). The one documented exception is Lighter's WS funding, sent in PERCENT per hour and
 * converted to a fraction by an exact decimal shift (no float).
 */

import type { Network, VenueId } from "./ids.js";
import type { WsErrorCode } from "./errors.js";

export type { Network, VenueId } from "./ids.js";
export type Dec = string;

// ── Transport / fetch (injectable; resolved lazily inside createVenueStream) ──

export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string; wasClean?: boolean }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ── Connection state ──

export interface CloseReason {
  code: WsErrorCode | "CLIENT_CLOSE";
  message: string; // redacted
  wsCode: number | null;
  remediation: string | null;
}

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "live"; since: number; sockets: number }
  | { status: "stale"; since: number; silentMs: number; channel: string | null }
  | { status: "reconnecting"; attempt: number; inMs: number; reason: CloseReason }
  | { status: "closed"; reason: CloseReason };

// ── Canonicalization ──

export type Canonicalize = (
  venue: VenueId,
  m: { venueSymbol: string; dex: string | null; base: string; quote: string | null },
) => string | null;

// ── Events ──

export type Source = "ws" | "snapshot" | `rest:${string}` | "venue-definition";
export type RateKind = "lastSettled" | "accruing" | "predicted";

export interface MarketDirectoryEntry {
  venue: VenueId;
  dex: string | null;
  symbol: string;
  venueSymbol: string;
  base: string;
  quote: string | null;
  canonical: string | null;
  rateIntervalHours: number | null;
  settlementIntervalHours: number | null;
  source: Source;
}

export type MarketField =
  | "mark" | "index" | "bestBid" | "bestAsk" | "last"
  | "rate" | "predictedRate" | "nextFundingTime" | "fundingInterval"
  | "openInterest" | "volume24hNotional";

export interface FundingState {
  rate: Dec | null;
  rateKind: RateKind | null;
  rateSource: Source | null;
  rateIntervalHours: number | null;
  settlementIntervalHours: number | null;
  intervalSource: Source | null;
  nextFundingTime: number | null;
  /** Always kind "predicted". */
  predictedRate: Dec | null;
  /** QFEX out of hours → rate null + true. null when the venue has no such concept. */
  marketClosed: boolean | null;
}

export interface MarketUpdate {
  type: "market";
  schema: 1;
  venue: VenueId;
  dex: string | null;
  symbol: string;
  venueSymbol: string;
  quote: string | null;
  canonical: string | null;
  mark: Dec | null;
  index: Dec | null;
  bestBid: Dec | null;
  bestAsk: Dec | null;
  last: Dec | null;
  funding: FundingState;
  openInterest: { value: Dec | null; unit: "base" | "usd" | null; sides: "one" | "both" | null };
  volume24hNotional: Dec | null;
  venueTs: number | null;
  recvTs: number;
  source: Source;
  changed: ReadonlyArray<MarketField>;
  asOf: Partial<Record<MarketField, number>>;
}

export interface BboUpdate {
  type: "bbo"; schema: 1; venue: VenueId; dex: string | null; symbol: string;
  bid: Dec | null; bidSize: Dec | null; ask: Dec | null; askSize: Dec | null; venueTs: number | null; recvTs: number;
}
export interface BookUpdate {
  type: "book"; schema: 1; venue: VenueId; symbol: string; bids: [Dec, Dec][]; asks: [Dec, Dec][];
  seq: string | null; venueTs: number | null; recvTs: number; source: Source; depth: number;
}
export interface TradeUpdate {
  type: "trade"; schema: 1; venue: VenueId; symbol: string; price: Dec; size: Dec;
  side: "buy" | "sell" | null; tradeId: string | null; venueTs: number | null; recvTs: number;
}

export type StreamControl =
  | { type: "state"; venue: VenueId; state: ConnectionState }
  | {
    type: "gap"; venue: VenueId; channel: string; symbol: string | null;
    expected: string | null; got: string | null; action: "resnapshot" | "refetch-required";
  }
  | {
    type: "error"; venue: VenueId; code: WsErrorCode; message: string; remediation: string | null;
    /** Redacted excerpt (≤ 200 chars) of the offending frame, or null. */
    raw: string | null;
    fatal: boolean;
  };

export interface StreamLog {
  ts: number;
  venue: VenueId;
  level: "info" | "warn" | "error";
  event: string;
  message: string; // redacted
  details?: Record<string, unknown>;
}

// ── Capability matrix (static, §6) ──

export interface VenueWsCapabilities {
  /** true = works from a browser page (Origin/CORS checked, Phase 0); "in-page-secrets" = needs allowInPageSecrets. */
  browser: boolean | "in-page-secrets";
  networks: Record<Network, boolean>;
  channels: { allMarkets: boolean; market: boolean; bbo: boolean; book: boolean; trades: boolean; user: boolean };
  /** Market fields this venue publishes over WS (or via a labelled REST source). false → always null. */
  fields: Record<Exclude<MarketField, "rate">, boolean>;
  /** Why a field or channel is null / unsupported. */
  notes: Record<string, string>;
}

// ── Stream ──

export type MarketTarget =
  | { kind: "allMarkets"; symbols?: string[] }
  | { kind: "market"; symbol: string; channels: Array<"market" | "bbo" | "book" | "trades"> };

export interface VenueStreamOptions {
  network?: Network;
  /** hyperliquid: HIP-3 dexes to include. Default [] = native only. */
  hip3Dexes?: string[] | "all";
  /** Default: globalThis.WebSocket, resolved at call time (perp-cli/ws/node supplies `ws`). */
  transport?: WsFactory;
  /** Default: globalThis.fetch, resolved at call time. */
  fetch?: FetchLike;
  canonicalize?: Canonicalize;
  /** ≤ venue limits. */
  budget?: { maxSubscriptions?: number; maxSockets?: number; newConnectionsPerMin?: number };
  /** Overrides the per-venue default for every public channel. */
  staleAfterMs?: number;
  /** Default: document.visibilityState when present, else none. */
  visibility?: { hidden(): boolean; onChange(cb: () => void): () => void } | null;
  /** Default { maxAttempts: null, baseMs: 1000, maxMs: 30000 }. */
  reconnect?: { maxAttempts: number | null; baseMs: number; maxMs: number };
  /** Async-iterator buffer per subscription (default 1024). */
  buffer?: { size: number };
  /** Receives redacted entries only. */
  logger?: (e: StreamLog) => void;
  clock?: () => number;
}

export interface Subscription<E> extends AsyncIterable<E | StreamControl> {
  /** Unbuffered callback. Returns an unsubscribe-from-callback function. */
  on(cb: (e: E | StreamControl) => void): () => void;
  readonly status: "pending" | "active" | "rejected" | "closed";
  /** Resolves once every wire channel is acknowledged; rejects with a WsError. */
  readonly ready: Promise<void>;
  /** The wire unsubscribe is sent only when the ref-count reaches 0. */
  unsubscribe(): Promise<void>;
}

export interface VenueStream {
  readonly venue: VenueId;
  readonly network: Network;
  readonly state: ConnectionState;
  readonly capabilities: VenueWsCapabilities;
  subscribe(t: { kind: "allMarkets"; symbols?: string[] }): Subscription<MarketUpdate>;
  subscribe(t: { kind: "market"; symbol: string; channels: Array<"market" | "bbo" | "book" | "trades"> }): Subscription<MarketUpdate | BboUpdate | BookUpdate | TradeUpdate>;
  onState(cb: (s: ConnectionState) => void): () => void;
  /** The market directory (REST bootstrap, loaded once). */
  markets(): Promise<MarketDirectoryEntry[]>;
  /** Venue `staleAfterMs` of the all-market channel (used by the funding comparator). */
  readonly staleAfterMs: number;
  close(): Promise<void>;
}

// ── Codec contract (pure; one per venue) ──

/** A wire subscription (one venue channel). `key` is unique per venue. */
export interface WireSub {
  key: string;
  /** Silence beyond this → `stale`; 2× → forced reconnect. null = no stale check. */
  staleAfterMs: number | null;
  params: Record<string, unknown>;
}

/** A partial market patch: a key present = the frame carried it (its value may be null). */
export interface MarketPatch {
  symbol: string;
  venueTs: number | null;
  mark?: Dec | null;
  index?: Dec | null;
  bestBid?: Dec | null;
  bestAsk?: Dec | null;
  last?: Dec | null;
  rate?: Dec | null;
  predictedRate?: Dec | null;
  nextFundingTime?: number | null;
  openInterest?: Dec | null;
  volume24hNotional?: Dec | null;
}

export type DecodedEvent =
  | { t: "market"; wire: string; patches: MarketPatch[] }
  | { t: "ack"; wire: string | null; reqId: number | null; unsubscribe: boolean }
  | { t: "pong" }
  /** An allowlisted, documented control frame with nothing to do (e.g. "connected"). */
  | { t: "ignore"; what: string }
  | {
    t: "error"; code: WsErrorCode; message: string; wire: string | null; fatal: boolean; remediation: string | null;
    /** The request id the error answers (venues that echo it, e.g. Aster). */
    reqId?: number;
  };

export interface CodecDirectory {
  entries: MarketDirectoryEntry[];
  /** Codec-private lookup data (e.g. HL positional universes, Lighter market ids). */
  data: unknown;
  /** Non-fatal problems in the bootstrap responses (e.g. malformed rows), surfaced as error events. */
  warnings?: string[];
}

export interface CodecContext {
  network: Network;
  fetch: FetchLike;
  restUrl: string;
  hip3Dexes: string[] | "all";
  canonicalize: Canonicalize;
  clock: () => number;
}

/** Per-symbol funding metadata a codec attaches (static or from a labelled REST source). */
export interface FundingMeta {
  rateKind: RateKind | null;
  rateSource: Source | null;
  rateIntervalHours: number | null;
  settlementIntervalHours: number | null;
  intervalSource: Source | null;
  /** When a labelled REST interval was fetched; null for a static (venue-definition) interval. */
  intervalAsOf: number | null;
  marketClosed: boolean | null;
}

export interface LabelledRefresh {
  /** e.g. "rest:/fapi/v3/fundingInfo" */
  source: `rest:${string}`;
  everyMs: number;
  /** Re-fetch and apply into the codec's directory data; throws WsError on failure; resolves to warnings. */
  run(ctx: CodecContext, dir: CodecDirectory): Promise<string[]>;
}

export interface VenueCodec {
  readonly venue: VenueId;
  readonly capabilities: VenueWsCapabilities;
  /** Wire URL, or null (network unsupported → CAPABILITY_UNSUPPORTED). */
  url(network: Network): string | null;
  restUrl(network: Network): string | null;
  /** Redaction: secret JSON keys and URL path/query patterns. */
  readonly secretKeys: readonly string[];
  readonly secretUrlPatterns: readonly RegExp[];
  /** App-level ping, or null (server protocol pings only). */
  readonly ping: { message: string; everyMs: number } | null;
  /** Venue limits. */
  readonly limits: {
    subscriptionsPerSocket: number;
    newConnectionsPerMin: number;
    outboundPerMin: number;
  };
  /** true → the venue drops the socket (no error frame) on an invalid subscribe (HL). */
  readonly closesOnBadSubscribe: boolean;
  readonly staleAfterMs: number;
  readonly openInterest: { unit: "base" | "usd" | null; sides: "one" | "both" | null };
  loadDirectory(ctx: CodecContext): Promise<CodecDirectory>;
  readonly refresh: LabelledRefresh | null;
  fundingMeta(entry: MarketDirectoryEntry, dir: CodecDirectory): FundingMeta;
  /** Wire channels for a target; throws WsError(INVALID_PARAMS / CAPABILITY_UNSUPPORTED). */
  wiresFor(target: MarketTarget, dir: CodecDirectory, staleOverrideMs: number | null): WireSub[];
  encodeSubscribe(w: WireSub, reqId: number): string;
  encodeUnsubscribe(w: WireSub, reqId: number): string;
  /** Pure decode of one text frame. Throws nothing: problems are `error` events. */
  decode(text: string, dir: CodecDirectory, recvTs: number): DecodedEvent[];
}
