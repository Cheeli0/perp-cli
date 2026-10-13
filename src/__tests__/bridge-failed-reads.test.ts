/**
 * Bridge reads (audit M11 / M12):
 *  - getSolanaUsdcBalance returns 0 only when the USDC token account does not exist; any other
 *    RPC failure is an error (never "0 USDC").
 *  - The HyperCore CCTP fee schedule is required for the burn's maxFee: an unreadable schedule
 *    fails the quote (PerpError) instead of silently using a 1bp + $0.20 default.
 * No network: @solana/web3.js Connection and fetch are mocked.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const tokenBalance = vi.fn();
vi.mock("@solana/web3.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@solana/web3.js")>();
  class Connection {
    getTokenAccountBalance = tokenBalance;
  }
  return { ...orig, Connection };
});

import { getSolanaUsdcBalance, getCctpQuote, isSolanaAccountNotFound } from "../bridge-engine.js";

const OWNER = "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7";

afterEach(() => { tokenBalance.mockReset(); vi.unstubAllGlobals(); });

describe("getSolanaUsdcBalance", () => {
  it("reads raw amount / decimals", async () => {
    tokenBalance.mockResolvedValue({ value: { amount: "12345678", decimals: 6, uiAmount: null } });
    await expect(getSolanaUsdcBalance(OWNER)).resolves.toBeCloseTo(12.345678, 9);
  });

  it("missing token account → 0", async () => {
    tokenBalance.mockRejectedValue(new Error("failed to get token account balance: Invalid param: could not find account"));
    await expect(getSolanaUsdcBalance(OWNER)).resolves.toBe(0);
  });

  it("any other RPC failure → PerpError, not 0", async () => {
    tokenBalance.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(getSolanaUsdcBalance(OWNER)).rejects.toMatchObject({
      name: "PerpError",
      structured: { code: "EXCHANGE_UNREACHABLE", remediation: expect.stringContaining("not 0") },
    });
  });

  it("malformed answer → PerpError, not 0", async () => {
    tokenBalance.mockResolvedValue({ value: { amount: "abc", decimals: 6 } });
    await expect(getSolanaUsdcBalance(OWNER)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("isSolanaAccountNotFound matches only the not-found case", () => {
    expect(isSolanaAccountNotFound(new Error("Invalid param: could not find account"))).toBe(true);
    expect(isSolanaAccountNotFound(new Error("fetch failed"))).toBe(false);
  });
});

describe("HyperCore CCTP quote fee schedule", () => {
  const schedule = [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 100000, med: 150000, high: 300000 } }];

  it("uses the fetched schedule", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(schedule))));
    const q = await getCctpQuote("arbitrum", "hyperliquid", "100");
    // 1bp of 100 = 0.01 + 0.15 forwarding
    expect(q.fee).toBeCloseTo(0.16, 9);
    expect((q.raw as { maxFee: number }).maxFee).toBe(10000 + 150000);
  });

  it("fee API unreachable → PerpError (no default fee)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND iris-api.circle.com"); }));
    await expect(getCctpQuote("arbitrum", "hyperliquid", "100")).rejects.toMatchObject({
      name: "PerpError",
      structured: { code: "EXCHANGE_UNREACHABLE" },
    });
  });

  it("HTTP error / schedule without a forwarding fee → PerpError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(getCctpQuote("arbitrum", "hyperliquid", "100")).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 1 }]))));
    await expect(getCctpQuote("arbitrum", "hyperliquid", "100")).rejects.toThrow(/without a forwarding fee/);
  });
});
