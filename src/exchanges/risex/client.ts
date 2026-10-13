/**
 * RISEx REST transport.
 *
 * Every response is `{data, request_id}` on success or `{error:{code, message}, request_id}` on
 * failure, where `code` is a gRPC status name ("InvalidArgument", "FailedPrecondition",
 * "Unauthenticated", "ResourceExhausted", "Internal", "Unavailable", …) and the message may carry a
 * decoded contract revert ("FailedPrecondition: PlaceOrder reverted: SignerNotAuthorized(address)").
 *
 * Reads (GET) map to EXCHANGE_UNREACHABLE / EXCHANGE_ERROR / RATE_LIMITED. Writes (POST) are
 * NEVER retried and classify their outcome:
 *   - no connection at all                          → not sent (definite, `sent: false`)
 *   - 4xx gRPC rejection (InvalidArgument, FailedPrecondition, Unauthenticated, NotFound,
 *     PermissionDenied, OutOfRange, AlreadyExists)  → definite rejection (`sent: false` /
 *     ORDER_REJECTED) with the decoded error name
 *   - 429 ResourceExhausted                         → RATE_LIMITED, definite (`sent: false`)
 *   - timeout, reset, 5xx (E0701 ChainTransactionFailed, E0702 SequencerUnavailable, …),
 *     an unreadable body                            → outcome UNKNOWN (RisexSendUnknown)
 */

import { PerpError, extractErrorMessage, isConnectFailure } from "../../errors.js";
import { acquireRate, rateLimitedError } from "../rate-limiter.js";
import type { RateLimitPolicy } from "../venue.js";

export const RISEX_HTTP_TIMEOUT_MS = 30_000;

/** gRPC codes that are a definite refusal of the request (nothing executed). */
const DEFINITE_REJECT_CODES: ReadonlySet<string> = new Set([
  "InvalidArgument", "FailedPrecondition", "Unauthenticated", "NotFound", "PermissionDenied", "OutOfRange", "AlreadyExists",
]);

export interface RisexErrorBody { code: string; message: string }

/** Decoded contract error name in a revert message ("… reverted: InvalidNonceIndex(uint8) => (208)" → "InvalidNonceIndex"). */
export function revertNameOf(message: string): string | null {
  const m = /reverted:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(message);
  return m ? m[1] : null;
}

/** The send of a write could not be classified: it may have executed. Carries the cause for the caller's reconciliation. */
export class RisexSendUnknown extends Error {
  constructor(readonly what: string, readonly cause: unknown, readonly status: number | null) {
    super(`${what}: outcome unknown — ${extractErrorMessage(cause)}`);
    this.name = "RisexSendUnknown";
  }
}

function errorBodyOf(parsed: unknown): RisexErrorBody | null {
  const e = (parsed as { error?: unknown } | null)?.error;
  if (e === null || typeof e !== "object") return null;
  const code = (e as { code?: unknown }).code;
  const message = (e as { message?: unknown }).message;
  return { code: typeof code === "string" ? code : "Unknown", message: typeof message === "string" ? message : JSON.stringify(e) };
}

function readError(path: string, status: number, body: RisexErrorBody | null, text: string): PerpError {
  const msg = body !== null ? `${body.code}: ${body.message}` : `HTTP ${status} ${text.slice(0, 200)}`;
  if (status === 404 || body?.code === "NotFound") {
    return new PerpError("EXCHANGE_ERROR", `RISEx ${path}: ${msg}`, { exchange: "risex", status });
  }
  if (body?.code === "InvalidArgument") {
    return new PerpError("INVALID_PARAMS", `RISEx ${path}: ${msg}`, { exchange: "risex", status });
  }
  if (status >= 500 || body?.code === "Unavailable" || body?.code === "Internal") {
    return new PerpError("EXCHANGE_UNREACHABLE", `RISEx ${path}: ${msg}`, { exchange: "risex", status });
  }
  return new PerpError("EXCHANGE_ERROR", `RISEx ${path}: ${msg}`, { exchange: "risex", status });
}

export class RisexClient {
  constructor(
    readonly restUrl: string,
    private readonly rateLimit: RateLimitPolicy,
    private readonly rateKey: string,
  ) {}

  private url(path: string, query?: Record<string, string | number | null | undefined>): string {
    const u = new URL(this.restUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** GET → `data`. */
  async get<T>(path: string, query?: Record<string, string | number | null | undefined>): Promise<T> {
    await acquireRate(this.rateKey, this.rateLimit, path);
    let res: Response;
    try {
      res = await fetch(this.url(path, query), { method: "GET", signal: AbortSignal.timeout(RISEX_HTTP_TIMEOUT_MS) });
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `RISEx ${path}: ${extractErrorMessage(e)}`, { exchange: "risex" });
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `RISEx ${path}: response body unreadable (${extractErrorMessage(e)})`, { exchange: "risex" });
    }
    if (res.status === 429) throw rateLimitedError("risex", res.headers.get("retry-after"), text);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const err = errorBodyOf(parsed);
    if (!res.ok || err !== null) throw readError(path, res.status, err, text);
    const data = (parsed as { data?: unknown } | undefined)?.data;
    if (data === undefined || data === null) {
      throw new PerpError("EXCHANGE_ERROR", `RISEx ${path}: response has no data`, { exchange: "risex", status: res.status });
    }
    return data as T;
  }

  /**
   * POST a write. Returns `data` on success. Definite refusals throw a PerpError with
   * `details.sent === false`; anything that may have executed throws RisexSendUnknown.
   */
  async post<T>(path: string, body: unknown, what: string): Promise<T> {
    await acquireRate(this.rateKey, this.rateLimit, path);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RISEX_HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      if (isConnectFailure(e)) {
        throw new PerpError("EXCHANGE_UNREACHABLE", `RISEx ${what}: could not connect — nothing was sent`, { exchange: "risex", sent: false });
      }
      throw new RisexSendUnknown(`RISEx ${what}`, e, null);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new RisexSendUnknown(`RISEx ${what}`, e, res.status);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const err = errorBodyOf(parsed);
    if (res.status === 429 || err?.code === "ResourceExhausted") {
      const r = rateLimitedError("risex", res.headers.get("retry-after"), text);
      throw new PerpError("RATE_LIMITED", `RISEx ${what} refused: ${err !== null ? err.message : "rate limited"}`, {
        ...(r.structured.details ?? {}), exchange: "risex", sent: false,
        remediation: "Nothing was executed. Wait, then retry (RISEx also applies a per-address transaction quota: +1 per $5 traded)",
      });
    }
    if (err !== null && res.status >= 400 && res.status < 500 && DEFINITE_REJECT_CODES.has(err.code)) {
      const revert = revertNameOf(err.message);
      throw new PerpError("ORDER_REJECTED", `RISEx ${what} rejected: ${err.code}: ${err.message}`, {
        exchange: "risex", sent: false, grpcCode: err.code, ...(revert !== null ? { revert } : {}),
      });
    }
    if (!res.ok || err !== null || parsed === undefined) {
      throw new RisexSendUnknown(`RISEx ${what}`, new Error(err !== null ? `${err.code}: ${err.message}` : `HTTP ${res.status} ${text.slice(0, 200)}`), res.status);
    }
    const data = (parsed as { data?: unknown }).data;
    if (data === undefined || data === null) throw new RisexSendUnknown(`RISEx ${what}`, new Error("response has no data"), res.status);
    return data as T;
  }
}
