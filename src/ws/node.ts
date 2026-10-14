/**
 * perp-cli/ws/node (also published as @hypurrquant/perp-ws/node) — everything from the browser entry
 * plus a `ws`-based transport. `createVenueStream` here defaults `transport` to nodeTransport.
 *
 * `ws` is used even on Node ≥ 22 (which has a global WebSocket) for the inbound maxPayload cap,
 * protocol ping/pong and Node 20 support. In @hypurrquant/perp-ws it is an OPTIONAL peer dependency,
 * loaded lazily: importing this entry never fails; creating a stream / transport without `ws` installed
 * throws INVALID_PARAMS with the install remediation. (Node ≥ 22 without `ws`: use the browser entry.)
 *
 * @experimental 0.15.x (stable from 0.16.0 after consumer sign-off)
 */

import { createRequire } from "node:module";
import type WebSocket from "ws";
import { WsError } from "./errors.js";
import { createVenueStream as createBrowserStream } from "./stream.js";
import type { VenueCodec, VenueStream, VenueStreamOptions, WsFactory, WsLike } from "./types.js";

export * from "./index.js";

type WsModule = typeof WebSocket;
let wsModule: WsModule | null = null;

/** Load the `ws` package on first use (resolved from this file, i.e. the consumer's node_modules). */
function loadWs(): WsModule {
  if (wsModule !== null) return wsModule;
  try {
    wsModule = createRequire(import.meta.url)("ws") as WsModule;
  } catch (e) {
    if ((e as { code?: unknown }).code !== "MODULE_NOT_FOUND") throw e;
    throw new WsError("INVALID_PARAMS", "The /node entry needs the `ws` package (an optional peer dependency), and it is not installed", {
      remediation: "npm install ws@^8.21.0 — or, on Node ≥ 22 / in a browser, import the browser entry (global WebSocket) or pass opts.transport",
    });
  }
  return wsModule;
}

/**
 * Default cap on one inbound message (bytes). `ws` defaults to 100 MiB; the largest real public frames
 * measured are ~120 KB (Hyperliquid allDexsAssetCtxs) and ~147 KB (Lighter market_stats/all snapshot),
 * so 16 MiB leaves >100x headroom while bounding memory per socket. An oversized message is dropped:
 * `ws` emits an error (code WS_ERR_UNSUPPORTED_MESSAGE_LENGTH), sends close 1009 to the server and the
 * local close fires as 1006. The stream reports it as a WS_PROTOCOL_ERROR close reason and reconnects;
 * 3 such closes within 10 min fail the socket's subscriptions with WS_PROTOCOL_ERROR.
 */
export const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;

export interface NodeTransportOptions {
  /** Max bytes per inbound message (default DEFAULT_MAX_PAYLOAD = 16 MiB). Must be a positive integer. */
  maxPayload?: number;
}

/** Build a `ws` adapter with the browser WebSocket handler shape (text frames as strings). */
export function createNodeTransport(opts: NodeTransportOptions = {}): WsFactory {
  const maxPayload = opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
  if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0) {
    throw new RangeError(`createNodeTransport: maxPayload must be a positive integer (got ${String(opts.maxPayload)})`);
  }
  const WebSocket = loadWs();
  return (url: string): WsLike => {
    const ws = new WebSocket(url, { maxPayload });
    // `ws` throws on an 'error' event without a listener (e.g. close() while CONNECTING): keep one.
    ws.on("error", () => undefined);
    const like: WsLike = {
      get readyState() { return ws.readyState; },
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.on("open", () => like.onopen?.());
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const text = isBinary ? null : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      like.onmessage?.({ data: text === null ? data : text });
    });
    ws.on("close", (code: number, reason: Buffer) => like.onclose?.({ code, reason: reason.toString("utf8"), wasClean: code === 1000 }));
    ws.on("error", (err: Error) => like.onerror?.(err));
    return like;
  };
}

let defaultTransport: WsFactory | null = null;

/** Default Node transport (`createNodeTransport()` with the 16 MiB maxPayload cap; `ws` loaded on first use). */
export const nodeTransport: WsFactory = (url: string): WsLike => {
  if (defaultTransport === null) defaultTransport = createNodeTransport();
  return defaultTransport(url);
};

export function createVenueStream(codec: VenueCodec, opts: VenueStreamOptions = {}): VenueStream {
  const useDefault = opts.transport === undefined || opts.transport === nodeTransport;
  if (useDefault) loadWs(); // missing `ws` → INVALID_PARAMS now, not a reconnect loop later
  return createBrowserStream(codec, opts.transport === undefined ? { ...opts, transport: nodeTransport } : opts);
}
