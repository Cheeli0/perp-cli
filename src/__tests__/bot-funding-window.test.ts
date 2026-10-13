/**
 * collectFundingSince (funding-arb + spot-perp bots): per-venue high-water mark of the newest
 * booked payment time. A payment is booked exactly once across consecutive reads; a failed read
 * is never counted as 0 and keeps that venue's mark, so the next check re-reads it; the other
 * venues are booked normally.
 */
import { describe, it, expect, vi } from "vitest";
import { collectFundingSince } from "../bot/strategies/funding-arb-utils.js";

const venue = (rows: Array<{ time: number; payment: string }> | Error) => ({
  getFundingPayments: vi.fn(async () => { if (rows instanceof Error) throw rows; return rows; }),
});

const T0 = 1_000_000_000; // bot start (startup recovery booked everything up to here)

describe("collectFundingSince", () => {
  it("books only payments newer than the mark; a failed venue keeps its mark and is logged", async () => {
    const since: Record<string, number> = {};
    const log = vi.fn();
    const r = await collectFundingSince(new Map([
      ["hyperliquid", venue([{ time: T0 + 60_000, payment: "0.25" }, { time: T0 - 60_000, payment: "9" }])],
      ["aster", venue(new Error("HTTP 418"))],
    ]), since, T0, log);
    expect(r).toEqual({ total: 0.25, failed: ["aster"] }); // the 9 predates the start (recovery booked it)
    expect(since).toEqual({ hyperliquid: T0 + 60_000 });   // mark = newest booked payment; aster untouched
    expect(log).toHaveBeenCalledWith(expect.stringContaining("aster: funding history unavailable"));
  });

  it("two consecutive successful reads over the same rows book each payment once (no lookback double count)", async () => {
    const rows = [{ time: T0 + 3_600_000, payment: "0.1" }, { time: T0 + 7_200_000, payment: "0.2" }];
    const since: Record<string, number> = {};
    const a = new Map([["hyperliquid", venue(rows)]]);
    const first = await collectFundingSince(a, since, T0, vi.fn());
    const second = await collectFundingSince(a, since, T0, vi.fn());
    expect(first.total).toBeCloseTo(0.3, 9);
    expect(second.total).toBe(0);
    rows.unshift({ time: T0 + 10_800_000, payment: "0.05" });
    expect((await collectFundingSince(a, since, T0, vi.fn())).total).toBeCloseTo(0.05, 9);
  });

  it("the failed venue's funding is booked on its next successful read", async () => {
    const since: Record<string, number> = { hyperliquid: T0 + 600_000 };
    const r = await collectFundingSince(new Map([
      ["hyperliquid", venue([])],
      ["aster", venue([{ time: T0 + 120_000, payment: "0.4" }])], // paid while aster was failing
    ]), since, T0, vi.fn());
    expect(r.total).toBeCloseTo(0.4, 9);
    expect(since).toEqual({ hyperliquid: T0 + 600_000, aster: T0 + 120_000 });
  });

  it("a full page of unbooked payments warns that older ones may be missing", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ time: T0 + (i + 1) * 1000, payment: "0.01" }));
    const log = vi.fn();
    await collectFundingSince(new Map([["aster", venue(rows)]]), {}, T0, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("may be missing"));
  });
});
