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

/** `ws` adapter with the browser WebSocket handler shape (text frames as strings). */
export const nodeTransport: WsFactory = (url: string): WsLike => {
  const ws = new WebSocket(url);
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

export function createVenueStream(codec: VenueCodec, opts: VenueStreamOptions = {}): VenueStream {
  return createBrowserStream(codec, opts.transport === undefined ? { ...opts, transport: nodeTransport } : opts);
}
