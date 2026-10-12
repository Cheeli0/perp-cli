/**
 * LegacyTradingV2.cancelAllV2 (CHANGELOG Unreleased "cancelAllV2 (legacy venues) re-lists
 * open orders live after the cancels"): one per-order cancel for each order listed open,
 * then a LIVE re-list. Only an order the venue proved cancelled AND that is gone from the
 * re-list is `cancelled`; everything else is `failed` (definite refusal) or `pending`.
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js"; // registers the venue definitions (getVenue)
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { PerpError } from "../../errors.js";
import type { ExchangeAdapter, ExchangeOrder } from "../../exchanges/interface.js";

const HL_CANCEL_OK = { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };

function ord(orderId: string, symbol = "BTC"): ExchangeOrder {
  return { orderId, symbol, side: "buy", price: "1", size: "1", filled: "0", status: "open", type: "limit", triggerPrice: null };
}

/** HL-family mock: `lists` are the successive getOpenOrders() results. */
function hl(lists: Array<ExchangeOrder[] | Error>, cancel: (sym: string, id: string) => Promise<unknown> = async () => HL_CANCEL_OK) {
  let i = 0;
  const getOpenOrders = vi.fn(async () => {
    const r = lists[Math.min(i++, lists.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
  const cancelOrder = vi.fn(cancel);
  const adapter = { name: "hyperliquid", getOpenOrders, cancelOrder } as unknown as ExchangeAdapter;
  return { v2: toTradingV2(adapter, "mainnet"), getOpenOrders, cancelOrder };
}

const ids = (refs: Array<{ ref?: { value: string } | null } | { value: string }>) =>
  refs.map(r => ("value" in r ? r.value : r.ref?.value)).sort();

describe("cancelAllV2 — per-order proof + live re-list", () => {
  it("every listed order cancelled and gone from the re-list → cancelled", async () => {
    const m = hl([[ord("1"), ord("2", "ETH")], []]);
    const r = await m.v2.cancelAllV2(null);
    expect(ids(r.cancelled)).toEqual(["1", "2"]);
    expect(r.failed).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(m.cancelOrder).toHaveBeenCalledWith("BTC", "1");
    expect(m.cancelOrder).toHaveBeenCalledWith("ETH", "2");
    expect(m.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("an order acked cancelled but STILL listed open → pending, not cancelled", async () => {
    const m = hl([[ord("1"), ord("2")], [ord("2")]]);
    const r = await m.v2.cancelAllV2(null);
    expect(ids(r.cancelled)).toEqual(["1"]);
    expect(ids(r.pending ?? [])).toEqual(["2"]);
    expect(r.pending?.[0].reason).toMatch(/still listed open/);
  });

  it("a list that lags the cancel ack (order still listed once, gone on the next re-list) → cancelled", async () => {
    const m = hl([[ord("1"), ord("2")], [ord("2")], []]);
    const r = await m.v2.cancelAllV2(null);
    expect(ids(r.cancelled)).toEqual(["1", "2"]);
    expect(r.pending).toEqual([]);
    expect(m.getOpenOrders).toHaveBeenCalledTimes(3);
  });

  it("an order NOT in the first listing but open at the re-list → pending (placed meanwhile)", async () => {
    const m = hl([[ord("1")], [ord("9")]]);
    const r = await m.v2.cancelAllV2(null);
    expect(ids(r.cancelled)).toEqual(["1"]);
    expect(ids(r.pending ?? [])).toEqual(["9"]);
    expect(r.pending?.[0].reason).toMatch(/not covered by the first listing/);
  });

  it("a failed re-list leaves every unconfirmed cancel pending (never assumed)", async () => {
    const m = hl([[ord("1"), ord("2")], new Error("503 Service Unavailable")]);
    const r = await m.v2.cancelAllV2(null);
    expect(r.cancelled).toEqual([]);
    expect(ids(r.pending ?? [])).toEqual(["1", "2"]);
    expect(r.pending?.[0].reason).toMatch(/re-list failed/);
  });

  it("a cancel ack without per-order 'success' → pending", async () => {
    const m = hl([[ord("1")], []], async () => ({ status: "ok", response: { type: "cancel", data: { statuses: [] } } }));
    const r = await m.v2.cancelAllV2(null);
    expect(r.cancelled).toEqual([]);
    expect(ids(r.pending ?? [])).toEqual(["1"]);
  });

  it("a definite refusal (ORDER_REJECTED) → failed; an untyped throw → pending", async () => {
    const m = hl([[ord("1"), ord("2")], []], async (_s, id) => {
      if (id === "1") throw new PerpError("ORDER_REJECTED", "Order was never placed, already canceled, or filled");
      throw new Error("socket hang up");
    });
    const r = await m.v2.cancelAllV2(null);
    expect(ids(r.failed)).toEqual(["1"]);
    expect(ids(r.pending ?? [])).toEqual(["2"]);
    expect(r.cancelled).toEqual([]);
  });

  it("symbol scope: only that symbol's orders are cancelled and re-checked", async () => {
    const m = hl([[ord("1", "BTC"), ord("2", "ETH")], [ord("2", "ETH")]]);
    const r = await m.v2.cancelAllV2("btc-perp");
    expect(m.cancelOrder).toHaveBeenCalledTimes(1);
    expect(m.cancelOrder).toHaveBeenCalledWith("BTC", "1");
    expect(ids(r.cancelled)).toEqual(["1"]);
    expect(r.pending).toEqual([]); // ETH order still open is out of scope
  });

  it("nothing open → no cancel and no re-list", async () => {
    const m = hl([[]]);
    const r = await m.v2.cancelAllV2(null);
    expect(m.cancelOrder).not.toHaveBeenCalled();
    expect(m.getOpenOrders).toHaveBeenCalledTimes(1);
    expect(r.cancelled).toEqual([]);
  });
});
