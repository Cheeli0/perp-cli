import { describe, it, expect, vi, afterEach } from "vitest";
import { getDebridgeQuote, getAllQuotes } from "../bridge-engine.js";

const SENDER = "0xabf20312dB7A6e807765ee7522E7d8c8DBB637D3";
const SOL_RECIPIENT = "4iTFFwUquYH7e1G4Ms6oUnBxPHf4wmHj456eLXLmwaB7";

/** Live deBridge quote shape (2026-10-13, Arbitrum → Solana, 5 USDC, prependOperatingExpenses=false). */
function dlnQuote(srcIn: string, dstOut: string, fixFee: string) {
  return {
    estimation: { srcChainTokenIn: { amount: srcIn }, dstChainTokenOut: { amount: dstOut, recommendedAmount: dstOut } },
    order: { approximateFulfillmentDelay: 1 },
    fixFee,
  };
}

function mockFetch(routes: (url: string) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = routes(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("deBridge quote cost", () => {
  it("asks for prependOperatingExpenses=false, spends exactly the request, and reports fixFee as a native fee", async () => {
    const spy = mockFetch(url => (url.includes("/dln/order/quote") ? dlnQuote("5000000", "4055671", "1000000000000000") : undefined));
    const q = await getDebridgeQuote("arbitrum", "solana", 5, SENDER, SOL_RECIPIENT);
    expect(String(spy.mock.calls[0][0])).toContain("prependOperatingExpenses=false");
    expect(q.amountIn).toBe(5);
    expect(q.amountOut).toBeCloseTo(4.055671, 6);
    expect(q.fee).toBeCloseTo(0.944329, 6);
    expect(q.nativeFee).toEqual({ amount: "0.001", symbol: "ETH", usd: null });
  });

  it("refuses a quote that would take more USDC than requested (the prepend-mode surprise)", async () => {
    mockFetch(url => (url.includes("/dln/order/quote") ? dlnQuote("5939569", "4996003", "1000000000000000") : undefined));
    await expect(getDebridgeQuote("arbitrum", "solana", 5, SENDER, SOL_RECIPIENT)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("refuses a quote without a readable fixFee", async () => {
    mockFetch(url => (url.includes("/dln/order/quote") ? dlnQuote("5000000", "4055671", undefined as unknown as string) : undefined));
    await expect(getDebridgeQuote("arbitrum", "solana", 5, SENDER, SOL_RECIPIENT)).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });
});

describe("getAllQuotes ranking", () => {
  it("ranks by amount received minus the priced native fee; an unpriced native fee ranks last", async () => {
    // Only deBridge answers here (CCTP / Relay fail → dropped); ranking logic is exercised with a priced ETH mid.
    mockFetch(url => {
      if (url.includes("/dln/order/quote")) return dlnQuote("5000000", "4055671", "1000000000000000");
      if (url.includes("api.hyperliquid.xyz/info")) return { ETH: "2500" };
      return undefined;
    });
    const quotes = await getAllQuotes("arbitrum", "solana", 5, SENDER, SOL_RECIPIENT);
    const dln = quotes.find(q => q.provider === "debridge");
    expect(dln?.nativeFee).toEqual({ amount: "0.001", symbol: "ETH", usd: 2.5 });
  });
});
