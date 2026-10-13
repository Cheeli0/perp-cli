/**
 * Pre-mainnet review, LOW / MEDIUM items that are pure functions or small seams:
 * strict amount parsing, decimal mid, Aster nonce lock, QFEX funding null, log-write failure,
 * M9 (cannot-close gate at bot / plan / TWAP / DCA / grid / job start).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PerpError, parsePositiveDecimal } from "../../errors.js";
import { midDecimal } from "../../exchanges/precision.js";
import { nextAsterNonce } from "../../exchanges/aster-nonce.js";
import { getMarketSnapshot } from "../../bot/conditions.js";
import { assertCanClosePositions } from "../../exchanges/trading-v2.js";
import { runTWAP } from "../../strategies/twap.js";
import { runDCA } from "../../strategies/dca.js";
import { runGrid } from "../../strategies/grid.js";
import { executePlan } from "../../plan-executor.js";
import { runBot } from "../../bot/engine.js";
import { QFEX_REDUCE_ONLY_WIRE, qfexReduceOnlyGate } from "../../exchanges/qfex/signing.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe("strict decimal amounts", () => {
  it("accepts plain decimals and refuses what parseFloat would accept", () => {
    expect(parsePositiveDecimal(" 10.50 ", "amount")).toBe("10.50");
    for (const bad of ["10abc", "1e3", "-5", "0", "0.0", "", "1,000", "0x10", "Infinity", "5 USDC"]) {
      expect(() => parsePositiveDecimal(bad, "amount")).toThrow(PerpError);
    }
    expect(parseFloat("10abc")).toBe(10); // what the commands used to do
  });
});

describe("market mid — exact decimal arithmetic", () => {
  it("has no float artifact", () => {
    expect(midDecimal("0.1", "0.2")).toBe("0.15");
    expect(String((0.1 + 0.2) / 2)).not.toBe("0.15");
    expect(midDecimal("100", "101")).toBe("100.5");
    expect(midDecimal("67000.1", "67000.3")).toBe("67000.2");
    expect(midDecimal("0.00001234", "0.00001235")).toBe("0.000012345");
  });
});

describe("Aster nonce file lock", () => {
  const dir = resolve(process.env.HOME as string, ".perp");
  const lock = resolve(dir, "aster-nonces.json.lock");

  it("nonces stay strictly increasing and the lock is released", () => {
    const a = BigInt(nextAsterNonce("0xAbC", 1_000));
    const b = BigInt(nextAsterNonce("0xabc", 1_000));
    expect(b).toBe(a + 1n);
    expect(existsSync(lock)).toBe(false);
  });

  it("a live lock held by another process → LOCK_HELD (no nonce issued); a stale one is taken over", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, "");
    const before = existsSync(resolve(dir, "aster-nonces.json")) ? readFileSync(resolve(dir, "aster-nonces.json"), "utf8") : null;
    let err: unknown;
    try { nextAsterNonce("0xdef", 5_000); } catch (e) { err = e; }
    expect((err as PerpError).structured.code).toBe("LOCK_HELD");
    expect(existsSync(resolve(dir, "aster-nonces.json")) ? readFileSync(resolve(dir, "aster-nonces.json"), "utf8") : null).toBe(before);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(BigInt(nextAsterNonce("0xdef", 5_000))).toBe(5_000_000n);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("funding null is not 0 (QFEX)", () => {
  it("getMarketSnapshot: unknown funding → NaN, so funding conditions never fire on it", async () => {
    const adapter = {
      name: "qfex",
      getMarkets: async () => [{ symbol: "AAPL", markPrice: "100", fundingRate: null, volume24h: null }],
      getKlines: async () => [],
      getOrderbook: async () => ({ bids: [], asks: [] }),
    } as unknown as ExchangeAdapter;
    const snap = await getMarketSnapshot(adapter, "AAPL");
    expect(Number.isNaN(snap.fundingRate)).toBe(true);
    expect(snap.fundingRate < 0.01).toBe(false);
  });
});

describe("a log-write failure after a fill is not an order failure", () => {
  it("logExecution warns and returns the record instead of throwing", async () => {
    vi.doMock("fs", async (orig) => ({
      ...(await orig<typeof import("fs")>()),
      appendFileSync: () => { throw new Error("ENOSPC: no space left on device"); },
    }));
    const { logExecution } = await import("../../execution-log.js");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rec = logExecution({ type: "market_order", exchange: "hyperliquid", symbol: "BTC", side: "buy", size: "1", status: "success", dryRun: false });
    expect(rec.status).toBe("success");
    expect(String(warn.mock.calls[0][0])).toMatch(/could not write the execution log/);
    vi.doUnmock("fs");
  });

  it("logClientId: a pre-send (pending) write failure throws; a post-send one only warns", async () => {
    vi.doMock("fs", async (orig) => ({
      ...(await orig<typeof import("fs")>()),
      appendFileSync: () => { throw new Error("EACCES"); },
    }));
    const { logClientId } = await import("../../client-id-tracker.js");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const base = { clientOrderId: "c1", exchange: "x", symbol: "BTC", side: "buy", size: "1", type: "market", createdAt: "", updatedAt: "" };
    expect(() => logClientId({ ...base, status: "pending" } as never)).toThrow("EACCES");
    expect(() => logClientId({ ...base, status: "submitted" } as never)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    vi.doUnmock("fs");
  });
});

describe("M9: nothing that opens positions starts on a venue that cannot close them", () => {
  const gate = new PerpError("CAPABILITY_UNSUPPORTED", "QFEX reduce-only orders are not verified", { remediation: "close on the QFEX web app" });
  const marketOrder = vi.fn();
  const gated = { name: "qfex", reduceOnlyGate: () => gate, marketOrder, limitOrder: marketOrder, getMarkets: vi.fn(), getBalance: vi.fn(), getPositions: vi.fn() } as unknown as ExchangeAdapter;
  const open = { name: "hyperliquid" } as unknown as ExchangeAdapter;

  it("assertCanClosePositions throws the gate (with its remediation) and passes ungated adapters", () => {
    expect(() => assertCanClosePositions(open, "Bot")).not.toThrow();
    try { assertCanClosePositions(gated, "Bot"); throw new Error("no throw"); } catch (e) {
      expect((e as PerpError).structured.code).toBe("CAPABILITY_UNSUPPORTED");
      expect((e as PerpError).message).toMatch(/could open a position it cannot close/);
      expect((e as PerpError).structured.remediation).toBe("close on the QFEX web app");
    }
  });

  it("TWAP / DCA / grid / plan / bot refuse before any order or read", async () => {
    const refusedBy = async (p: Promise<unknown>) => { await expect(p).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } }); };
    await refusedBy(runTWAP(gated, { symbol: "AAPL", side: "buy", totalSize: 1, durationSec: 60 }, undefined, () => {}));
    await refusedBy(runDCA(gated, { symbol: "AAPL", side: "buy", amountPerOrder: 1, intervalSec: 60, totalOrders: 2 }, undefined, () => {}));
    await refusedBy(runGrid(gated, { symbol: "AAPL", upperPrice: 2, lowerPrice: 1, grids: 3, totalSize: 1 } as never, undefined, () => {}));
    await refusedBy(executePlan(gated, { version: "1.0", steps: [{ id: "a", action: "market_order", params: { symbol: "AAPL", side: "buy", size: "1" } }] } as never));
    await refusedBy(runBot(gated, { strategy: { type: "grid" } } as never, undefined, (() => {}) as never, undefined, "silent" as never, false));
    expect(marketOrder).not.toHaveBeenCalled();
    expect((gated as unknown as { getMarkets: ReturnType<typeof vi.fn> }).getMarkets).not.toHaveBeenCalled();
  });

  it("a read-only plan is not refused by the gate", async () => {
    const reader = { ...gated, getBalance: vi.fn().mockResolvedValue({ equity: "1", available: "1", marginUsed: "0", unrealizedPnl: "0" }) } as unknown as ExchangeAdapter;
    const r = await executePlan(reader, { version: "1.0", steps: [{ id: "a", action: "check_balance", params: { minAvailable: 0 } }] } as never);
    expect(r.status).not.toBe("failed");
  });

  it("the qfex background-job gate (startJob) follows the reduce-only wire format: open now that Q2 set it", () => {
    // startJob refuses on qfexReduceOnlyGate(QFEX_REDUCE_ONLY_WIRE); it is not called here (it would launch tmux).
    expect(qfexReduceOnlyGate(QFEX_REDUCE_ONLY_WIRE)).toBeNull();
    expect(qfexReduceOnlyGate(null)!.structured.code).toBe("CAPABILITY_UNSUPPORTED");
  });
});
