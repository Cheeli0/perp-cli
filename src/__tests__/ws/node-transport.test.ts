/**
 * perp-cli/ws/node transport: inbound messages are capped (default 16 MiB instead of ws's 100 MiB,
 * configurable via createNodeTransport({ maxPayload })); an oversized message is never delivered: the
 * transport reports WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, the server sees close 1009, the local close is 1006.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { DEFAULT_MAX_PAYLOAD, createNodeTransport, nodeTransport } from "../../ws/node.js";
import type { WsFactory } from "../../ws/types.js";

let server: WebSocketServer | null = null;
let serverCloseCode: Promise<number> = Promise.resolve(-1);

afterEach(async () => {
  const s = server;
  server = null;
  if (s !== null) {
    for (const c of s.clients) c.terminate();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** Start a server that sends `size` bytes of text to each client on connect; returns its URL. */
async function serveFrame(size: number): Promise<string> {
  const s = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server = s;
  serverCloseCode = new Promise((r) => {
    s.on("connection", (sock) => {
      sock.on("close", (code) => r(code));
      sock.send("x".repeat(size));
    });
  });
  await new Promise<void>((r) => s.once("listening", () => r()));
  return `ws://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

interface Received { messages: number[]; errors: unknown[]; close: { code: number } }

function receive(factory: WsFactory, url: string): Promise<Received> {
  return new Promise((resolve) => {
    const ws = factory(url);
    const messages: number[] = [];
    const errors: unknown[] = [];
    ws.onerror = (err) => errors.push((err as { code?: unknown }).code);
    ws.onmessage = (ev) => {
      messages.push(typeof ev.data === "string" ? ev.data.length : -1);
      ws.close(1000, "done");
    };
    ws.onclose = (ev) => resolve({ messages, errors, close: { code: ev.code } });
  });
}

describe("nodeTransport maxPayload", () => {
  it("defaults to 16 MiB (bounded below ws's 100 MiB)", () => {
    expect(DEFAULT_MAX_PAYLOAD).toBe(16 * 1024 * 1024);
  });

  it("delivers a frame within the cap", async () => {
    const url = await serveFrame(200_000); // > largest measured real frame (~147 KB)
    const r = await receive(nodeTransport, url);
    expect(r.messages).toEqual([200_000]);
    expect(r.errors).toEqual([]);
  });

  it("drops a frame over a configured cap and closes (1009 to the server)", async () => {
    const url = await serveFrame(2048);
    const r = await receive(createNodeTransport({ maxPayload: 1024 }), url);
    expect(r.messages).toEqual([]);
    expect(r.errors).toEqual(["WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"]);
    expect(r.close.code).toBe(1006);
    expect(await serverCloseCode).toBe(1009);
  });

  it("the default transport rejects a frame just over 16 MiB", async () => {
    const url = await serveFrame(DEFAULT_MAX_PAYLOAD + 1);
    const r = await receive(nodeTransport, url);
    expect(r.messages).toEqual([]);
    expect(r.errors).toEqual(["WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"]);
    expect(r.close.code).toBe(1006);
    expect(await serverCloseCode).toBe(1009);
  }, 30_000);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects maxPayload %s", (v) => {
    expect(() => createNodeTransport({ maxPayload: v })).toThrow(RangeError);
  });
});
