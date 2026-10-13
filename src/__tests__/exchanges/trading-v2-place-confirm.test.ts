/**
 * placeAndConfirm: an acknowledgement that already reports the order resting is the settled
 * state of a resting-TIF order (Arcus answers OPEN; its GET /v1/order/{id} can 404 for a moment
 * after that) — no status poll. Market / IOC / FOK orders are never settled by "open".
 */
import { describe, it, expect, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { placeAndConfirm, type TradingV2 } from "../../exchanges/trading-v2.js";
import { getVenue, requireCapabilities } from "../../exchanges/venue.js";
import { withExecution, type OrderRequest, type OrderResult, type OrderStatus } from "../../exchanges/venue-types.js";
import { PerpError } from "../../errors.js";

const def = getVenue("arcus");
const caps = requireCapabilities(def);

function result(status: OrderStatus, finality: "final" | "pending"): OrderResult {
  return withExecution({
    venue: "arcus", symbol: "TSLA", status, finality, orderId: "o1", clientOrderId: "cid1", filledSize: "0", avgPrice: null, venueRaw: {},
  }, "native", {});
}

function request(over: Partial<OrderRequest>): OrderRequest {
  return {
    symbol: "TSLA", side: "buy", type: "limit", size: "1", price: "100", triggerPrice: null, triggerSource: null, tif: "GTT",
    reduceOnly: false, clientOrderId: "cid1", slippage: null, tpsl: null, ...over,
  };
}

function venue(ack: OrderResult, getOrderStatus: TradingV2["getOrderStatus"]): TradingV2 {
  return { name: "arcus", venue: def, network: "testnet", placeOrder: vi.fn(async () => ack), getOrderStatus } as unknown as TradingV2;
}

const notFound = vi.fn(async () => { throw new PerpError("ORDER_NOT_FOUND", "Order not found"); });

describe("placeAndConfirm — ack already reports a resting order", () => {
  it.each(["open", "partiallyFilled"] as const)("resting TIF + ack %s → final, no status poll", async (status) => {
    const getOrderStatus = vi.fn(notFound);
    const r = await placeAndConfirm(venue(result(status, "pending"), getOrderStatus), caps, request({}));
    expect(r).toMatchObject({ status, finality: "final", remediation: null, orderId: "o1" });
    expect(getOrderStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["IOC limit", request({ tif: "IOC" })],
    ["FOK limit", request({ tif: "FOK" })],
    ["market", request({ type: "market", price: null, tif: null, slippage: { bps: 50, source: "default" } })],
  ] as const)("%s + ack open is NOT settled by the ack: the order is polled to its final state", async (_name, req) => {
    const getOrderStatus = vi.fn(async () => result("filled", "final"));
    const r = await placeAndConfirm(venue(result("open", "pending"), getOrderStatus), caps, req);
    expect(getOrderStatus).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "filled", finality: "final", remediation: null });
  });

  it("resting TIF + ack accepted is still polled (the ack proves nothing about the book)", async () => {
    const getOrderStatus = vi.fn(async () => result("open", "pending"));
    const r = await placeAndConfirm(venue(result("accepted", "pending"), getOrderStatus), caps, request({}));
    expect(getOrderStatus).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "open", finality: "final", remediation: null });
  });
});
