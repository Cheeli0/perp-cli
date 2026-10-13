/**
 * createVenueStream (§4): directory bootstrap, ref-counted wire subscriptions, dispatch of decoded
 * frames into merged market state, labelled REST refresh, error/state fan-out. Socket lifecycle is in
 * connection.ts; venue specifics are in the codec.
 */

import { defaultCanonicalize } from "./canonical.js";
import { Connection, closedError, type WireLiveness } from "./connection.js";
import { WsError, isPerpError, type WsErrorCode } from "./errors.js";
import { MarketStore } from "./market-state.js";
import { REDACTED, createRedactor, excerpt, type Redactor } from "./redact.js";
import { SubscriptionImpl } from "./subscription.js";
import { defaultVisibility, resolveFetch, resolveTransport } from "./transport.js";
import { UserStore } from "./user-state.js";
import type {
  BboUpdate, BookUpdate, CloseReason, CodecContext, CodecDirectory, ConnectionState, DecodedEvent, MarketDirectoryEntry,
  MarketTarget, MarketUpdate, Network, StreamControl, StreamLog, Subscription, TradeUpdate, UserChannel, UserRef, UserUpdate,
  VenueCodec, VenueStream, VenueStreamOptions, WireSub,
} from "./types.js";

type AnyEvent = MarketUpdate | BboUpdate | BookUpdate | TradeUpdate | UserUpdate;
type Sub = SubscriptionImpl<AnyEvent>;

interface WireState {
  wire: WireSub;
  refs: Set<Sub>;
  reqId: number;
  sentAt: number | null;
  lastAt: number | null;
  acked: boolean;
  firstFrameSeen: boolean;
  /** Sent for a NEW subscription on an already-open socket (not a resubscribe after open). */
  probe: boolean;
  /** Was unacked when the venue dropped the socket with several new channels pending (ambiguous):
   * resubscribed one at a time (as a probe) until acked, so a bad one is isolated. */
  suspect: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
  /** Acked/data on some socket: a later resubscribe is a reconnect (non-replayable channels → gap). */
  everAcked: boolean;
  /** Last venue ordering number seen (bbo); frames at or below it are dropped. Reset on resubscribe. */
  lastSeq: number | null;
}

interface SubMeta {
  symbols: Set<string> | null; // null = all
  wires: string[];
  /** kind:"user": the requested user channels (events of other channels on a shared wire are filtered). */
  userChannels: Set<UserChannel> | null;
}

interface TokenState { token: string; expiresAt: number; refreshAt: number; timer: ReturnType<typeof setTimeout> | null }

const USER_CHANNELS: ReadonlyArray<UserChannel> = ["account", "positions", "orders", "fills"];
const EVENT_CHANNEL: Record<UserUpdate["type"], UserChannel> = { account: "account", positions: "positions", orders: "orders", fill: "fills", fills: "fills" };
/** A handed-out token stays redacted until its expiry plus this margin. */
const TOKEN_REDACT_MARGIN_MS = 15 * 60_000;
/** authToken() retry on a transient failure: backoff 1 s → 30 s, while the current token is still valid. */
const TOKEN_RETRY_BASE_MS = 1000;
const TOKEN_RETRY_MAX_MS = 30_000;
/** With no valid token left (reconnect after expiry), a transient failure is retried this many times. */
const TOKEN_RETRIES_WITHOUT_VALID = 5;

/** A subscribe that the venue answers by dropping the socket (HL) is attributed within this window. */
const BAD_SUBSCRIBE_WINDOW_MS = 1500;
const DEFAULT_BUFFER = 1024;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function userRefProblem(venue: string, ref: UserRef): string | null {
  if (ref === null || typeof ref !== "object") return "not an object";
  if (ref.venue !== venue) return `venue is "${String((ref as { venue?: unknown }).venue)}", expected "${venue}"`;
  switch (ref.venue) {
    case "hyperliquid": return EVM_ADDRESS.test(ref.address) ? null : "address is not a 0x EVM address";
    case "pacifica": return typeof ref.account === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ref.account) ? null : "account is not a base58 Solana address";
    case "lighter":
    case "lighter-rh": return Number.isInteger(ref.accountIndex) && ref.accountIndex >= 0 ? null : "accountIndex is not a non-negative integer";
    case "arcus":
      if (!EVM_ADDRESS.test(ref.address)) return "address is not a 0x EVM address";
      return ref.subaccount === null || (Number.isInteger(ref.subaccount) && ref.subaccount >= 0) ? null : "subaccount is not null or a non-negative integer";
    default: return null;
  }
}

function isBrowserLike(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return g.window !== undefined && g.document !== undefined;
}

export function createVenueStream(codec: VenueCodec, opts: VenueStreamOptions = {}): VenueStream {
  const venue = codec.venue;
  const network: Network = opts.network === undefined ? "mainnet" : opts.network;
  // Resolved at call time (never at module load); Node 20 without a transport → INVALID_PARAMS.
  const transport = resolveTransport(opts, venue);
  const fetchFn = resolveFetch(opts, venue);
  const clock = opts.clock === undefined ? () => Date.now() : opts.clock;
  const baseRedact: Redactor = createRedactor(codec.secretKeys, codec.secretUrlPatterns);
  /** Exact secrets handed to the library (auth tokens) are redacted wherever they would appear. */
  const liveSecrets: Array<{ secret: string; until: number }> = [];
  const redact: Redactor = (s: string) => {
    let out = baseRedact(s);
    for (const { secret } of liveSecrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    return out;
  };
  const bufferSize = opts.buffer === undefined ? DEFAULT_BUFFER : opts.buffer.size;
  if (!Number.isInteger(bufferSize) || bufferSize < 1) {
    throw new WsError("INVALID_PARAMS", `${venue}: buffer.size must be a positive integer (got ${String(bufferSize)})`, {
      exchange: venue, remediation: "Pass buffer: { size: n } with n ≥ 1, or omit it (default 1024)",
    });
  }
  const url = codec.url(network);
  const restUrl = codec.restUrl(network);

  const subs = new Map<Sub, SubMeta>();
  const wires = new Map<string, WireState>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const reportedUnknown = new Set<string>();
  let nextReqId = 1;
  let closed = false;
  let directory: Promise<CodecDirectory> | null = null;
  let dir: CodecDirectory | null = null;
  let store: MarketStore | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Non-fatal problems found while building the directory; delivered to each new subscription. */
  let directoryWarnings: string[] = [];
  const userStore = new UserStore(venue);
  let userRef: UserRef | null = null;
  const tokens = new Map<string, TokenState>();
  const tokenFetches = new Map<string, Promise<TokenState>>();
  const tokenRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Running acquireToken loops per purpose, with everyone waiting on them. */
  const tokenLoops = new Map<string, Array<{ onOk: (t: TokenState) => void; onFail: (err: WsError) => void }>>();

  function log(level: StreamLog["level"], event: string, message: string, details?: Record<string, unknown>): void {
    if (opts.logger === undefined) return;
    const entry: StreamLog = { ts: clock(), venue, level, event, message: redact(message) };
    if (details !== undefined) entry.details = JSON.parse(redact(JSON.stringify(details))) as Record<string, unknown>;
    try { opts.logger(entry); } catch { /* a throwing logger must not break the stream */ }
  }

  function errorEvent(code: WsErrorCode, message: string, remediation: string | null, raw: string | null, fatal: boolean): StreamControl {
    return {
      type: "error", venue, code, message: redact(message),
      remediation: remediation === null ? null : redact(remediation),
      raw: raw === null ? null : excerpt(redact, raw), fatal,
    };
  }

  function wsError(code: WsErrorCode, message: string, remediation?: string, details?: Record<string, unknown>): WsError {
    return new WsError(code, redact(message), {
      exchange: venue,
      ...(remediation !== undefined ? { remediation: redact(remediation) } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }

  const connection: Connection | null = url === null ? null : new Connection({
    venue,
    url,
    transport,
    clock,
    redact,
    ping: codec.ping,
    reconnect: opts.reconnect === undefined ? { maxAttempts: null, baseMs: 1000, maxMs: 30_000 } : opts.reconnect,
    newConnectionsPerMin: Math.min(codec.limits.newConnectionsPerMin, opts.budget?.newConnectionsPerMin === undefined ? Infinity : opts.budget.newConnectionsPerMin),
    outboundPerMin: codec.limits.outboundPerMin,
    visibility: opts.visibility === undefined ? defaultVisibility() : opts.visibility,
    random: Math.random,
  }, {
    onOpen: () => {
      const now = clock();
      for (const w of wires.values()) {
        const g = w.wire.gaps?.onReconnect;
        if (w.everAcked && g !== undefined) {
          for (const ch of g) {
            emitGap(w, ch, "reconnected; the venue does not replay this channel");
            if (ch === "orders") dispatchUser(w, userStore.clearOrders(now)); // pre-disconnect orders are unknown now
          }
        }
        w.firstFrameSeen = false;
        w.lastAt = null;
        if (w.suspect) { w.sentAt = null; continue; } // probed one at a time below
        sendSubscribe(w, now, false);
      }
      probeNextSuspect();
    },
    // Ack timers belong to one socket: a reconnect delay must not fail a pending subscription.
    onSocketDown: () => { for (const w of wires.values()) clearAckTimer(w); },
    onText: (text, recvTs) => onText(text, recvTs),
    onUnreadableFrame: () => {
      const ev = errorEvent("WS_PROTOCOL_ERROR", "Unreadable (non-text) frame", null, null, false);
      log("warn", "protocol-error", ev.type === "error" ? ev.message : "");
      broadcast(ev);
    },
    onState: (s) => {
      for (const l of stateListeners) {
        try { l(s); } catch (e) { log("warn", "listener-error", `onState listener threw: ${e instanceof Error ? e.message : String(e)}`); }
      }
      broadcast({ type: "state", venue, state: s });
      if (s.status === "closed" && s.reason.code !== "CLIENT_CLOSE") {
        const err = wsError(s.reason.code, s.reason.message,
          s.reason.remediation === null ? undefined : s.reason.remediation);
        for (const sub of Array.from(subs.keys())) dropSub(sub, err);
      }
    },
    onUnexpectedClose: (reason, opened) => handleBadSubscribeClose(reason, opened),
    liveness: () => {
      const out: WireLiveness[] = [];
      for (const w of wires.values()) {
        if (w.sentAt === null) continue;
        out.push({ key: w.wire.key, staleAfterMs: w.wire.staleAfterMs, lastAt: Math.max(w.sentAt, w.lastAt === null ? 0 : w.lastAt) });
      }
      return out;
    },
    log,
  });

  function broadcast(e: StreamControl): void {
    for (const sub of subs.keys()) sub.emit(e);
  }

  function ctx(): CodecContext {
    return {
      network,
      fetch: fetchFn,
      restUrl: restUrl as string,
      hip3Dexes: opts.hip3Dexes === undefined ? [] : opts.hip3Dexes,
      canonicalize: opts.canonicalize === undefined ? defaultCanonicalize : opts.canonicalize,
      clock,
    };
  }

  function loadDirectory(): Promise<CodecDirectory> {
    if (directory !== null) return directory;
    if (restUrl === null) {
      return Promise.reject(wsError("CAPABILITY_UNSUPPORTED", `${venue} has no REST host on ${network} for the market directory`));
    }
    const p = codec.loadDirectory(ctx()).then((d) => {
      dir = d;
      store = new MarketStore(codec, d);
      directoryWarnings = d.warnings === undefined ? [] : d.warnings;
      log("info", "directory", `market directory loaded (${d.entries.length} markets)`);
      for (const w of directoryWarnings) log("warn", "directory-warning", w);
      if (!closed) startRefresh();
      return d;
    });
    directory = p;
    p.catch((e: unknown) => {
      directory = null; // a later subscribe retries
      log("error", "directory-failed", e instanceof Error ? e.message : String(e));
    });
    return p;
  }

  function startRefresh(): void {
    const r = codec.refresh;
    if (r === null || refreshTimer !== null || closed) return;
    refreshTimer = setInterval(() => {
      if (dir === null || closed) return;
      const d = dir;
      r.run(ctx(), d).then(
        (warnings) => {
          log("info", "labelled-refresh", `${r.source} refreshed`);
          for (const w of warnings) {
            log("warn", "labelled-refresh-warning", w);
            broadcast(errorEvent("EXCHANGE_ERROR", w, "The venue REST response had malformed rows; affected markets keep a null interval", null, false));
          }
        },
        (e: unknown) => {
          const msg = `${r.source} refresh failed: ${e instanceof Error ? e.message : String(e)}; interval values keep their previous asOf`;
          log("warn", "labelled-refresh-failed", msg);
          broadcast(errorEvent(e instanceof WsError ? e.structured.code : "EXCHANGE_ERROR", msg, "Retried on the next refresh", null, false));
        },
      );
    }, r.everyMs);
  }

  function sendSubscribe(w: WireState, now: number, probe: boolean): void {
    if (connection === null || !connection.isOpen) return;
    let auth: string | null = null;
    const need = w.wire.auth;
    if (need !== undefined) {
      const t = tokens.get(need.purpose);
      if (t === undefined || clock() >= t.expiresAt) {
        // Not subscribed on this socket until the token arrives: no ack timer, no liveness, no unsubscribe.
        clearAckTimer(w);
        w.acked = false;
        w.sentAt = null;
        w.lastSeq = null;
        acquireToken(need,
          () => { if (!closed && wires.get(w.wire.key) === w && connection.isOpen && w.sentAt === null) sendSubscribe(w, clock(), probe); },
          (err) => failWire(w, err));
        return;
      }
      auth = t.token;
      // A refresh that came due while offline was skipped: send with the still-valid token, refresh now.
      if (clock() >= t.refreshAt && t.timer === null) Promise.resolve().then(() => refreshToken(need));
    }
    w.lastSeq = null;
    w.reqId = nextReqId++;
    w.sentAt = now;
    w.acked = false;
    w.probe = probe;
    connection.send(codec.encodeSubscribe(w.wire, w.reqId, auth));
    armAckTimeout(w);
  }

  function failWire(w: WireState, err: WsError): void {
    if (w.refs.size === 0) return;
    log("error", "wire-failed", err.message, { wire: w.wire.key });
    for (const sub of Array.from(w.refs)) dropSub(sub, err);
  }

  function dispatchUser(w: WireState, u: UserUpdate, only?: Sub): void {
    const ch = EVENT_CHANNEL[u.type];
    for (const sub of only === undefined ? w.refs : [only]) {
      const meta = subs.get(sub);
      if (meta !== undefined && meta.userChannels !== null && meta.userChannels.has(ch)) sub.emit(u);
    }
  }

  function emitGap(w: WireState, channel: "fills" | "orders", why: string): void {
    log("warn", "gap", `${w.wire.key}: ${channel} ${why} → refetch-required`);
    for (const sub of w.refs) {
      const meta = subs.get(sub);
      if (meta === undefined || meta.userChannels === null || !meta.userChannels.has(channel)) continue;
      sub.emit({ type: "gap", venue, channel, symbol: null, expected: null, got: null, action: "refetch-required" });
    }
  }

  // ── auth tokens (CredentialProvider.authToken; re-called at 80 % of the TTL) ──

  /**
   * authToken() failures: a structured non-retryable error from the provider (e.g. PASSPHRASE_REQUIRED,
   * WS_AUTH_FAILED) is definite; anything else (network, signer hiccup) is transient (details.transient).
   */
  function toAuthError(e: unknown): WsError {
    if (e instanceof WsError && e.structured.code === "WS_AUTH_FAILED") return e;
    const definite = isPerpError(e) && (e as { structured: { retryable?: unknown } }).structured.retryable === false;
    return wsError("WS_AUTH_FAILED", `${venue} authToken() failed: ${e instanceof Error ? e.message : String(e)}`,
      "Check the credential provider (token for the right account / API key; a read-only ro: token in browsers)",
      definite ? undefined : { transient: true });
  }

  function usesPurpose(purpose: string): boolean {
    for (const w of wires.values()) if (w.wire.auth !== undefined && w.wire.auth.purpose === purpose) return true;
    return false;
  }

  /**
   * getToken with retry on transient failures while a valid token remains (or a few times without one).
   * ONE loop per purpose: later callers (reconnects, the refresh timer) join the running loop instead of
   * starting another. The loop stops quietly once no channel uses the purpose any more.
   */
  function acquireToken(need: { purpose: string; maxTtlSec: number }, onOk: (t: TokenState) => void, onFail: (err: WsError) => void): void {
    const waiting = tokenLoops.get(need.purpose);
    if (waiting !== undefined) { waiting.push({ onOk, onFail }); return; }
    tokenLoops.set(need.purpose, [{ onOk, onFail }]);
    const settle = (f: (cb: { onOk: (t: TokenState) => void; onFail: (err: WsError) => void }) => void): void => {
      const list = tokenLoops.get(need.purpose);
      tokenLoops.delete(need.purpose);
      if (list !== undefined) for (const cb of list) f(cb);
    };
    const attempt = (n: number): void => {
      getToken(need).then(t => settle(cb => cb.onOk(t)), (e: unknown) => {
        const err = toAuthError(e);
        if (closed) { tokenLoops.delete(need.purpose); return; }
        const delay = Math.min(TOKEN_RETRY_MAX_MS, TOKEN_RETRY_BASE_MS * Math.pow(2, n));
        const cur = tokens.get(need.purpose);
        const stillValid = cur !== undefined && clock() + delay < cur.expiresAt;
        const transient = err.structured.details?.transient === true;
        if (!transient || !(stillValid || n < TOKEN_RETRIES_WITHOUT_VALID)) { settle(cb => cb.onFail(err)); return; }
        const msg = `${err.message}; retrying in ${delay} ms${stillValid ? " (current token still valid)" : ""}`;
        log("warn", "auth-token-retry", msg);
        for (const w of wires.values()) {
          if (w.wire.auth === undefined || w.wire.auth.purpose !== need.purpose) continue;
          for (const sub of w.refs) sub.emit(errorEvent("WS_AUTH_FAILED", msg, "Retried automatically; fails once the token expires", null, false));
        }
        const timer = setTimeout(() => {
          tokenRetryTimers.delete(timer);
          if (closed) return;
          if (!usesPurpose(need.purpose)) {
            tokenLoops.delete(need.purpose);
            log("info", "auth-token-retry-stopped", `${need.purpose}: no channel uses this token any more`);
            return;
          }
          attempt(n + 1);
        }, delay);
        tokenRetryTimers.add(timer);
      });
    };
    attempt(0);
  }

  function getToken(need: { purpose: string; maxTtlSec: number }): Promise<TokenState> {
    const have = tokens.get(need.purpose);
    if (have !== undefined && clock() < have.refreshAt) return Promise.resolve(have);
    const inflight = tokenFetches.get(need.purpose);
    if (inflight !== undefined) return inflight;
    const p = (async (): Promise<TokenState> => {
      const provider = opts.credentials;
      if (provider === undefined || provider.authToken === undefined) {
        throw wsError("WS_AUTH_FAILED", `${venue}: ${need.purpose} needs an auth token but the credential provider has no authToken()`,
          "Pass credentials.authToken (Lighter: a read-only ro: token is recommended in browsers)");
      }
      let r: { token: string; expiresAt: number };
      try {
        r = await provider.authToken({ purpose: need.purpose, maxTtlSec: need.maxTtlSec });
      } catch (e) {
        throw toAuthError(e);
      }
      const now = clock();
      if (r === null || typeof r !== "object" || typeof r.token !== "string" || r.token === "" || typeof r.expiresAt !== "number" || !(r.expiresAt > now)) {
        throw wsError("WS_AUTH_FAILED", `${venue} authToken() returned no usable token (need { token, expiresAt: epoch ms in the future })`);
      }
      for (let i = liveSecrets.length - 1; i >= 0; i--) if (liveSecrets[i].until < now) liveSecrets.splice(i, 1);
      liveSecrets.push({ secret: r.token, until: r.expiresAt + TOKEN_REDACT_MARGIN_MS });
      const old = tokens.get(need.purpose);
      if (old !== undefined && old.timer !== null) clearTimeout(old.timer);
      const refreshAt = now + Math.floor(0.8 * (r.expiresAt - now));
      const st: TokenState = { token: r.token, expiresAt: r.expiresAt, refreshAt, timer: null };
      if (!closed) st.timer = setTimeout(() => { st.timer = null; refreshToken(need); }, refreshAt - now);
      tokens.set(need.purpose, st);
      log("info", "auth-token", `${need.purpose} token obtained (refresh in ${refreshAt - now} ms)`);
      return st;
    })();
    tokenFetches.set(need.purpose, p);
    p.then(() => tokenFetches.delete(need.purpose), () => tokenFetches.delete(need.purpose));
    return p;
  }

  /** At 80 % TTL: fetch a new token, then resubscribe every channel that uses it. */
  function refreshToken(need: { purpose: string; maxTtlSec: number }): void {
    if (closed) return;
    const users = () => Array.from(wires.values()).filter(w => w.wire.auth !== undefined && w.wire.auth.purpose === need.purpose);
    if (users().length === 0) { tokens.delete(need.purpose); return; }
    // Offline: nothing to resubscribe. The reconnect's sendSubscribe uses the token while valid (and
    // refreshes then), or fetches a new one once it expired.
    if (connection === null || !connection.isOpen) return;
    if (tokenLoops.has(need.purpose)) return; // a refresh (or reconnect fetch) is already running
    acquireToken(need,
      () => {
        for (const w of users()) {
          if (connection === null || !connection.isOpen || w.sentAt === null) continue;
          connection.send(codec.encodeUnsubscribe(w.wire, nextReqId++));
          w.firstFrameSeen = false;
          sendSubscribe(w, clock(), false);
        }
        log("info", "auth-token-refreshed", `${need.purpose}: resubscribed with a fresh token`);
      },
      (err) => { for (const w of users()) failWire(w, err); },
    );
  }

  /** No ack and no data within the wire's staleAfterMs → pending subscriptions fail (WS_PROTOCOL_ERROR). */
  function armAckTimeout(w: WireState): void {
    clearAckTimer(w);
    const reqId = w.reqId;
    const ms = w.wire.staleAfterMs === null ? codec.staleAfterMs : w.wire.staleAfterMs;
    w.ackTimer = setTimeout(() => {
      w.ackTimer = null;
      if (closed || connection === null || !connection.isOpen || wires.get(w.wire.key) !== w || w.reqId !== reqId || w.acked) return;
      const msg = `${venue}: no acknowledgement or data for ${w.wire.key} within ${ms} ms of subscribing`;
      log("error", "ack-timeout", msg);
      const err = wsError("WS_PROTOCOL_ERROR", msg, "The venue ignored the subscription; check the channel/symbol or retry later");
      // A timed-out probe stops being a suspect (its active subs keep it); let the next one go.
      const wasSuspect = w.suspect;
      w.suspect = false;
      for (const sub of Array.from(w.refs)) {
        if (sub.status === "pending") dropSub(sub, err);
        else sub.emit(errorEvent("WS_PROTOCOL_ERROR", msg, null, null, false));
      }
      if (wasSuspect) probeNextSuspect();
    }, ms);
  }

  function clearAckTimer(w: WireState): void {
    if (w.ackTimer !== null) { clearTimeout(w.ackTimer); w.ackTimer = null; }
  }

  function maybeReady(sub: Sub): void {
    const meta = subs.get(sub);
    if (meta === undefined || sub.status !== "pending") return;
    if (meta.wires.every(k => wires.get(k)?.acked === true)) sub.markActive();
  }

  function markAcked(w: WireState): void {
    if (w.acked) return;
    w.acked = true;
    w.everAcked = true;
    w.probe = false;
    clearAckTimer(w);
    if (w.suspect) { w.suspect = false; probeNextSuspect(); }
    for (const sub of w.refs) maybeReady(sub);
  }

  function findWire(ev: { wire: string | null; reqId: number | null }): WireState | undefined {
    if (ev.wire !== null) return wires.get(ev.wire);
    if (ev.reqId !== null) for (const w of wires.values()) if (w.reqId === ev.reqId) return w;
    return undefined;
  }

  function onText(text: string, recvTs: number): void {
    if (dir === null || store === null) {
      broadcast(errorEvent("WS_PROTOCOL_ERROR", "Frame received before the market directory loaded", null, text, false));
      return;
    }
    let events: DecodedEvent[];
    try {
      events = codec.decode(text, dir, recvTs);
    } catch (e) {
      events = [{ t: "error", code: "WS_PROTOCOL_ERROR", message: `Codec failed: ${e instanceof Error ? e.message : String(e)}`, wire: null, fatal: false, remediation: null }];
    }
    for (const ev of events) handleEvent(ev, text, recvTs);
  }

  function handleEvent(ev: DecodedEvent, text: string, recvTs: number): void {
    switch (ev.t) {
      case "pong":
        connection?.notePong();
        return;
      case "ignore":
        return;
      case "ack": {
        if (ev.unsubscribe) return;
        const w = findWire(ev);
        if (w === undefined) {
          log("info", "late-ack", "ack for a channel that is no longer subscribed", { wire: ev.wire, reqId: ev.reqId });
          return;
        }
        markAcked(w);
        return;
      }
      case "error": {
        const w = ev.wire !== null ? wires.get(ev.wire) : ev.reqId !== undefined ? findWire({ wire: null, reqId: ev.reqId }) : undefined;
        const e = errorEvent(ev.code, ev.message, ev.remediation, text, ev.fatal);
        log(ev.fatal ? "error" : "warn", "protocol-error", e.type === "error" ? e.message : "", { wire: ev.wire });
        if (w === undefined) {
          // Not attributable to a subscribed channel: report it, but it ends nothing.
          broadcast(e.type === "error" && e.fatal ? { ...e, fatal: false } : e);
          return;
        }
        if (ev.fatal) {
          const err = wsError(ev.code, ev.message, ev.remediation === null ? undefined : ev.remediation);
          for (const sub of Array.from(w.refs)) dropSub(sub, err);
        } else {
          for (const sub of w.refs) sub.emit(e);
        }
        return;
      }
      case "user": {
        const w = wires.get(ev.wire);
        if (w === undefined) {
          log("info", "late-frame", `frame for ${ev.wire} after its unsubscribe (in flight)`);
          return;
        }
        w.lastAt = recvTs;
        markAcked(w);
        connection?.markHealthy();
        for (const d of ev.deltas) {
          const r = userStore.apply(d, recvTs);
          // The replay snapshot does not reach back to fills seen before: fills in between may be missing.
          if (r.fillsGap) emitGap(w, "fills", "replayed snapshot does not overlap the fills seen before (outage longer than the replay window)");
          for (const u of r.updates) dispatchUser(w, u);
        }
        return;
      }
      case "bbo": {
        const w = wires.get(ev.wire);
        if (w === undefined) {
          log("info", "late-frame", `frame for ${ev.wire} after its unsubscribe (in flight)`);
          return;
        }
        w.lastAt = recvTs;
        markAcked(w);
        connection?.markHealthy();
        if (ev.seq !== null) {
          if (w.lastSeq !== null && ev.seq <= w.lastSeq) return; // out of order / duplicate (sequences are non-contiguous: no gap)
          w.lastSeq = ev.seq;
        }
        const entry = (store as MarketStore).entry(ev.symbol);
        if (entry === undefined) {
          for (const sub of w.refs) sub.emit(errorEvent("WS_PROTOCOL_ERROR", `bbo for ${ev.symbol} which is not in the market directory`, null, null, false));
          return;
        }
        const u: BboUpdate = {
          type: "bbo", schema: 1, venue, dex: entry.dex, symbol: entry.symbol,
          bid: ev.bid, bidSize: ev.bidSize, ask: ev.ask, askSize: ev.askSize, venueTs: ev.venueTs, recvTs,
        };
        for (const sub of w.refs) sub.emit(u);
        return;
      }
      case "market": {
        const w = wires.get(ev.wire);
        if (w === undefined) {
          log("info", "late-frame", `frame for ${ev.wire} after its unsubscribe (in flight)`);
          return;
        }
        const s = store as MarketStore;
        w.lastAt = recvTs;
        markAcked(w);
        connection?.markHealthy();
        const source = w.firstFrameSeen ? "ws" : "snapshot";
        w.firstFrameSeen = true;
        const unknown: string[] = [];
        for (const patch of ev.patches) {
          const u = s.apply(patch, recvTs, source);
          if (u === undefined) {
            if (!reportedUnknown.has(patch.symbol)) { reportedUnknown.add(patch.symbol); unknown.push(patch.symbol); }
            continue;
          }
          for (const sub of w.refs) {
            const meta = subs.get(sub);
            if (meta !== undefined && (meta.symbols === null || meta.symbols.has(u.symbol))) sub.emit(u);
          }
        }
        if (unknown.length > 0) {
          const msg = `${unknown.length} market(s) on ${ev.wire} are not in the market directory (new listing?): ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ", …" : ""}`;
          const e = errorEvent("WS_PROTOCOL_ERROR", msg, "Recreate the stream to reload the market directory", null, false);
          log("warn", "unknown-market", msg);
          for (const sub of w.refs) sub.emit(e);
        }
        if (connection !== null && connection.state.status === "stale") connection.evaluate();
        return;
      }
    }
  }

  /**
   * HL drops the socket (no error frame) on an invalid subscribe. Blame a subscription only when the
   * socket closed within the window after exactly ONE new channel was subscribed on the already-open
   * socket and is still unacked. Resubscribes after (re)open and ambiguous cases are ordinary reconnects.
   * Returns true when no channel is left (the stream went idle; no reconnect).
   */
  function handleBadSubscribeClose(reason: CloseReason, opened: boolean): boolean {
    if (!codec.closesOnBadSubscribe || !opened) return false;
    const now = clock();
    const suspects = Array.from(wires.values()).filter(w => w.probe && !w.acked && w.sentAt !== null && now - w.sentAt <= BAD_SUBSCRIBE_WINDOW_MS);
    if (suspects.length > 1) {
      // Ambiguous: resubscribe these one at a time after reconnecting so a bad one is isolated.
      for (const w of suspects) w.suspect = true;
      log("warn", "bad-subscribe-ambiguous", `${venue} dropped the socket with ${suspects.length} new channels pending; probing them one at a time`,
        { channels: suspects.map(w => w.wire.key) });
      return false;
    }
    if (suspects.length !== 1) return false;
    const w = suspects[0];
    const err = wsError("INVALID_PARAMS",
      `${venue} closed the socket right after subscribing to ${w.wire.key} (the venue drops the socket on an invalid subscription)`,
      "Check the symbol against stream.markets(); the other subscriptions reconnect");
    log("error", "bad-subscribe", err.message, { wsCode: reason.wsCode });
    for (const sub of Array.from(w.refs)) dropSub(sub, err);
    return wires.size === 0;
  }

  /** Send the next held suspect (if none is in flight) as a probe. */
  function probeNextSuspect(): void {
    if (connection === null || !connection.isOpen) return;
    const held = Array.from(wires.values()).filter(w => w.suspect);
    if (held.length === 0 || held.some(w => w.sentAt !== null)) return;
    sendSubscribe(held[0], clock(), true);
  }

  function releaseWires(sub: Sub): void {
    const meta = subs.get(sub);
    subs.delete(sub);
    if (meta === undefined) return;
    let releasedSuspect = false;
    for (const key of meta.wires) {
      const w = wires.get(key);
      if (w === undefined) continue;
      w.refs.delete(sub);
      if (w.refs.size > 0) continue;
      clearAckTimer(w);
      wires.delete(key);
      if (w.suspect) releasedSuspect = true;
      if (connection !== null && connection.isOpen && w.sentAt !== null) {
        connection.send(codec.encodeUnsubscribe(w.wire, nextReqId++));
      }
    }
    if (wires.size === 0 && connection !== null && !closed && connection.state.status !== "idle" && connection.state.status !== "closed") {
      connection.closeIdle();
    }
    if (releasedSuspect) probeNextSuspect(); // the released one may have been the probe in flight
  }

  function dropSub(sub: Sub, err: WsError): void {
    releaseWires(sub);
    sub.fail(err);
  }

  async function activate(sub: Sub, target: MarketTarget): Promise<void> {
    if (closed) throw closedError(venue);
    terminalCheck();
    if (connection === null) {
      throw wsError("CAPABILITY_UNSUPPORTED", `${venue} has no WebSocket on ${network}`,
        codec.capabilities.notes[`network:${network}`] === undefined ? undefined : codec.capabilities.notes[`network:${network}`]);
    }
    if (target.kind === "market") {
      const supported = (c: string) => c === "market" || (c === "bbo" && codec.capabilities.channels.bbo);
      const extra = target.channels.filter(c => !supported(c));
      if (extra.length > 0 || target.channels.length === 0) {
        throw wsError("CAPABILITY_UNSUPPORTED",
          target.channels.length === 0 ? "kind \"market\" needs at least one channel" : `${venue} channel(s) ${extra.join(", ")} are not available in this release`,
          "Use channels \"market\" / \"bbo\" (book and trades arrive in 0.14.5)");
      }
    }
    if (target.kind === "user") checkUserTarget(target.channels);
    const d = await loadDirectory();
    if (closed) throw closedError(venue);
    terminalCheck();
    if (sub.closed) return;
    let list: WireSub[];
    let wanted: string[] | null = null;
    if (target.kind === "user") {
      const ref = await resolveUser();
      list = (codec.user as NonNullable<VenueCodec["user"]>).wires(ref, target.channels, d);
      for (const w of list) if (w.auth !== undefined) await getToken(w.auth); // auth fails before any socket opens
      if (closed) throw closedError(venue);
      if (sub.closed) return;
    } else {
      const known = new Set(d.entries.map(e => e.symbol));
      wanted = target.kind === "allMarkets" ? (target.symbols === undefined ? null : target.symbols) : [target.symbol];
      if (wanted !== null) {
        const missing = wanted.filter(s => !known.has(s));
        if (missing.length > 0) {
          throw wsError("INVALID_PARAMS", `${venue}: unknown symbol(s) ${missing.slice(0, 20).join(", ")}`,
            venue === "hyperliquid" ? "Use stream.markets() symbols; HIP-3 markets need opts.hip3Dexes" : "Use stream.markets() symbols");
        }
      }
      list = codec.wiresFor(target, d, opts.staleAfterMs === undefined ? null : opts.staleAfterMs);
    }
    const fresh = list.filter(w => !wires.has(w.key));
    const allowed = Math.min(codec.limits.subscriptionsPerSocket, opts.budget?.maxSubscriptions === undefined ? Infinity : opts.budget.maxSubscriptions);
    if (opts.budget?.maxSockets !== undefined && opts.budget.maxSockets < 1) {
      throw wsError("SUBSCRIPTION_LIMIT", `${venue} needs 1 socket; budget.maxSockets is ${opts.budget.maxSockets}`, "Raise budget.maxSockets", { needed: 1, allowed: opts.budget.maxSockets });
    }
    if (wires.size + fresh.length > allowed) {
      throw wsError("SUBSCRIPTION_LIMIT", `${venue}: ${wires.size + fresh.length} wire subscriptions needed, ${allowed} allowed`,
        "Unsubscribe something, narrow the symbols, or raise budget.maxSubscriptions (≤ the venue limit)", { needed: wires.size + fresh.length, allowed });
    }
    const perGroup = codec.limits.perGroup;
    if (perGroup !== undefined) {
      for (const [group, cap] of Object.entries(perGroup)) {
        const needed = Array.from(wires.values()).filter(w => w.wire.group === group).length + fresh.filter(w => w.group === group).length;
        if (needed > cap) {
          throw wsError("SUBSCRIPTION_LIMIT", `${venue}: ${needed} "${group}" channels needed on one connection, ${cap} allowed`,
            `Unsubscribe some ${group} channels`, { needed, allowed: cap });
        }
      }
    }
    subs.set(sub, {
      symbols: wanted === null ? null : new Set(wanted),
      wires: list.map(w => w.key),
      userChannels: target.kind === "user" ? new Set(target.channels) : null,
    });
    const now = clock();
    for (const w of list) {
      let st = wires.get(w.key);
      if (st === undefined) {
        st = {
          wire: w, refs: new Set(), reqId: 0, sentAt: null, lastAt: null, acked: false, firstFrameSeen: false,
          probe: false, suspect: false, ackTimer: null, everAcked: false, lastSeq: null,
        };
        wires.set(w.key, st);
        sendSubscribe(st, now, true);
      }
      st.refs.add(sub);
    }
    for (const w of directoryWarnings) sub.emit(errorEvent("EXCHANGE_ERROR", w, null, null, false));
    if (target.kind === "user") {
      for (const w of list) {
        const g = w.gaps?.onSubscribe;
        if (g === undefined) continue;
        for (const ch of g) {
          if (!target.channels.includes(ch)) continue;
          sub.emit({ type: "gap", venue, channel: ch, symbol: null, expected: null, got: null, action: "refetch-required" });
          const st = wires.get(w.key);
          // No venue snapshot: tell this subscriber the current (incomplete) open-order set.
          if (ch === "orders" && st !== undefined) dispatchUser(st, userStore.currentOrders(clock()), sub);
        }
      }
    }
    maybeReady(sub);
    connection.ensureOpen();
  }

  function checkUserTarget(channels: UserChannel[]): void {
    if (codec.user === null) {
      const note = codec.capabilities.notes.user;
      throw wsError("CAPABILITY_UNSUPPORTED", `${venue} user channels are not available in this release`, note === undefined ? undefined : note);
    }
    if (codec.user.inPageSecrets && isBrowserLike() && opts.allowInPageSecrets !== true) {
      throw wsError("CAPABILITY_UNSUPPORTED", `${venue} user channels need a signing secret in the page`,
        "Pass allowInPageSecrets: true to accept that trade-off, or run the stream server-side (perp-cli/ws/node)");
    }
    const bad = channels.filter(c => !USER_CHANNELS.includes(c));
    if (channels.length === 0 || bad.length > 0) {
      throw wsError("INVALID_PARAMS", channels.length === 0 ? "kind \"user\" needs at least one channel" : `unknown user channel(s) ${bad.join(", ")}`,
        `Use ${USER_CHANNELS.join(" / ")}`);
    }
    if (opts.credentials === undefined) {
      throw wsError("WS_AUTH_FAILED", `${venue} user channels need opts.credentials (CredentialProvider.user())`,
        "Pass credentials: { user: async () => ({ venue, … }) }; the library never holds keys");
    }
  }

  /** CredentialProvider.user(), once per stream (wire keys assume one account). */
  async function resolveUser(): Promise<UserRef> {
    if (userRef !== null) return userRef;
    const provider = opts.credentials;
    if (provider === undefined) throw wsError("WS_AUTH_FAILED", `${venue}: no credential provider`);
    let ref: UserRef;
    try {
      ref = await provider.user();
    } catch (e) {
      throw toAuthError(e);
    }
    const problem = userRefProblem(venue, ref);
    if (problem !== null) throw wsError("INVALID_PARAMS", `${venue} credentials.user(): ${problem}`, "Return the UserRef shape documented for this venue");
    if (userRef === null) userRef = ref;
    return userRef;
  }

  /** The connection stopped for good (reconnects exhausted): new subscriptions fail with its reason. */
  function terminalCheck(): void {
    if (connection === null || connection.state.status !== "closed") return;
    const r = connection.state.reason;
    if (r.code === "CLIENT_CLOSE") throw closedError(venue);
    throw wsError(r.code, `${venue} stream is closed: ${r.message}`, r.remediation === null ? "Create a new stream" : r.remediation);
  }

  function subscribe(target: MarketTarget): Subscription<AnyEvent> {
    const sub: Sub = new SubscriptionImpl<AnyEvent>(venue, bufferSize, async (s) => {
      releaseWires(s);
      s.end();
    }, (e) => log("warn", "listener-error", `subscription listener threw: ${e instanceof Error ? e.message : String(e)}`),
    (s, err) => { log("error", "overflow", err.message); dropSub(s, err); });
    activate(sub, target).catch((e: unknown) => {
      const err = e instanceof WsError ? e : wsError("EXCHANGE_ERROR", e instanceof Error ? e.message : String(e));
      log("warn", "subscribe-rejected", err.message, { code: err.structured.code });
      dropSub(sub, err);
    });
    return sub;
  }

  const stream: VenueStream = {
    venue,
    network,
    capabilities: codec.capabilities,
    staleAfterMs: opts.staleAfterMs === undefined ? codec.staleAfterMs : opts.staleAfterMs,
    get state(): ConnectionState {
      if (connection === null) {
        return { status: "closed", reason: { code: "CAPABILITY_UNSUPPORTED", message: `${venue} has no WebSocket on ${network}`, wsCode: null, remediation: null } };
      }
      return connection.state;
    },
    subscribe: subscribe as unknown as VenueStream["subscribe"],
    onState(cb) {
      stateListeners.add(cb);
      return () => { stateListeners.delete(cb); };
    },
    async markets(): Promise<MarketDirectoryEntry[]> {
      const d = await loadDirectory();
      return d.entries.slice();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
      for (const t of tokens.values()) if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; }
      for (const t of tokenRetryTimers) clearTimeout(t);
      tokenRetryTimers.clear();
      tokenLoops.clear();
      for (const w of wires.values()) clearAckTimer(w);
      wires.clear();
      connection?.close(); // subscribers see state → closed (CLIENT_CLOSE) first
      for (const sub of Array.from(subs.keys())) {
        subs.delete(sub);
        sub.end();
      }
      stateListeners.clear();
    },
  };
  return stream;
}
