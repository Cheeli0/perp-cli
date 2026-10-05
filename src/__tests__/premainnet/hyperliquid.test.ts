/**
 * Pre-mainnet review — Hyperliquid: M1 (HIP-3 asset map fails closed), M2 (foreign dex prefix),
 * M8 (perp adapter lists perps only), dexAbstraction, native TWAP result, lower-case coins (kPEPE),
 * withdraw3 destination, market-trigger limit price, `trade stop` tp/sl kind, HIP-3 master funding.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../cache.js", async () => ({
  withCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  fetchAndCache: async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidateCache: () => {},
  accountCacheEpoch: () => 0,
  TTL_ACCOUNT: 1000, TTL_MARKET: 1000, TTL_MARKETS: 1000, TTL_PRICES: 1000,
}));

import {
  HIP3_MIN_ASSET_ID, HL_MARKET_TPSL_SLIPPAGE_BPS, HyperliquidAdapter, hlAssertTwapBounds, hlDestination, hlIsSpotCoin, hlL1ActionRejection, HlErrResponse,
  hlTriggerKind, hlValidateTwapResult,
} from "../../exchanges/hyperliquid.js";
import { HyperliquidSpotAdapter } from "../../exchanges/hyperliquid-spot.js";
import { LocalEvmSigner } from "../../signer/index.js";
import { PerpError } from "../../errors.js";

const USER = "0xabcdef0000000000000000000000000000000001";
const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

function adapterWith(routes: Record<string, (b: Record<string, unknown>) => unknown>, dex = "") {
  const hl = new HyperliquidAdapter(undefined, true);
  if (dex) hl.setDex(dex);
  hl.setAddress(USER);
  (hl as unknown as { _infoPost: (b: Record<string, unknown>) => Promise<unknown> })._infoPost = async (b) => {
    const r = routes[String(b.type)];
    if (!r) throw new Error(`unexpected info ${String(b.type)}`);
    return r(b);
  };
  return hl;
}
const codeOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as PerpError).structured?.code; } return "resolved"; };
const DEX_META = { universe: [{ name: "km:GOOGL", szDecimals: 2 }, { name: "km:US500", szDecimals: 1 }], collateralToken: 0 };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("M1: HIP-3 asset map fails closed", () => {
  it("dex listed in perpDexs → ids ≥ 110000", async () => {
    const hl = adapterWith({ meta: () => DEX_META, perpDexs: () => [null, { name: "xyz" }, { name: "km" }], userAbstraction: () => "disabled" }, "km");
    await hl.init();
    expect(await hl.getAssetIndex("GOOGL")).toBe(120000);
    expect(await hl.getAssetIndex("km:US500")).toBe(120001);
    expect(HIP3_MIN_ASSET_ID).toBe(110000);
  });

  it("dex ABSENT from perpDexs → SYMBOL_NOT_FOUND, never a native asset id (offset 0)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hl = adapterWith({ meta: () => DEX_META, perpDexs: () => [null, { name: "xyz" }], userAbstraction: () => "disabled" }, "km");
    await hl.init();
    expect(await codeOf(hl.getAssetIndex("GOOGL"))).toBe("SYMBOL_NOT_FOUND");
    await expect(hl.getAssetIndex("GOOGL")).rejects.toThrow(/not in the venue's perpDexs list/);
  });

  it("a HIP-3 adapter refuses an asset id below 110000 even if its map holds one", async () => {
    const hl = adapterWith({}, "km");
    (hl as unknown as { _assetMap: Map<string, number> })._assetMap = new Map([["GOOGL", 3]]);
    expect(await codeOf(hl.getAssetIndex("GOOGL"))).toBe("SYMBOL_NOT_FOUND");
  });
});

describe("M2: a dex prefix must be the adapter's dex", () => {
  it("foreign prefix throws instead of being rewritten onto this dex", async () => {
    const hl = adapterWith({ meta: () => DEX_META, perpDexs: () => [null, { name: "km" }], userAbstraction: () => "disabled" }, "km");
    await hl.init();
    expect(hl.resolveSymbol("KM:GOOGL")).toBe("km:GOOGL");
    expect(() => hl.resolveSymbol("xyz:GOOGL")).toThrow(/is on dex "xyz", not this adapter's dex "km"/);
    expect(await codeOf(hl.getAssetIndex("xyz:GOOGL"))).toBe("SYMBOL_NOT_FOUND");
  });

  it("a native adapter refuses any dex-prefixed symbol", () => {
    const hl = adapterWith({});
    expect(() => hl.resolveSymbol("km:GOOGL")).toThrow(/not the native perp dex/);
  });
});

describe("lower-case venue coin names (kPEPE)", () => {
  it("resolve, size and address the venue coin exactly", async () => {
    const hl = adapterWith({
      meta: () => ({ universe: [{ name: "BTC", szDecimals: 5 }, { name: "kPEPE", szDecimals: 0 }], collateralToken: 0 }),
      userAbstraction: () => "disabled",
      l2Book: (b) => { expect(b.coin).toBe("kPEPE"); return { levels: [[{ px: "0.01", sz: "1" }], [{ px: "0.011", sz: "1" }]] }; },
    });
    await hl.init();
    for (const s of ["kPEPE", "KPEPE", "kpepe-perp", "KPEPE-PERP"]) {
      expect(hl.resolveSymbol(s)).toBe("kPEPE-PERP");
      expect(await hl.getAssetIndex(s)).toBe(1);
    }
    expect(hl.getSzDecimals("KPEPE")).toBe(0);
    await hl.getOrderbook("KPEPE");
  });
});

describe("M8: the perp adapter lists perp orders only", () => {
  it("spot rows (@index, BASE/QUOTE) are excluded, so cancel-all / flatten never touch or fail on them", async () => {
    expect(hlIsSpotCoin("@107")).toBe(true);
    expect(hlIsSpotCoin("PURR/USDC")).toBe(true);
    expect(hlIsSpotCoin("BTC")).toBe(false);
    const hl = adapterWith({
      meta: () => ({ universe: [{ name: "BTC", szDecimals: 5 }], collateralToken: 0 }),
      userAbstraction: () => "disabled",
      frontendOpenOrders: () => [
        { oid: 1, coin: "BTC", side: "B", limitPx: "1", sz: "1", isTrigger: false },
        { oid: 2, coin: "@107", side: "B", limitPx: "1", sz: "1", isTrigger: false },
        { oid: 3, coin: "PURR/USDC", side: "A", limitPx: "1", sz: "1", isTrigger: false },
      ],
    });
    await hl.init();
    expect((await hl.getOpenOrders()).map(o => o.orderId)).toEqual(["1"]);
    const sent: unknown[] = [];
    (hl as unknown as Record<string, unknown>).ensureSigner = () => {};
    (hl as unknown as Record<string, unknown>)._signAndSendAction = async (a: unknown) => { sent.push(a); return { response: { data: { statuses: ["success"] } } }; };
    await hl.cancelAllOrders();
    expect(sent).toEqual([{ type: "cancel", cancels: [{ a: 0, o: 1 }] }]);
  });
});

describe("dexAbstraction is handled explicitly (not as unified)", () => {
  const chs = { marginSummary: { accountValue: "250", totalMarginUsed: "10" }, withdrawable: "240", assetPositions: [] };

  it("native perps: the PERP state is the balance (USDC defaults to the perp balance)", async () => {
    const hl = adapterWith({ meta: () => ({ universe: [], collateralToken: 0 }), userAbstraction: () => "dexAbstraction", clearinghouseState: () => chs });
    await hl.init();
    expect(hl.isUnifiedAccount).toBe(false);
    expect(await hl.getBalance()).toMatchObject({ equity: "250", available: "240" });
  });

  it("a USDC-collateral HIP-3 dex is refused with a remediation instead of a guessed balance", async () => {
    const hl = adapterWith({ meta: () => DEX_META, perpDexs: () => [null, { name: "km" }], userAbstraction: () => "dexAbstraction", clearinghouseState: () => chs }, "km");
    await hl.init();
    await expect(hl.getBalance()).rejects.toMatchObject({ structured: { code: "NOT_IMPLEMENTED", remediation: expect.stringContaining("account-mode") } });
  });
});

describe("native TWAP result is validated", () => {
  it("running / success pass; an error under an ok envelope → ORDER_REJECTED; unknown shape → ORDER_PENDING", () => {
    expect(() => hlValidateTwapResult({ status: "ok", response: { type: "twapOrder", data: { status: { running: { twapId: 7 } } } } }, "TWAP")).not.toThrow();
    expect(() => hlValidateTwapResult({ status: "ok", response: { type: "twapCancel", data: { status: "success" } } }, "TWAP cancel")).not.toThrow();
    const code = (r: unknown) => { try { hlValidateTwapResult(r, "TWAP"); } catch (e) { return (e as PerpError).structured.code; } return "ok"; };
    expect(code({ status: "ok", response: { type: "twapOrder", data: { status: { error: "Order has zero size." } } } })).toBe("ORDER_REJECTED");
    expect(code({ status: "ok", response: { type: "default" } })).toBe("ORDER_PENDING");
  });

  it("twapOrder throws on a refused TWAP instead of returning the ok envelope", async () => {
    const hl = adapterWith({
      meta: () => ({ universe: [{ name: "BTC", szDecimals: 5 }], collateralToken: 0 }), userAbstraction: () => "disabled",
      metaAndAssetCtxs: () => [{ universe: [{ name: "BTC" }] }, [{ markPx: "60000" }]],
    });
    await hl.init();
    (hl as unknown as Record<string, unknown>)._signAndSendAction = async () => ({ status: "ok", response: { type: "twapOrder", data: { status: { error: "Insufficient margin" } } } });
    expect(await codeOf(hl.twapOrder("BTC", "buy", "1", 30))).toBe("ORDER_REJECTED");
  });

  it("documented bounds are pre-checked: 5 minutes – 7 days, $100 minimum total size at mark; nothing is sent outside them", async () => {
    // docs trading/order-types: "Running time can be set from 5 minutes to 7 days, with a $100 minimum total order size."
    const code = (size: string, minutes: number, mark: number) => { try { hlAssertTwapBounds("BTC", size, minutes, mark); } catch (e) { return (e as PerpError).structured.code; } return "ok"; };
    expect(code("1", 5, 60000)).toBe("ok");
    expect(code("1", 10080, 60000)).toBe("ok");          // 7 days (was refused above 1440)
    expect(code("1", 4, 60000)).toBe("INVALID_PARAMS");
    expect(code("1", 10081, 60000)).toBe("INVALID_PARAMS");
    expect(code("1", 30.5, 60000)).toBe("INVALID_PARAMS");
    expect(code("0.002", 30, 50000)).toBe("ok");         // exactly $100
    expect(code("0.0016", 30, 60000)).toBe("SIZE_TOO_SMALL"); // $96
    expect(code("abc", 30, 60000)).toBe("INVALID_PARAMS");

    const hl = adapterWith({
      meta: () => ({ universe: [{ name: "BTC", szDecimals: 5 }], collateralToken: 0 }), userAbstraction: () => "disabled",
      metaAndAssetCtxs: () => [{ universe: [{ name: "BTC" }] }, [{ markPx: "60000" }]],
    });
    await hl.init();
    const send = vi.fn();
    (hl as unknown as Record<string, unknown>)._signAndSendAction = send;
    expect(await codeOf(hl.twapOrder("BTC", "buy", "0.001", 30))).toBe("SIZE_TOO_SMALL");
    expect(await codeOf(hl.twapOrder("BTC", "buy", "1", 20000))).toBe("INVALID_PARAMS");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("init / scheduleCancel / top-level err envelope", () => {
  it("init() propagates a failed userAbstraction read instead of keeping isUnifiedAccount=false", async () => {
    const hl = adapterWith({
      meta: () => ({ universe: [{ name: "BTC", szDecimals: 5 }], collateralToken: 0 }),
      userAbstraction: () => { throw new PerpError("EXCHANGE_ERROR", "Hyperliquid info userAbstraction failed (502)"); },
    });
    expect(await codeOf(hl.init())).toBe("EXCHANGE_ERROR");
  });

  it("scheduleCancel() without a time signs and posts the SAME action: no `time` key (python SDK schedule_cancel)", async () => {
    const hl = adapterWith({});
    const sent: Array<Record<string, unknown>> = [];
    (hl as unknown as Record<string, unknown>)._signAndSendAction = async (a: Record<string, unknown>) => { sent.push(a); return { status: "ok" }; };
    await hl.scheduleCancel();
    await hl.scheduleCancel(1_800_000_000_000);
    expect(sent[0]).toEqual({ type: "scheduleCancel" });
    expect("time" in sent[0]).toBe(false);
    expect(sent[1]).toEqual({ type: "scheduleCancel", time: 1_800_000_000_000 });
  });

  it("a top-level err envelope on an L1 action is a definite refusal: ORDER_REJECTED (orders) / ACTION_REJECTED (others), balance / margin codes kept", () => {
    const code = (type: string, msg: string) => (hlL1ActionRejection(type, new HlErrResponse(msg)) as PerpError).structured;
    expect(code("order", "Order has invalid price.")).toMatchObject({ code: "ORDER_REJECTED", retryable: false });
    expect(code("batchModify", "Cannot modify canceled or filled order")).toMatchObject({ code: "ORDER_REJECTED" });
    expect(code("cancel", "User or API Wallet 0xabc does not exist.")).toMatchObject({ code: "ACTION_REJECTED", retryable: false });
    expect(code("updateLeverage", "Cannot decrease leverage with open position")).toMatchObject({ code: "ACTION_REJECTED" });
    expect(code("agentSendAsset", "Unknown token")).toMatchObject({ code: "ACTION_REJECTED" });
    expect(code("order", "Insufficient margin to place order.").code).toBe("MARGIN_INSUFFICIENT");
    expect(code("agentSendAsset", "Insufficient balance").code).toBe("INSUFFICIENT_BALANCE");
    // No envelope (transport / parse failure): returned unchanged — the outcome is unknown.
    const net = new Error("fetch failed");
    expect(hlL1ActionRejection("order", net)).toBe(net);
  });
});

describe("withdraw3 / usdSend destination", () => {
  it("validated and lower-cased; anything else is refused before signing", async () => {
    expect(hlDestination("0x5E9ee1089755c3435139848e47e6635505d5a13A")).toBe("0x5e9ee1089755c3435139848e47e6635505d5a13a");
    for (const bad of ["", "0x123", "5e9ee1089755c3435139848e47e6635505d5a13a", "0x0000000000000000000000000000000000000000", "0xZZ9ee1089755c3435139848e47e6635505d5a13a"]) {
      expect(() => hlDestination(bad)).toThrow(PerpError);
    }
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const hl = new HyperliquidAdapter(undefined, true);
    hl.setSigner(await LocalEvmSigner.create(KEY));
    expect(await codeOf(hl.withdraw("5", "not-an-address"))).toBe("INVALID_PARAMS");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("trigger orders: market-trigger limit price and `trade stop` kind", () => {
  async function trig(mark: string | null = "120") {
    const hl = adapterWith({
      meta: () => ({ universe: [{ name: "SOL", szDecimals: 2 }], collateralToken: 0 }),
      userAbstraction: () => "disabled",
      frontendOpenOrders: () => [],
      l2Book: () => ({ levels: [[{ px: "119.9", sz: "1" }], [{ px: "120.1", sz: "1" }]] }),
      metaAndAssetCtxs: () => [{ universe: [{ name: "SOL" }] }, [{ markPx: mark }]],
    });
    await hl.init();
    const sent: Array<{ orders: Array<{ p: string; t: { trigger: { isMarket: boolean; triggerPx: string; tpsl: string } } }> }> = [];
    Object.assign(hl as unknown as Record<string, unknown>, {
      ensureSigner: () => {},
      _signAndSendAction: async (a: never) => { sent.push(a); return { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } }; },
    });
    return { hl, sent };
  }

  it("hlTriggerKind: adverse side of the reference = sl, the other = tp", () => {
    expect(hlTriggerKind("sell", 116, 120)).toBe("sl");
    expect(hlTriggerKind("sell", 125, 120)).toBe("tp");
    expect(hlTriggerKind("buy", 125, 120)).toBe("sl");
    expect(hlTriggerKind("buy", 116, 120)).toBe("tp");
  });

  it("a market trigger never sends p = trigger: p is trigger ∓ the venue's 10% market TP/SL tolerance", async () => {
    const { hl, sent } = await trig();
    await hl.stopOrder("SOL", "sell", "0.5", "116", { reduceOnly: true });
    const o = sent[0].orders[0];
    expect(o.t.trigger).toMatchObject({ isMarket: true, triggerPx: "116", tpsl: "sl" });
    expect(HL_MARKET_TPSL_SLIPPAGE_BPS).toBe(1000);
    expect(Number(o.p)).toBeCloseTo(104.4, 6);
    expect(o.p).not.toBe("116");
    await hl.stopOrder("SOL", "buy", "0.5", "125", { reduceOnly: true });
    expect(Number(sent[1].orders[0].p)).toBeCloseTo(137.5, 6);
  });

  it("plain stop derives tp when the trigger is on the favourable side (was always sl)", async () => {
    const { hl, sent } = await trig();
    await hl.stopOrder("SOL", "sell", "0.5", "125", { reduceOnly: true });
    expect(sent[0].orders[0].t.trigger.tpsl).toBe("tp");
    await hl.stopOrder("SOL", "buy", "0.5", "116", { reduceOnly: true, limitPrice: "116.5" });
    expect(sent[1].orders[0].t.trigger).toMatchObject({ tpsl: "tp", isMarket: false });
    expect(sent[1].orders[0].p).toBe("116.5");
  });

  it("the kind is derived from the MARK price (HL triggers on mark), not the book mid; no mark → PRICE_STALE, nothing sent", async () => {
    // Book mid 120, mark 124: a sell trigger at 122 is BELOW the mark → sl (the mid would say tp).
    const { hl, sent } = await trig("124");
    await hl.stopOrder("SOL", "sell", "0.5", "122", { reduceOnly: true });
    expect(sent[0].orders[0].t.trigger.tpsl).toBe("sl");
    await hl.stopOrder("SOL", "buy", "0.5", "122", { reduceOnly: true });
    expect(sent[1].orders[0].t.trigger.tpsl).toBe("tp");

    const stale = await trig(null);
    expect(await codeOf(stale.hl.stopOrder("SOL", "sell", "0.5", "122", { reduceOnly: true }))).toBe("PRICE_STALE");
    expect(stale.sent).toHaveLength(0);
  });
});

describe("HIP-3 collateral funding with the master wallet", () => {
  it("is refused (usdClassTransfer would fund the native perp dex, not the HIP-3 dex)", async () => {
    const hl = new HyperliquidAdapter(undefined, true);
    hl.setDex("km");
    hl.setSigner(await LocalEvmSigner.create(KEY));
    const usdClassTransfer = vi.spyOn(hl, "usdClassTransfer").mockResolvedValue({});
    const spot = new HyperliquidSpotAdapter(hl);
    await expect(spot.transferUsdcToPerp(10)).rejects.toMatchObject({ structured: { code: "NOT_IMPLEMENTED" } });
    expect(usdClassTransfer).not.toHaveBeenCalled();
  });

  it("native perps with the master still use usdClassTransfer", async () => {
    const hl = new HyperliquidAdapter(undefined, true);
    hl.setSigner(await LocalEvmSigner.create(KEY));
    const usdClassTransfer = vi.spyOn(hl, "usdClassTransfer").mockResolvedValue({});
    await new HyperliquidSpotAdapter(hl).transferUsdcToPerp(10);
    expect(usdClassTransfer).toHaveBeenCalledWith("10", true);
  });
});
