/**
 * Pacifica position TP/SL (POST /positions/tpsl): the `side` field is the TP/SL orders' CLOSING
 * side — long → "ask", short → "bid" (pacifica-fi/python-sdk rest/create_position_tpsl.py:
 * "Assume a BTC long position has already been opened" … side: "ask"). Live testnet E2E
 * 2026-10-02 (t-entry-tpsl, SOL long 0.09, tp 129.75 / sl 117.38) sent the position side "bid"
 * and got 422 {"error":"Invalid stop order side"}.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import "../../exchanges/venues/index.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import { PacificaClient } from "../../pacifica/client.js";

function adapter() {
  const a = new PacificaAdapter(Keypair.generate(), "testnet");
  const client = new PacificaClient({ network: "testnet" });
  const post = vi.fn().mockResolvedValue({ success: true, data: null, error: null, code: null });
  (client as unknown as { post: unknown }).post = post;
  (a as unknown as { client: unknown }).client = client;
  return { a, post };
}

/** The signed request body minus the per-call signature fields. */
function payloadOf(post: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0][0]).toBe("/positions/tpsl");
  const { signature, timestamp, expiry_window, account, ...rest } = post.mock.calls[0][1] as Record<string, unknown>;
  expect(typeof signature).toBe("string");
  expect(typeof timestamp).toBe("number");
  expect(typeof expiry_window).toBe("number");
  expect(typeof account).toBe("string");
  return rest;
}

describe("Pacifica set_position_tpsl payload", () => {
  it("long position → side ask (closing side), tp + sl", async () => {
    const { a, post } = adapter();
    await a.setPositionTpSl("SOL", "long", { tp: "129.75", tpLimit: null, sl: "117.38" });
    expect(payloadOf(post)).toEqual({
      symbol: "SOL", side: "ask",
      take_profit: { stop_price: "129.75" },
      stop_loss: { stop_price: "117.38" },
    });
  });

  it("short position → side bid (closing side), tp with limit + sl", async () => {
    const { a, post } = adapter();
    await a.setPositionTpSl("sol", "short", { tp: "110.5", tpLimit: "110.4", sl: "131" });
    expect(payloadOf(post)).toEqual({
      symbol: "SOL", side: "bid",
      take_profit: { stop_price: "110.5", limit_price: "110.4" },
      stop_loss: { stop_price: "131" },
    });
  });

  it("only one leg → the other key is absent", async () => {
    const { a, post } = adapter();
    await a.setPositionTpSl("SOL", "long", { tp: null, tpLimit: null, sl: "117.38" });
    expect(payloadOf(post)).toEqual({ symbol: "SOL", side: "ask", stop_loss: { stop_price: "117.38" } });
  });

  it("a venue refusal (the live 422 body) → ORDER_REJECTED", async () => {
    const { a, post } = adapter();
    post.mockResolvedValue({ success: false, data: null, error: "Invalid stop order side", code: 0, error_id: "unspecified" });
    await expect(a.setPositionTpSl("SOL", "long", { tp: "129.75", tpLimit: null, sl: "117.38" }))
      .rejects.toMatchObject({ structured: { code: "ORDER_REJECTED" } });
  });
});
