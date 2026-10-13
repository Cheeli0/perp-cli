/**
 * Lazy runtime resolution (§3 runtime purity): nothing here touches a global at module load.
 * Globals (WebSocket, fetch, TextDecoder, document) are read inside the functions, at call time.
 */

import { WsError } from "./errors.js";
import type { FetchLike, VenueStreamOptions, WsFactory, WsLike } from "./types.js";

type NativeWsCtor = new (url: string) => WsLike & { binaryType?: string };

export function resolveTransport(opts: VenueStreamOptions, venue: string): WsFactory {
  if (opts.transport !== undefined) return opts.transport;
  const Ctor = (globalThis as { WebSocket?: NativeWsCtor }).WebSocket;
  if (typeof Ctor !== "function") {
    throw new WsError("INVALID_PARAMS", "No global WebSocket in this runtime (Node 20 has none)", {
      exchange: venue,
      remediation: "import from perp-cli/ws/node or pass transport",
    });
  }
  return (url: string) => {
    const ws = new Ctor(url);
    ws.binaryType = "arraybuffer";
    return ws;
  };
}

export function resolveFetch(opts: VenueStreamOptions, venue: string): FetchLike {
  if (opts.fetch !== undefined) return opts.fetch;
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== "function") {
    throw new WsError("INVALID_PARAMS", "No global fetch in this runtime (needed for the market directory bootstrap)", {
      exchange: venue,
      remediation: "pass opts.fetch",
    });
  }
  return (input, init) => f(input, init);
}

/** A frame's text, or null for a payload this library cannot read as text. */
export function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: ArrayBuffer | Uint8Array): string } }).TextDecoder;
  if (TD === undefined) return null;
  if (data instanceof ArrayBuffer) return new TD().decode(data);
  if (ArrayBuffer.isView(data)) return new TD().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return null;
}

/** Default visibility source: document.visibilityState when present. */
export function defaultVisibility(): NonNullable<VenueStreamOptions["visibility"]> | null {
  const doc = (globalThis as {
    document?: { visibilityState?: string; addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
  }).document;
  if (doc === undefined || typeof doc.visibilityState !== "string" || typeof doc.addEventListener !== "function") return null;
  return {
    hidden: () => doc.visibilityState === "hidden",
    onChange: (cb) => {
      doc.addEventListener?.("visibilitychange", cb);
      return () => doc.removeEventListener?.("visibilitychange", cb);
    },
  };
}
