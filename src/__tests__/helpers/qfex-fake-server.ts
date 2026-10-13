/**
 * In-process fake of the QFEX Trade WebSocket (and MDS) for transport tests.
 * It speaks only what a test scripts: auth + subscribe are answered automatically (shape
 * configurable); every other inbound message is recorded and passed to `onCommand`.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export interface FakeConn {
  ws: WebSocket;
  url: string;
  send(frame: unknown): void;
}

export interface FakeQfexServer {
  url: string;
  /** Every message type received, across all connections, in order. */
  types: string[];
  /** Every parsed message received. */
  messages: Array<{ conn: number; msg: Record<string, unknown> }>;
  /** Connections accepted so far. */
  connections: FakeConn[];
  /** How the auth message is answered. */
  authReply: (msg: Record<string, unknown>) => unknown | null;
  /** How a subscribe is answered (per channel); null = stay silent. */
  subscribeReply: (channel: string) => unknown | null;
  /** Called for every message that is not auth / subscribe. */
  onCommand: (conn: FakeConn, msg: Record<string, unknown>, index: number) => void;
  close(): Promise<void>;
}

export async function startFakeQfexServer(): Promise<FakeQfexServer> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const server: FakeQfexServer = {
    url: `ws://127.0.0.1:${port}`,
    types: [],
    messages: [],
    connections: [],
    authReply: () => ({ authenticated: true }),
    subscribeReply: channel => ({ subscribed: channel }),
    onCommand: () => undefined,
    close: () => new Promise<void>(resolve => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
  wss.on("connection", (ws, req) => {
    const conn: FakeConn = { ws, url: req.url ?? "", send: frame => ws.send(JSON.stringify(frame)) };
    const index = server.connections.push(conn) - 1;
    ws.on("message", data => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      server.types.push(String(msg.type));
      server.messages.push({ conn: index, msg });
      if (msg.type === "auth") {
        const r = server.authReply(msg);
        if (r !== null) conn.send(r);
        return;
      }
      if (msg.type === "subscribe" && msg.params !== undefined) {
        const channels = (msg.params as { channels: string[] }).channels;
        for (const ch of channels) {
          const r = server.subscribeReply(ch);
          if (r !== null) conn.send(r);
        }
        return;
      }
      server.onCommand(conn, msg, index);
    });
  });
  return server;
}

/** order_response frame with defaults for the fields correlation does not look at. */
export function orderResponse(o: {
  order_id: string; client_order_id: string; status: string; quantity: number; quantity_remaining: number;
  symbol?: string; price?: number; side?: "BUY" | "SELL"; type?: string; time_in_force?: string; user_id?: string;
}): { order_response: Record<string, unknown> } {
  return {
    order_response: {
      symbol: "AAPL-USD", price: 333.4, take_profit: 0, stop_loss: 0, side: "BUY", type: "LIMIT", time_in_force: "IOC",
      user_id: "11111111-1111-4111-8111-111111111111", update_time: 1758208770.55, trade_id: null, ...o,
    },
  };
}

export function fillResponse(o: { trade_id: string; order_id: string; client_order_id: string; price: number; quantity: number }): { fill_response: Record<string, unknown> } {
  return { fill_response: { symbol: "AAPL-USD", side: "BUY", fee: 0.01, ...o } };
}
