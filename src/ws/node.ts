/**
 * perp-cli/ws/node — everything from perp-cli/ws plus a `ws`-based transport (Node 20 has no global
 * WebSocket). `createVenueStream` here defaults `transport` to nodeTransport.
 *
 * @experimental 0.15.x (stable from 0.16.0 after consumer sign-off)
 */

import WebSocket from "ws";
import { createVenueStream as createBrowserStream } from "./stream.js";
import type { VenueCodec, VenueStream, VenueStreamOptions, WsFactory, WsLike } from "./types.js";

export * from "./index.js";

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

/** Default Node transport (`createNodeTransport()` with the 16 MiB maxPayload cap). */
export const nodeTransport: WsFactory = createNodeTransport();

export function createVenueStream(codec: VenueCodec, opts: VenueStreamOptions = {}): VenueStream {
  return createBrowserStream(codec, opts.transport === undefined ? { ...opts, transport: nodeTransport } : opts);
}
