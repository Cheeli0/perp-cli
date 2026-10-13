/**
 * trade split: the USD total is converted to a lot-sized base total and split across the
 * slices; every slice is checked against the venue minimum BEFORE anything is sent, the limit
 * price is on the tick, fills are verified, and a run that did not fill completely is an error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../execution-log.js", () => ({ logExecution: vi.fn(), readExecutionLog: vi.fn(() => []) }));

import { runSplitOrder, splitIncompleteError, type SplitOrderParams, type SplitOrderResult } from "../strategies/split-order.js";
import { PerpError } from "../errors.js";

/** Aster SOL as on 2026-10-05: lot 0.01, tick 0.0001, minimum order value $5. */
const SOL: Omit<SplitOrderParams, "totalSizeUsd"> = {
  symbol: "SOL", side: "buy", stepSize: "0.01", tickSize: "0.0001", minSize: "0.01", minNotional: "5",
  maxSlippagePct: 0.3, delayMs: 0,
};

/** A venue whose position moves by what limitOrder fills (placePerpVerified measures the delta). */
function venue(onOrder: (price: string, size: string) => unknown = (_p, size) => ({ status: "FILLED", price: _p, avgPrice: "120.7", executedQty: size })) {
  let position = 0;
  const limitOrder = vi.fn(async (_s: string, _side: string, price: string, size: string, _o: unknown) => {
    const raw = onOrder(price, size);
    position += Number(size);
    return raw;
  });
  return {
    name: "aster",
    limitOrder,
    getOrderbook: vi.fn(async () => ({ asks: [["120.7000", "500"], ["120.7500", "500"]] as [string, string][], bids: [["120.6900", "500"]] as [string, string][] })),
    getPositions: vi.fn(async () => position === 0 ? [] : [{ symbol: "SOL", side: "long", size: String(Number(position.toFixed(8))), entryPrice: "120.7", markPrice: "120.7", liquidationPrice: null, unrealizedPnl: "0", leverage: 5 }]),
  };
}
const run = (v: ReturnType<typeof venue>, p: Partial<SplitOrderParams> & { totalSizeUsd: number }) =>
  runSplitOrder(v as never, { ...SOL, ...p }, () => {});

beforeEach(() => { vi.clearAllMocks(); });

describe("runSplitOrder", () => {
  it("live case — $12 in 2 slices of SOL: a slice (0.04 ≈ $4.83) is under the $5 minimum → SIZE_TOO_SMALL before anything is sent", async () => {
    const v = venue();
    const e = await run(v, { totalSizeUsd: 12, minSliceUsd: 6, maxSlices: 2 }).catch(x => x) as PerpError;
    expect(e).toBeInstanceOf(PerpError);
    expect(e.structured.code).toBe("SIZE_TOO_SMALL");
    expect(e.structured.details).toMatchObject({ slices: 2, sliceSize: "0.04", minNotional: "5" });
    expect(e.message).toMatch(/nothing was sent/);
    expect(v.limitOrder).not.toHaveBeenCalled();
  });

  it("splits the TOTAL across the slices in whole lots (never the whole amount per slice), limit price on the tick", async () => {
    const v = venue();
    const r = await run(v, { totalSizeUsd: 24, minSliceUsd: 6, maxSlices: 2 });
    // 24 / 120.70 = 0.1988 → 0.19 lots-floored total → 0.09 + 0.10
    expect(v.limitOrder.mock.calls.map(c => [c[2], c[3], c[4]])).toEqual([
      ["121.0621", "0.09", { tif: "IOC" }],
      ["121.0621", "0.1", { tif: "IOC" }],
    ]);
    expect(r).toMatchObject({ status: "complete", requestedSize: "0.19", filledSize: "0.19", avgPrice: "120.7" });
    expect(r.slices.map(s => [s.status, s.filledSize, s.avgFillPrice])).toEqual([["filled", "0.09", "120.7"], ["filled", "0.1", "120.7"]]);
    expect(splitIncompleteError("aster", r)).toBeNull();
  });

  it("the slice count is total / --min-slice capped at --max-slices; a total under --min-slice is refused", async () => {
    const v = venue();
    await run(v, { totalSizeUsd: 100, minSliceUsd: 30, maxSlices: 10 });
    expect(v.limitOrder).toHaveBeenCalledTimes(3);
    const small = venue();
    await expect(run(small, { totalSizeUsd: 12, minSliceUsd: 100 })).rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
    expect(small.limitOrder).not.toHaveBeenCalled();
  });

  it("a tolerance below one tick still sends a crossing, on-tick price (the best price itself)", async () => {
    const v = venue();
    await run(v, { totalSizeUsd: 24, minSliceUsd: 24, tickSize: "1", maxSlippagePct: 0.1 }); // 120.82 floors to 120, below the best ask
    expect(v.limitOrder.mock.calls[0][2]).toBe("120.7000");
  });

  it("the average is the venue-reported fill price; unknown (null) when the venue reports none — never the limit price", async () => {
    const r = await run(venue((price) => ({ orderId: 1, price })), { totalSizeUsd: 24, minSliceUsd: 24 });
    expect(r).toMatchObject({ status: "complete", filledSize: "0.19", avgPrice: null, filledUsd: null, totalSlippagePct: null });
  });

  it("every slice definitely refused → status failed → ORDER_REJECTED (never ok:true)", async () => {
    const v = venue();
    v.limitOrder.mockRejectedValue(new PerpError("ORDER_REJECTED", "aster: Order's notional must be no smaller than 5", { exchange: "aster" }));
    const r = await run(v, { totalSizeUsd: 24, minSliceUsd: 6, maxSlices: 2 });
    expect(r).toMatchObject({ status: "failed", filledSize: "0" });
    expect(r.slices.map(s => s.status)).toEqual(["rejected", "rejected"]);
    const e = splitIncompleteError("aster", r) as PerpError;
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/nothing filled — aster: Order's notional must be no smaller than 5/);
  });

  it("one slice filled, the next refused → ORDER_PARTIAL with the filled size", async () => {
    const v = venue();
    v.limitOrder.mockRejectedValueOnce(new PerpError("ORDER_REJECTED", "no", { exchange: "aster" }));
    const r = await run(v, { totalSizeUsd: 24, minSliceUsd: 6, maxSlices: 2 });
    // The refused first slice's size is carried: the last slice takes everything that remains.
    expect(v.limitOrder.mock.calls.map(c => c[3])).toEqual(["0.09", "0.19"]);
    expect(r.status).toBe("complete");

    const partial: SplitOrderResult = { ...r, status: "partial", filledSize: "0.09" };
    expect(splitIncompleteError("aster", partial)).toMatchObject({ structured: { code: "ORDER_PARTIAL" } });
  });

  it("an unknown slice outcome → ORDER_PENDING with a do-not-resubmit remediation", () => {
    const r: SplitOrderResult = {
      symbol: "SOL", side: "buy", requestedUsd: 24, requestedSize: "0.19", filledSize: "0.09", filledUsd: null, avgPrice: null, totalSlippagePct: null, runtime: 1,
      status: "unknown",
      slices: [
        { index: 0, size: "0.09", price: "121.0621", filledSize: "0.09", avgFillPrice: null, method: "limit_ioc", status: "filled", error: null },
        { index: 1, size: "0.1", price: "121.0621", filledSize: null, avgFillPrice: null, method: "limit_ioc", status: "unknown", error: "socket hang up" },
      ],
    };
    const e = splitIncompleteError("aster", r) as PerpError;
    expect(e.structured.code).toBe("ORDER_PENDING");
    expect(e.message).toMatch(/outcome of slice 2 is unknown; 0\.09 of 0\.19 verified filled/);
    expect(e.structured.remediation).toMatch(/Do NOT resubmit/);
  });
});
