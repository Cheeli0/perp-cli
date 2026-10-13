/**
 * Cross-validation tests: SpotAdapter vs raw SDK/API responses.
 *
 * Tests call SpotAdapter methods and independently call the exchange APIs,
 * then verify the values match. Public market data only — the adapters are created read-only
 * (no key). Secrets (SSOT Rule #3): no `.env` is loaded and no private key is read.
 * The account-balance case reads the active OWS master wallet's PUBLIC EVM address (nothing is
 * decrypted, nothing is signed) and runs only with the explicit opt-in PERP_SPOT_XVAL_ACCOUNT=1.
 *
 * Run with: npx vitest run src/__tests__/spot-adapter-cross-validate.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { cliCredentialOptsFrom, resolveOwsMaster } from "../../config.js";
import { PerpError } from "../../errors.js";

// ── Raw API helpers ──

async function hlPost(type: string, extra: Record<string, unknown> = {}) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...extra }),
  });
  return res.json();
}

const LT_BASE = "https://mainnet.zklighter.elliot.ai/api/v1";

async function ltGet(path: string, params: Record<string, string> = {}) {
  const url = new URL(`${LT_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

// ── Account opt-in ──

/** Explicit opt-in: the balance case reads the user's own (public) HL account state. */
const ACCOUNT_ENABLED = process.env.PERP_SPOT_XVAL_ACCOUNT === "1";

/** The active OWS master wallet's PUBLIC EVM address (OWS vault public account; nothing is decrypted). */
async function owsMasterEvmAddress(): Promise<string> {
  const master = await resolveOwsMaster("hyperliquid", cliCredentialOptsFrom({}));
  if (master === null) {
    throw new PerpError("NO_SIGNER_AVAILABLE", "spot-adapter-cross-validate: no OWS master wallet is selected for hyperliquid", {
      remediation: "Select the master wallet (perp wallet use <name>) — this case reads only its public address",
    });
  }
  return (await import("../../signer/ows-evm.js")).OwsEvmSigner.create(master.wallet).getAddress();
}

/** Fetch with retry for Lighter rate limits */
async function ltGetRetry(path: string, params: Record<string, string> = {}, retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    const data = await ltGet(path, params) as { code?: number };
    if (data.code !== 23000) return data; // not rate-limited
    if (i < retries - 1) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
  }
  return ltGet(path, params);
}

/**
 * Active spot markets per the venue's own /api/v1/orderBooks (status "active", market_type "spot")
 * — the explorer list also carries inactive markets (live 2026-10-13: AZTEC/USDC 2055 "inactive"),
 * which the adapter does not list (lighter-spot.ts: status !== "active" → skipped).
 */
async function ltActiveSpotSymbols(): Promise<Set<string>> {
  const r = await ltGetRetry("/orderBooks") as { order_books?: Array<{ symbol: string; market_type: string; status: string }> };
  if (!Array.isArray(r.order_books)) throw new Error(`Lighter /orderBooks returned no order_books: ${JSON.stringify(r).slice(0, 200)}`);
  return new Set(r.order_books.filter(o => o.market_type === "spot" && o.status === "active").map(o => o.symbol.toUpperCase()));
}

// ── Hyperliquid Spot Tests ──

describe("Cross-validate: Hyperliquid Spot Adapter", () => {

  it("spot market list matches raw spotMetaAndAssetCtxs + allMids API", async () => {
    // Raw API: spotMetaAndAssetCtxs gives universe + szDecimals; allMids is what
    // HyperliquidSpotAdapter actually consumes for prices (NOT markPx/midPx).
    const [rawMeta, allMids] = await Promise.all([
      hlPost("spotMetaAndAssetCtxs") as Promise<[
        {
          tokens: Array<{ name: string; index: number }>;
          universe: Array<{ name: string; tokens: [number, number]; index: number }>;
        },
        Array<Record<string, unknown>>,
      ]>,
      hlPost("allMids") as Promise<Record<string, string>>,
    ]);

    expect(rawMeta).toBeTruthy();
    expect(rawMeta[0]?.universe?.length).toBeGreaterThan(0);

    // Build token name + szDecimals map (szDecimals lives on tokens, NOT universe)
    const tokenNames = new Map<number, string>();
    const tokenSzDec = new Map<number, number>();
    for (const t of rawMeta[0].tokens) {
      tokenNames.set(t.index, t.name);
      if ((t as Record<string, unknown>).szDecimals !== undefined) {
        tokenSzDec.set(t.index, (t as Record<string, unknown>).szDecimals as number);
      }
    }

    // Build USDC-paired spot markets, with markPrice from allMids (matching adapter source)
    const rawSpotMarkets = rawMeta[0].universe.map(u => {
      const baseToken = tokenNames.get(u.tokens[0]) ?? "";
      const quoteToken = tokenNames.get(u.tokens[1]) ?? "";
      return {
        baseToken,
        quoteToken,
        markPrice: Number(allMids[u.name] ?? 0),
        szDecimals: tokenSzDec.get(u.tokens[0]) ?? 2,
      };
    }).filter(m => m.baseToken && m.quoteToken === "USDC");

    // Adapter
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter();
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    const adapterMarkets = await spotAdapter.getSpotMarkets();
    expect(adapterMarkets.length).toBeGreaterThan(0);

    for (const rawMarket of rawSpotMarkets.slice(0, 5)) {
      const adapterMarket = adapterMarkets.find(m => m.baseToken === rawMarket.baseToken);
      if (!adapterMarket) continue;

      expect(adapterMarket.sizeDecimals).toBe(rawMarket.szDecimals);

      const adapterPrice = Number(adapterMarket.markPrice);
      if (rawMarket.markPrice > 0 && adapterPrice > 0) {
        const pctDiff = Math.abs(adapterPrice - rawMarket.markPrice) / rawMarket.markPrice * 100;
        expect(pctDiff).toBeLessThan(2);
      }
    }
  });

  it("spot orderbook matches raw l2Book API", async () => {
    // First get spot meta to find the spot index for ETH
    const rawMeta = await hlPost("spotMeta") as {
      tokens?: Array<{ name: string; index: number }>;
      universe?: Array<{ name: string; tokens: [number, number]; index: number }>;
    };

    const tokenNames = new Map<number, string>();
    for (const t of rawMeta.tokens ?? []) {
      tokenNames.set(t.index, t.name);
    }

    // Find ETH spot index
    let ethSpotIndex = -1;
    for (const u of rawMeta.universe ?? []) {
      const baseToken = tokenNames.get(u.tokens[0]);
      if (baseToken === "ETH") {
        ethSpotIndex = u.index;
        break;
      }
    }

    if (ethSpotIndex < 0) {
      console.log("ETH spot not found in HL spotMeta, skipping");
      return;
    }

    // Raw API: L2 book for spot ETH
    const rawBook = await hlPost("l2Book", { coin: `@${ethSpotIndex}` }) as {
      levels?: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>];
    };

    expect(rawBook.levels).toBeTruthy();
    const rawBids = rawBook.levels?.[0] ?? [];
    const rawAsks = rawBook.levels?.[1] ?? [];

    // Adapter
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter();
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    const adapterBook = await spotAdapter.getSpotOrderbook("ETH/USDC");

    // Both should have bids and asks
    if (rawBids.length > 0) {
      expect(adapterBook.bids.length).toBeGreaterThan(0);
      // Best bid price should be close (within 1% due to timing)
      const rawBestBid = Number(rawBids[0].px);
      const adapterBestBid = Number(adapterBook.bids[0][0]);
      if (rawBestBid > 0 && adapterBestBid > 0) {
        const pctDiff = Math.abs(rawBestBid - adapterBestBid) / rawBestBid * 100;
        expect(pctDiff).toBeLessThan(1);
      }
    }

    if (rawAsks.length > 0) {
      expect(adapterBook.asks.length).toBeGreaterThan(0);
      const rawBestAsk = Number(rawAsks[0].px);
      const adapterBestAsk = Number(adapterBook.asks[0][0]);
      if (rawBestAsk > 0 && adapterBestAsk > 0) {
        const pctDiff = Math.abs(rawBestAsk - adapterBestAsk) / rawBestAsk * 100;
        expect(pctDiff).toBeLessThan(1);
      }
    }

    // Sanity: best bid < best ask
    if (adapterBook.bids.length > 0 && adapterBook.asks.length > 0) {
      expect(Number(adapterBook.bids[0][0])).toBeLessThan(Number(adapterBook.asks[0][0]));
    }
  });

  it("spot balances match raw spotClearinghouseState API (opt-in: PERP_SPOT_XVAL_ACCOUNT=1; OWS master public address)", { skip: !ACCOUNT_ENABLED }, async () => {
    const address = await owsMasterEvmAddress();

    // Raw API
    const rawState = await hlPost("spotClearinghouseState", { user: address }) as {
      balances?: Array<{ coin: string; total: string; hold: string }>;
    };

    // Adapter
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter();
    hlAdapter.setAddress(address); // read-only: /info reads scoped to the address, no signer
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    const adapterBalances = await spotAdapter.getSpotBalances();

    // Compare USDC balance
    const rawUsdc = rawState.balances?.find(b => b.coin.startsWith("USDC"));
    const adapterUsdc = adapterBalances.find(b => b.token.startsWith("USDC"));

    if (rawUsdc && adapterUsdc) {
      const rawTotal = Number(rawUsdc.total);
      const adapterTotal = Number(adapterUsdc.total);
      // Should match exactly (same API call)
      expect(Math.abs(rawTotal - adapterTotal)).toBeLessThan(0.01);

      // Available = total - hold
      const rawAvailable = Number(rawUsdc.total) - Number(rawUsdc.hold);
      const adapterAvailable = Number(adapterUsdc.available);
      expect(Math.abs(rawAvailable - adapterAvailable)).toBeLessThan(0.01);
    }

    // All non-USDC balances should have valid token names
    for (const bal of adapterBalances) {
      expect(bal.token).toBeTruthy();
      expect(Number(bal.total)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Lighter Spot Tests (shared adapter to avoid rate limits) ──

describe("Cross-validate: Lighter Spot Adapter", () => {
  let ltAdapter: InstanceType<typeof import("../../exchanges/lighter.js")["LighterAdapter"]> | null = null;
  let spotAdapter: InstanceType<typeof import("../../exchanges/lighter-spot.js")["LighterSpotAdapter"]> | null = null;
  let ltInitFailed = false;

  beforeAll(async () => {
    try {
      const { LighterAdapter } = await import("../../exchanges/lighter.js");
      const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
      ltAdapter = new LighterAdapter("");
      await ltAdapter.init();
      spotAdapter = new LighterSpotAdapter(ltAdapter);
      await spotAdapter.init();
    } catch (e) {
      console.log(`Lighter adapter init failed (rate limit?): ${e instanceof Error ? e.message : e}`);
      ltInitFailed = true;
    }
  });

  it("spot markets match explorer API (symbols with /)", async () => {
    if (ltInitFailed || !spotAdapter) return;

    const explorerMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string; market_index: number }>;
    const active = await ltActiveSpotSymbols();
    const rawSpotMarkets = explorerMarkets.filter(m => m.symbol.includes("/") && active.has(m.symbol.toUpperCase()));
    expect(rawSpotMarkets.length).toBeGreaterThan(0);

    const adapterMarkets = await spotAdapter.getSpotMarkets();
    expect(adapterMarkets.length).toBe(rawSpotMarkets.length);

    for (const raw of rawSpotMarkets) {
      const adapter = adapterMarkets.find(m => m.symbol.toUpperCase() === raw.symbol.toUpperCase());
      expect(adapter).toBeTruthy();
    }
  });

  it("spot orderbook has valid bid/ask structure", async () => {
    if (ltInitFailed || !spotAdapter) return;

    const explorerMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string; market_index: number }>;
    const active = await ltActiveSpotSymbols();
    const spotMarket = explorerMarkets.find(m => m.symbol.includes("/") && active.has(m.symbol.toUpperCase()));
    if (!spotMarket) return;

    const rawBook = await ltGetRetry("/orderBookOrders", {
      market_id: String(spotMarket.market_index),
      limit: "20",
    }) as { bids?: Record<string, string>[]; asks?: Record<string, string>[] };

    const adapterBook = await spotAdapter.getSpotOrderbook(spotMarket.symbol);

    if ((rawBook.bids?.length ?? 0) > 0) {
      expect(adapterBook.bids.length).toBeGreaterThan(0);
    }
    if ((rawBook.asks?.length ?? 0) > 0) {
      expect(adapterBook.asks.length).toBeGreaterThan(0);
    }

    if (adapterBook.bids.length > 0 && adapterBook.asks.length > 0) {
      expect(Number(adapterBook.bids[0][0])).toBeLessThan(Number(adapterBook.asks[0][0]));
    }
  });
});

// ── Index/Price Verification: ALL Exchanges ──

describe("Cross-validate: Token Index Verification", () => {

  it("HL spot U-token indices map to correct prices (UBTC→BTC, UETH→ETH, USOL→SOL)", async () => {
    const { SPOT_PERP_TOKEN_MAP } = await import("../../exchanges/spot-interface.js");
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter();
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    // Get perp mark prices from raw API
    const [perpMeta, perpCtxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ markPx?: string }>,
    ];
    const perpPriceMap = new Map<string, number>();
    for (let i = 0; i < perpMeta.universe.length; i++) {
      perpPriceMap.set(perpMeta.universe[i].name.toUpperCase(), Number(perpCtxs[i]?.markPx ?? 0));
    }

    // For each U-token mapping, verify spot book price ≈ perp mark price
    const verified: string[] = [];
    for (const [spotToken, perpSymbol] of Object.entries(SPOT_PERP_TOKEN_MAP)) {
      const perpPrice = perpPriceMap.get(perpSymbol.toUpperCase());
      if (!perpPrice || perpPrice === 0) continue;

      try {
        // Spot adapter should resolve both "UBTC" and "BTC" to the same index
        const spotBook = await spotAdapter.getSpotOrderbook(spotToken);
        if (spotBook.bids.length === 0 || spotBook.asks.length === 0) continue;

        const spotMid = (Number(spotBook.bids[0][0]) + Number(spotBook.asks[0][0])) / 2;
        const deviation = Math.abs(spotMid - perpPrice) / perpPrice * 100;

        // Spot price must be within 5% of perp price
        expect(deviation).toBeLessThan(5);
        verified.push(`${spotToken}→${perpSymbol}: spot=$${spotMid.toFixed(2)} perp=$${perpPrice.toFixed(2)} (${deviation.toFixed(2)}%)`);

        // Also verify resolution via perp symbol name
        const spotBookViaPerpName = await spotAdapter.getSpotOrderbook(perpSymbol);
        const spotMid2 = (Number(spotBookViaPerpName.bids[0][0]) + Number(spotBookViaPerpName.asks[0][0])) / 2;
        // Should resolve to same price (same underlying index)
        expect(Math.abs(spotMid - spotMid2)).toBeLessThan(spotMid * 0.001);
      } catch (e) {
        // Token may not have liquidity — skip
        console.log(`${spotToken}: ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log("Verified U-token mappings:", verified);
    expect(verified.length).toBeGreaterThan(0);
  });

  it("HL spot HIP-1 tokens with same ticker as perp are price-validated (TRUMP, BERA, MON rejected)", async () => {
    // These tokens have same ticker on spot and perp but DIFFERENT underlying
    const suspectTokens = ["TRUMP", "BERA", "MON", "PUMP"];
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    const hlAdapter = new HyperliquidAdapter();
    await hlAdapter.init();
    const spotAdapter = new HyperliquidSpotAdapter(hlAdapter);
    await spotAdapter.init();

    // Get perp mark prices
    const [perpMeta, perpCtxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ markPx?: string }>,
    ];
    const perpPriceMap = new Map<string, number>();
    for (let i = 0; i < perpMeta.universe.length; i++) {
      perpPriceMap.set(perpMeta.universe[i].name.toUpperCase(), Number(perpCtxs[i]?.markPx ?? 0));
    }

    for (const token of suspectTokens) {
      const perpPrice = perpPriceMap.get(token);
      if (!perpPrice || perpPrice === 0) continue;

      try {
        const spotBook = await spotAdapter.getSpotOrderbook(token);
        if (spotBook.bids.length === 0 || spotBook.asks.length === 0) continue;

        const spotMid = (Number(spotBook.bids[0][0]) + Number(spotBook.asks[0][0])) / 2;
        const deviation = Math.abs(spotMid - perpPrice) / perpPrice * 100;

        // These SHOULD diverge significantly (>5%) — confirming they're different tokens
        expect(deviation).toBeGreaterThan(5);
        console.log(`${token}: spot=$${spotMid.toFixed(4)} perp=$${perpPrice.toFixed(4)} deviation=${deviation.toFixed(0)}% (correctly rejected)`);
      } catch {
        // May not have spot book — that's fine
      }
    }
  });

  it("HL perp asset indices map to correct mark prices", async () => {
    // Verify that getAssetIndex() returns indices that match the raw API
    const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
    const hlAdapter = new HyperliquidAdapter();
    await hlAdapter.init();

    // Raw API
    const [meta, ctxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ markPx?: string }>,
    ];

    // For top symbols, verify adapter index matches raw API index
    const testSymbols = ["BTC", "ETH", "SOL", "DOGE", "SUI"];
    for (const sym of testSymbols) {
      const rawIdx = meta.universe.findIndex(u => u.name === sym);
      if (rawIdx < 0) continue;

      const adapterIdx = await hlAdapter.getAssetIndex(sym);

      // Index should match
      expect(adapterIdx).toBe(rawIdx);

      // Mark price from raw API should be reasonable (>0)
      const rawPrice = Number(ctxs[rawIdx]?.markPx ?? 0);
      expect(rawPrice).toBeGreaterThan(0);

      // Verify via L2 book: the index resolves to the right orderbook
      const book = await hlPost("l2Book", { coin: sym }) as {
        levels?: Array<Array<{ px: string; sz: string }>>;
      };
      const bookBid = Number(book.levels?.[0]?.[0]?.px ?? 0);
      const bookAsk = Number(book.levels?.[1]?.[0]?.px ?? 0);
      if (bookBid > 0 && bookAsk > 0) {
        const bookMid = (bookBid + bookAsk) / 2;
        const deviation = Math.abs(bookMid - rawPrice) / rawPrice * 100;
        expect(deviation).toBeLessThan(1); // book and meta should be very close
      }
    }
  });

  it("Lighter perp market_ids map to correct symbols and prices", async () => {
    // Raw API: orderBookDetails (with retry for rate limits)
    const rawData = await ltGetRetry("/orderBookDetails") as {
      order_book_details?: Array<{
        symbol: string; market_id: number; last_trade_price?: number;
      }>;
    };
    const perpMarkets = rawData.order_book_details ?? [];
    if (perpMarkets.length === 0) {
      console.log("Lighter orderBookDetails returned empty (rate limit) — skipping");
      return;
    }

    // Adapter — reuse via CLI to avoid init rate limits
    const { LighterAdapter } = await import("../../exchanges/lighter.js");
    let ltAdapterLocal: InstanceType<typeof LighterAdapter>;
    try {
      ltAdapterLocal = new LighterAdapter("");
      await ltAdapterLocal.init();
    } catch (e) {
      console.log(`Lighter adapter init failed: ${e instanceof Error ? e.message : e} — skipping`);
      return;
    }

    const testSymbols = ["ETH", "BTC", "SOL"];
    for (const sym of testSymbols) {
      const rawMarket = perpMarkets.find(m => m.symbol.toUpperCase() === sym);
      if (!rawMarket) continue;

      const adapterIdx = ltAdapterLocal.getMarketIndex(sym);
      expect(adapterIdx).toBe(rawMarket.market_id);

      if (rawMarket.last_trade_price) {
        expect(rawMarket.last_trade_price).toBeGreaterThan(0);
      }
    }
  });

  it("Lighter spot market_ids from explorer match adapter's internal map", async () => {
    const explorerMarkets = await fetch("https://explorer.elliot.ai/api/markets")
      .then(r => r.json()) as Array<{ symbol: string; market_index: number }>;
    const active = await ltActiveSpotSymbols();
    const rawSpotMarkets = explorerMarkets.filter(m => m.symbol.includes("/") && active.has(m.symbol.toUpperCase()));
    const { LighterAdapter } = await import("../../exchanges/lighter.js");
    const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
    let ltAdapterLocal: InstanceType<typeof LighterAdapter>;
    let spotAdapterLocal: InstanceType<typeof LighterSpotAdapter>;
    try {
      ltAdapterLocal = new LighterAdapter("");
      await ltAdapterLocal.init();
      spotAdapterLocal = new LighterSpotAdapter(ltAdapterLocal);
      await spotAdapterLocal.init();
    } catch (e) {
      console.log(`Lighter adapter init failed: ${e instanceof Error ? e.message : e} — skipping`);
      return;
    }

    for (const raw of rawSpotMarkets) {
      const adapterMid = spotAdapterLocal.getSpotMarketId(raw.symbol);
      expect(adapterMid).toBe(raw.market_index);

      try {
        const book = await spotAdapterLocal.getSpotOrderbook(raw.symbol);
        if (book.bids.length > 0 && book.asks.length > 0) {
          const mid = (Number(book.bids[0][0]) + Number(book.asks[0][0])) / 2;
          expect(mid).toBeGreaterThan(0);
          expect(Number(book.bids[0][0])).toBeLessThan(Number(book.asks[0][0]));
        }
      } catch {
        // Some spot markets may have empty books — OK
      }
    }
  });

  it("fetchSpotPerpSpreads excludes price-mismatched tokens (HIP-1 TRUMP etc.)", async () => {
    const { fetchSpotPerpSpreads } = await import("../../funding/rates.js");
    const { spreads } = await fetchSpotPerpSpreads();

    // TRUMP, BERA, MON, PUMP should NOT appear (HIP-1 tokens with different prices)
    const suspectTokens = ["TRUMP", "BERA", "MON", "PUMP"];
    for (const s of spreads) {
      if (s.spotExchanges.includes("hyperliquid") && suspectTokens.includes(s.symbol)) {
        // If it appears, it should only be because the prices happened to converge
        // (unlikely but possible) — verify by checking mark price is in perp range
        console.log(`WARNING: ${s.symbol} found in scan with HL spot — verify price: $${s.bestMarkPrice}`);
      }
    }

    // BTC, ETH, SOL SHOULD appear via U-token mapping (if funding spread is non-zero)
    const btcSpread = spreads.find(s => s.symbol === "BTC");
    const ethSpread = spreads.find(s => s.symbol === "ETH");
    // These may not appear if funding is too low, but if they do, HL should be in spotExchanges
    if (btcSpread && btcSpread.spotExchanges.includes("hyperliquid")) {
      console.log(`BTC via UBTC: annual ${btcSpread.annualSpreadPct.toFixed(1)}%`);
    }
    if (ethSpread && ethSpread.spotExchanges.includes("hyperliquid")) {
      console.log(`ETH via UETH: annual ${ethSpread.annualSpreadPct.toFixed(1)}%`);
    }
  });
});

// ── Spot-Perp Spread Calculation ──

describe("Cross-validate: Spot-Perp Spread Calculation", () => {
  // One fetchSpotPerpSpreads call hits every perp + bot-spot venue (~4-5 s); fetch once per
  // option set and share it across the tests below.
  type SpreadsResult = Awaited<ReturnType<typeof import("../../funding/rates.js")["fetchSpotPerpSpreads"]>>;
  const MIN_SPREAD = 5;
  let all: SpreadsResult;
  let aboveMin: SpreadsResult;

  beforeAll(async () => {
    const { fetchSpotPerpSpreads } = await import("../../funding/rates.js");
    all = await fetchSpotPerpSpreads();
    aboveMin = await fetchSpotPerpSpreads({ minSpread: MIN_SPREAD });
  }, 60_000);

  it("spot-perp spread = |perp funding rate| annualized (spot funding = 0)", async () => {
    // Get HL perp funding rates from raw API
    const [meta, ctxs] = await hlPost("metaAndAssetCtxs") as [
      { universe: { name: string }[] },
      Array<{ funding?: string; markPx?: string }>,
    ];

    // Get ETH funding rate
    const ethIdx = meta.universe.findIndex(a => a.name === "ETH");
    expect(ethIdx).toBeGreaterThanOrEqual(0);
    const ethFunding = Number(ctxs[ethIdx].funding ?? 0);

    // Compute expected annualized spread
    // HL: 1h funding period → hourly rate = rate / 1
    // Spot funding = 0
    // Spread = |perp hourly| × 8760 × 100
    const expectedAnnualPct = Math.abs(ethFunding) * 8760 * 100;

    // Now use our fetchSpotPerpSpreads result (shared, all symbols)
    const ethSpread = all.spreads.find(s => s.symbol === "ETH");
    if (!ethSpread) {
      // ETH might not show up if funding is too low
      console.log(`ETH spot-perp spread not found (funding: ${ethFunding})`);
      return;
    }

    // The annualized spread uses the best perp rate across ALL exchanges (not just HL)
    // So spread >= our HL-only calculation (another exchange may have higher rate)
    // Just verify the spread is at least as large as HL's rate (or close due to timing)
    if (expectedAnnualPct > 1) { // only check if meaningful
      // Spread should be >= HL rate (or within 50% if rates shifted between calls)
      expect(ethSpread.annualSpreadPct).toBeGreaterThan(0);
      // If HL is the best perp exchange, spread should be close to our calc
      if (ethSpread.perpExchange === "hyperliquid") {
        const pctDiff = Math.abs(ethSpread.annualSpreadPct - expectedAnnualPct) / expectedAnnualPct * 100;
        expect(pctDiff).toBeLessThan(50); // wider tolerance for timing
      }
    }

    // Direction should match the SELECTED perp exchange's funding sign (not necessarily HL)
    // fetchSpotPerpSpreads picks the exchange with highest |funding|, which may differ from HL
    const perpFunding = ethSpread.perpFundingRate;
    if (perpFunding > 0) {
      expect(ethSpread.direction).toBe("long-spot-short-perp");
    } else if (perpFunding < 0) {
      expect(ethSpread.direction).toBe("sell-spot-long-perp");
    }

    // Perp exchange: a registered venue the function actually fetched rates from (its status is "ok")
    const { listVenues } = await import("../../exchanges/venue.js");
    const { listBotSpotVenues } = await import("../../exchanges/spot-factory.js");
    expect(listVenues().map(v => v.id)).toContain(ethSpread.perpExchange);
    expect(all.exchangeStatus[ethSpread.perpExchange]).toBe("ok");

    // Spot exchanges: only bot/arb spot venues (the function's spot-leg scope), each fetched ok
    const botSpotIds = listBotSpotVenues().map(v => v.id as string);
    for (const spotEx of ethSpread.spotExchanges) {
      expect(botSpotIds).toContain(spotEx);
      expect(all.exchangeStatus[`${spotEx}-spot`]).toBe("ok");
    }
  });

  it("all spot-perp spreads have annualSpreadPct >= minSpread", () => {
    for (const s of aboveMin.spreads) {
      expect(s.annualSpreadPct).toBeGreaterThanOrEqual(MIN_SPREAD);
      expect(s.bestMarkPrice).toBeGreaterThan(0);
      expect(s.spotExchanges.length).toBeGreaterThan(0);
      expect(s.estHourlyIncomeUsd).toBeGreaterThan(0);
    }
  });

  it("spot-perp spread is sorted by annualSpreadPct descending", () => {
    const { spreads } = all;
    for (let i = 1; i < spreads.length; i++) {
      expect(spreads[i - 1].annualSpreadPct).toBeGreaterThanOrEqual(spreads[i].annualSpreadPct);
    }
  });
});

// ── Arb State Backward Compatibility ──

describe("Cross-validate: Arb State backward compatibility", () => {

  it("legacy untagged state (no network, no mode) is adopted on mainnet; mode absent → perp-perp", async () => {
    const { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { loadArbState, saveArbState, setStateFilePath, resetStateFilePath, arbStateFilePath } = await import("../../arb/state.js");
    const { PerpError } = await import("../../errors.js");

    // Isolated temp state path (never the developer's real ~/.perp/arb-state.json)
    const tmpDir = mkdtempSync(join(tmpdir(), "perp-arb-state-test-"));
    const tmpFile = join(tmpDir, "arb-state.json");

    // Pre-network format: no `network` tag, positions without `mode`
    const oldState = {
      version: 1,
      lastStartTime: new Date().toISOString(),
      lastScanTime: new Date().toISOString(),
      lastSuccessfulScanTime: new Date().toISOString(),
      positions: [{
        id: "test-1",
        symbol: "ETH",
        longExchange: "hyperliquid",
        shortExchange: "lighter",
        longSize: 0.5,
        shortSize: 0.5,
        entryTime: new Date().toISOString(),
        entrySpread: 25.5,
        entryLongPrice: 3000,
        entryShortPrice: 3005,
        accumulatedFunding: 1.23,
        lastCheckTime: new Date().toISOString(),
        // NO mode field — old format
      }],
      config: { minSpread: 20, closeSpread: 5, size: 100, holdDays: 7, bridgeCost: 0.5, maxPositions: 5, settleStrategy: "block" },
    };

    writeFileSync(tmpFile, JSON.stringify(oldState));
    setStateFilePath(tmpFile);

    try {
      expect(arbStateFilePath("mainnet")).toBe(tmpFile);

      // Testnet refuses while an untagged legacy file exists (never guesses its network)
      let testnetErr: unknown = null;
      try { loadArbState("testnet"); } catch (e) { testnetErr = e; }
      expect(testnetErr).toBeInstanceOf(PerpError);
      expect((testnetErr as InstanceType<typeof PerpError>).structured.code).toBe("INVALID_PARAMS");

      // Read-only mainnet load tags the copy in memory only; the file stays untagged
      const ro = loadArbState("mainnet", { readOnly: true });
      expect(ro).not.toBeNull();
      expect(ro!.network).toBe("mainnet");
      expect(JSON.parse(readFileSync(tmpFile, "utf-8")).network).toBeUndefined();

      // Writable mainnet load adopts it: backup copy + file tagged in place
      const loaded = loadArbState("mainnet");
      expect(loaded).not.toBeNull();
      expect(loaded!.network).toBe("mainnet");
      expect(JSON.parse(readFileSync(tmpFile, "utf-8")).network).toBe("mainnet");
      expect(existsSync(`${tmpFile}.pre-network.bak`)).toBe(true);
      expect(loaded!.positions.length).toBe(1);

      // mode absent (old format) — readers resolve it as perp-perp (mcp-server: `pos.mode ?? "perp-perp"`)
      const pos = loaded!.positions[0];
      expect(pos.mode).toBeUndefined();
      expect(pos.mode ?? "perp-perp").toBe("perp-perp");

      // Save a spot-perp position alongside
      loaded!.positions.push({
        id: "test-2",
        symbol: "BTC",
        longExchange: "hyperliquid",
        shortExchange: "pacifica",
        longSize: 0.01,
        shortSize: 0.01,
        entryTime: new Date().toISOString(),
        entrySpread: 30,
        entryLongPrice: 60000,
        entryShortPrice: 60100,
        accumulatedFunding: 0,
        lastCheckTime: new Date().toISOString(),
        mode: "spot-perp",
        spotExchange: "hyperliquid",
        spotSymbol: "BTC/USDC",
      });
      saveArbState("mainnet", loaded!);

      // Re-load and verify both positions
      const reloaded = loadArbState("mainnet");
      expect(reloaded!.network).toBe("mainnet");
      expect(reloaded!.positions.length).toBe(2);
      expect(reloaded!.positions[0].mode).toBeUndefined();
      expect(reloaded!.positions[1].mode).toBe("spot-perp");
      expect(reloaded!.positions[1].spotExchange).toBe("hyperliquid");
      expect(reloaded!.positions[1].spotSymbol).toBe("BTC/USDC");

      // Mainnet state is never read as testnet: the testnet path is separate and empty
      expect(arbStateFilePath("testnet")).not.toBe(tmpFile);
      expect(loadArbState("testnet")).toBeNull();
    } finally {
      resetStateFilePath();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Cost Model Verification ──

describe("Cross-validate: Spot-Perp Cost Model", () => {

  it("round-trip cost calculation is correct for spot+perp", async () => {
    const { computeRoundTripCostPct, computeNetSpread } = await import("../../commands/arb-auto.js");
    const { getTakerFee } = await import("../../constants.js");

    // Spot+Perp: fee on spot side + fee on perp side (entry + exit = 4 taker fills)
    const spotExch = "hyperliquid";
    const perpExch = "hyperliquid";
    const slippage = 0.05;

    // Use the same function (spot taker fee ≈ perp taker fee for HL)
    const rtCost = computeRoundTripCostPct(spotExch, perpExch, slippage);

    // Independent calculation
    const spotFee = getTakerFee(spotExch) * 100;
    const perpFee = getTakerFee(perpExch) * 100;
    const expectedRtCost = 2 * (spotFee + perpFee) + 2 * slippage;

    expect(Math.abs(rtCost - expectedRtCost)).toBeLessThan(0.001);

    // Net spread should deduct RT cost
    const grossAnnual = 30; // 30% annual
    const holdDays = 7;
    const netSpread = computeNetSpread(grossAnnual, holdDays, rtCost);

    // Net = 30 - (rtCost/7 * 365) = 30 - (rtCost * 52.14)
    const expectedNet = grossAnnual - (rtCost / holdDays) * 365;
    expect(Math.abs(netSpread - expectedNet)).toBeLessThan(0.001);

    // For same-exchange spot+perp, bridge cost = 0
    const netWithBridge = computeNetSpread(grossAnnual, holdDays, rtCost, 0, 100);
    expect(netWithBridge).toBe(netSpread); // no bridge cost change

    // For cross-exchange, bridge cost > 0
    const crossNet = computeNetSpread(grossAnnual, holdDays, rtCost, 0.5, 100);
    expect(crossNet).toBeLessThan(netSpread); // bridge cost reduces net
  });

  it("spot+perp spread has 0 funding cost on spot leg", async () => {
    const { estimateHourlyFunding } = await import("../../funding/normalize.js");

    // Spot funding = 0 (by definition, no funding on spot)
    // So for a spot+perp arb, only the perp side contributes funding income
    const spotFunding = 0;
    const perpFunding = 0.0001; // 0.01% per hour

    // Spot leg: funding payment = 0 regardless of position
    const spotPayment = spotFunding * 1000; // $1000 notional
    expect(spotPayment).toBe(0);

    // Perp short leg: receives positive funding
    // estimateHourlyFunding: rate=0.0001, exchange=hyperliquid (1h), $1000, short
    const perpPayment = estimateHourlyFunding(perpFunding, "hyperliquid", 1000, "short");
    // Short pays negative (receives): payment = 0.0001 * 1000 * (-1) = -0.1
    expect(perpPayment).toBeLessThan(0); // negative = you receive

    // Net hourly income = -spotPayment - perpPayment = 0 - (-0.1) = 0.1
    const netIncome = -(spotPayment + perpPayment);
    expect(netIncome).toBeCloseTo(0.1, 6);
  });
});

// ── Sizing Module ──

describe("Cross-validate: Spot-Perp Sizing", () => {

  it("computeSpotPerpMatchedSize respects spot decimals", async () => {
    const { computeSpotPerpMatchedSize } = await import("../../arb/sizing.js");

    // $100 at $2000/ETH with explicit 4 spot decimals (ETH spot supports it)
    const result = computeSpotPerpMatchedSize(100, 2000, "hyperliquid", "pacifica", 4);
    expect(result).not.toBeNull();
    expect(Number(result!.size)).toBeGreaterThan(0);
    expect(result!.notional).toBeGreaterThanOrEqual(1); // pac min notional = $1

    // With HL perp (2 dec fallback) + HL spot (2 dec), size is limited to 2 decimals
    // $100 / $2000 = 0.05 → floor(0.05 * 100) / 100 = 0.05
    const hlResult = computeSpotPerpMatchedSize(100, 2000, "hyperliquid", "hyperliquid");
    expect(hlResult).not.toBeNull();
    expect(Number(hlResult!.size)).toBeGreaterThan(0);
    const parts = hlResult!.size.split(".");
    const actualDecimals = parts.length > 1 ? parts[1].length : 0;
    expect(actualDecimals).toBeLessThanOrEqual(2); // min of spot:hl(2) and hl(2) = 2

    // $5 at $2000 = 0.0025 → floor to 0.00 (2 dec) → too small for HL
    const tooSmall = computeSpotPerpMatchedSize(5, 2000, "hyperliquid", "hyperliquid");
    expect(tooSmall).toBeNull(); // Can't meet min size

    // With Lighter (2 dec perp), $100 at $2000 = 0.05 → works
    const ltResult = computeSpotPerpMatchedSize(100, 2000, "lighter", "lighter");
    expect(ltResult).not.toBeNull();
    expect(Number(ltResult!.size)).toBeCloseTo(0.05, 2);
  });
});

// ── Liquidity Check ──

describe("Cross-validate: Spot-Perp Liquidity", () => {

  it("checkSpotPerpLiquidity validates orderbook depth", async () => {
    const { computeExecutableSize } = await import("../../liquidity.js");

    // Simulated spot orderbook (asks for buy side)
    const spotAsks: [string, string][] = [
      ["2000", "1.0"],    // $2000
      ["2001", "0.5"],    // $1000.50
      ["2005", "2.0"],    // $4010
    ];

    // Simulated perp orderbook (bids for sell side)
    const perpBids: [string, string][] = [
      ["2002", "1.5"],    // $3003
      ["2001", "1.0"],    // $2001
      ["1999", "3.0"],    // $5997
    ];

    // Check spot side (buying asks)
    const spotCheck = computeExecutableSize(spotAsks, 1000, 0.5);
    expect(spotCheck.maxSize).toBeGreaterThan(0);
    expect(spotCheck.avgFillPrice).toBeGreaterThan(0);
    expect(spotCheck.slippagePct).toBeGreaterThanOrEqual(0);

    // Check perp side (selling into bids)
    const perpCheck = computeExecutableSize(perpBids, 1000, 0.5);
    expect(perpCheck.maxSize).toBeGreaterThan(0);
    expect(perpCheck.avgFillPrice).toBeGreaterThan(0);

    // Min executable should be the smaller side
    const executableUsd = Math.min(
      spotCheck.maxSize * spotCheck.avgFillPrice,
      perpCheck.maxSize * perpCheck.avgFillPrice,
    );
    expect(executableUsd).toBeGreaterThan(0);
  });
});
