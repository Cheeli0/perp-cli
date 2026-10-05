/**
 * Live testnet E2E round 6 (2026-10-02) fixes, with the venues' real responses:
 * - Pacifica spot-buy SOL-USDC → 422 {"error_id":"no_reasonable_price"} (empty book) was UNKNOWN;
 *   a 422 create-order refusal is a definite pre-trade rejection → ORDER_REJECTED.
 * - Runner: Pacifica spot candidates carry their book; every market without a two-sided book → SKIP.
 * - Hyperliquid testnet `funds withdraw hyperliquid 2` → {"status":"err","response":"Error
 *   withdrawing from bridge"} was UNKNOWN; an `err` envelope on a user-signed action executed
 *   nothing → ACTION_REJECTED (non-retryable), distinct from transport failures.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pacificaCreateRejection } from "../exchanges/pacifica.js";
import { HyperliquidAdapter, HlErrResponse, hlUserActionRejection } from "../exchanges/hyperliquid.js";
import { LocalEvmSigner } from "../signer/index.js";
import { classifyError, ERROR_CODES, isDefiniteOrderFailure, PerpError } from "../errors.js";
import { DEFINITE_REJECTION_CODES, NO_TWO_SIDED_BOOK, pickSpotMarket, type SpotCandidate } from "../../scripts/e2e/lib.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// POST https://test-api.pacifica.fi/api/v1/orders/create_market (spot SOL-USDC, 2026-10-02) — the client's error text
const PAC_NO_PRICE = new Error("POST /orders/create_market failed (422): {\"success\":false,\"data\":null,\"error\":\"No reasonable price found for SOL-USDC\",\"code\":0,\"error_id\":\"no_reasonable_price\"}");

describe("Pacifica 422 create-order refusal → definite rejection", () => {
  it("no_reasonable_price → ORDER_REJECTED with the venue error id (was UNKNOWN)", () => {
    expect(classifyError(PAC_NO_PRICE).code).toBe("UNKNOWN"); // the pre-fix classification
    const e = pacificaCreateRejection(PAC_NO_PRICE, "spot market buy 0.1 SOL-USDC");
    expect(e).toBeInstanceOf(PerpError);
    expect((e as PerpError).structured).toMatchObject({
      code: "ORDER_REJECTED", retryable: false,
      details: { errorId: "no_reasonable_price", venueCode: 0, path: "/orders/create_market" },
    });
    expect(isDefiniteOrderFailure(e)).toBe(true);
  });

  it("documented codes map (4 INVALID_TICK_LEVEL, 5 INSUFFICIENT_BALANCE, 7/8 size); limit / stop create paths are covered", () => {
    const mk = (code: number, msg: string) => new Error(`POST /orders/create failed (422): {"success":false,"data":null,"error":"${msg}","code":${code},"error_id":"unspecified"}`);
    expect((pacificaCreateRejection(mk(5, "Insufficient balance"), "limit") as PerpError).structured.code).toBe("INSUFFICIENT_BALANCE");
    expect((pacificaCreateRejection(mk(4, "Invalid tick level"), "limit") as PerpError).structured.code).toBe("INVALID_TICK");
    expect((pacificaCreateRejection(mk(7, "Order amount too low"), "limit") as PerpError).structured.code).toBe("SIZE_TOO_SMALL");
    expect((pacificaCreateRejection(mk(8, "Order amount too high"), "limit") as PerpError).structured.code).toBe("SIZE_TOO_LARGE");
    const stop = new Error("POST /orders/stop/create failed (422): {\"success\":false,\"data\":null,\"error\":\"Invalid tick level\",\"code\":3,\"error_id\":\"unspecified\"}");
    expect((pacificaCreateRejection(stop, "stop") as PerpError).structured.code).toBe("ORDER_REJECTED");
  });

  it("not a 422 create refusal → unchanged (transport / 5xx / cancel / unparseable / PerpError)", () => {
    for (const e of [
      new Error("POST /orders/create_market failed (500): {\"success\":false,\"error\":\"Internal\"}"),
      new Error("POST /orders/create_market failed (429): {\"success\":false,\"error\":\"Too many\"}"),
      new Error("POST /orders/cancel failed (422): {\"success\":false,\"data\":null,\"error\":\"Failed to cancel order\",\"code\":5}"),
      new Error("POST /orders/create failed (422): <html>"),
      new Error("fetch failed"),
      new PerpError("ORDER_PENDING", "x"),
    ]) {
      expect(pacificaCreateRejection(e, "x")).toBe(e);
    }
  });
});

describe("runner: a Pacifica spot market without a two-sided book is never picked", () => {
  // GET https://test-api.pacifica.fi/api/v1/book?symbol=SOL-USDC (2026-10-02): {"s":"SOL-USDC","l":[[],[]]}
  const EMPTY: SpotCandidate = { symbol: "SOL", quote: "USDC", mark: 122.1, twoSided: false, mid: null, volume24hUsd: 0, step: "0.01", minSize: null, minNotional: 10, bookRef: "SOL-USDC" };

  it("every quote market empty → pick null, all rejections NO_TWO_SIDED_BOOK (the runner SKIPs spot)", () => {
    const { pick, rejected } = pickSpotMarket([EMPTY, { ...EMPTY, symbol: "BTC", mark: 86000, step: "0.00001" }], "USDC", 50, 100, null);
    expect(pick).toBeNull();
    expect(rejected.every(r => r.reason === NO_TWO_SIDED_BOOK)).toBe(true);
  });

  it("a two-sided market is still picked", () => {
    const { pick } = pickSpotMarket([EMPTY, { ...EMPTY, symbol: "ETH", mark: 2700, mid: 2700.5, twoSided: true, step: "0.0001" }], "USDC", 50, 100, null);
    expect(pick?.symbol).toBe("ETH");
  });
});

describe("Hyperliquid user-signed action refused by the venue → ACTION_REJECTED", () => {
  const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
  const DEST = "0x5e9ee1089755c3435139848e47e6635505d5a13a";
  const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })));

  async function master(): Promise<HyperliquidAdapter> {
    const hl = new HyperliquidAdapter(undefined, true);
    hl.setSigner(await LocalEvmSigner.create(KEY));
    return hl;
  }

  it("withdraw3 → {status:err, response:'Error withdrawing from bridge'} (live testnet) → ACTION_REJECTED, non-retryable", async () => {
    respond({ status: "err", response: "Error withdrawing from bridge" });
    const err = await (await master()).withdraw("2", DEST).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured).toMatchObject({ code: "ACTION_REJECTED", retryable: false, details: { action: "withdraw3", venueResponse: "Error withdrawing from bridge" } });
    expect(ERROR_CODES.ACTION_REJECTED.retryable).toBe(false);
    expect(DEFINITE_REJECTION_CODES.has("ACTION_REJECTED")).toBe(true);
  });

  it("an insufficient-balance refusal keeps INSUFFICIENT_BALANCE (spot-transfer shortfall sizing)", async () => {
    respond({ status: "err", response: "Insufficient balance for withdrawal." });
    const err = await (await master()).usdClassTransfer("5", false).then(() => null, (e: unknown) => e);
    expect((err as PerpError).structured.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("transport / unparseable responses are not turned into a definite rejection", () => {
    const net = new Error("fetch failed");
    expect(hlUserActionRejection("withdraw3", net)).toBe(net);
    const html = new Error("HL exchange API error (502): <html>");
    expect(hlUserActionRejection("withdraw3", html)).toBe(html);
    expect((hlUserActionRejection("withdraw3", new HlErrResponse("x")) as PerpError).structured.code).toBe("ACTION_REJECTED");
  });
});
