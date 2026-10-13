import { describe, it, expect } from "vitest";
import { fetchAllDexAssets, findDexArbPairs, scanDexArb, type DexAsset } from "../../dex-asset-map.js";

/**
 * Pick, from live assets, an underlying listed on >= 2 distinct dexes (native "hl" counts as one)
 * with at least one cross-dex price within `maxGapPct` (same product). Highest combined 24h volume
 * wins. null = no such underlying at run time (live HIP-3 listings drift).
 */
function pickMultiDexUnderlying(assets: DexAsset[], maxGapPct = 2): { base: string; assets: DexAsset[] } | null {
  const byBase = new Map<string, DexAsset[]>();
  for (const a of assets) {
    const list = byBase.get(a.base);
    if (list) list.push(a); else byBase.set(a.base, [a]);
  }
  let best: { base: string; assets: DexAsset[]; volume: number } | null = null;
  for (const [base, group] of byBase) {
    if (new Set(group.map(a => a.dex)).size < 2) continue;
    const close = group.some((a, i) => group.slice(i + 1).some(b =>
      a.dex !== b.dex && Math.abs(a.markPrice - b.markPrice) / ((a.markPrice + b.markPrice) / 2) * 100 < maxGapPct));
    if (!close) continue;
    const volume = group.reduce((s, a) => s + a.volume24h, 0);
    if (best === null || volume > best.volume) best = { base, assets: group, volume };
  }
  return best === null ? null : { base: best.base, assets: best.assets };
}

/**
 * Integration tests for HIP-3 cross-dex arb scanning.
 *
 * Hits real Hyperliquid mainnet API (read-only, no private key needed).
 *
 * Run: pnpm --filter perp-cli test -- --testPathPattern dex-arb.integration
 */

describe("fetchAllDexAssets — live API", () => {
  it("returns assets from native HL and at least 3 deployed dexes", async () => {
    const assets = await fetchAllDexAssets();

    expect(assets.length).toBeGreaterThan(100);

    // Check we have native HL assets
    const hlAssets = assets.filter(a => a.dex === "hl");
    expect(hlAssets.length).toBeGreaterThan(100);
    expect(hlAssets.find(a => a.base === "BTC")).toBeTruthy();

    // Check we have at least xyz dex
    const xyzAssets = assets.filter(a => a.dex === "xyz");
    expect(xyzAssets.length).toBeGreaterThan(10);
    expect(xyzAssets.find(a => a.base === "TSLA")).toBeTruthy();

    // Verify data shape
    for (const asset of assets.slice(0, 10)) {
      expect(asset.markPrice).toBeGreaterThan(0);
      expect(typeof asset.fundingRate).toBe("number");
      expect(asset.dex).toBeTruthy();
      expect(asset.base).toBeTruthy();
      expect(asset.raw).toBeTruthy();
    }

    const dexes = new Set(assets.map(a => a.dex));
    console.log(`Dexes found: ${[...dexes].join(", ")} (${dexes.size} total)`);
    console.log(`Total active assets: ${assets.length}`);
  }, 30000);
});

describe("findDexArbPairs — live data", () => {
  it("finds arb pairs for an underlying listed on >= 2 dexes", async (ctx) => {
    const assets = await fetchAllDexAssets();
    const pick = pickMultiDexUnderlying(assets);
    if (pick === null) {
      ctx.skip("no underlying is currently listed on >= 2 dexes (incl. native) at a matching price — live HIP-3 listings drifted");
      return;
    }
    const dexes = new Set(pick.assets.map(a => a.dex));
    expect(dexes.size).toBeGreaterThanOrEqual(2);

    const pairs = findDexArbPairs(pick.assets);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const p of pairs) {
      expect(p.underlying).toBe(pick.base);
      expect(p.priceGapPct).toBeLessThan(5);
      expect(p.long.dex).not.toBe(p.short.dex);
      expect(dexes.has(p.long.dex)).toBe(true);
      expect(dexes.has(p.short.dex)).toBe(true);
      // Long the lower-funding side, short the higher-funding side
      expect(p.long.fundingRate).toBeLessThanOrEqual(p.short.fundingRate);
    }
    // At least one pair has a price gap within the picker's bound (same product)
    expect(pairs.some(p => p.priceGapPct < 2)).toBe(true);

    console.log(`${pick.base} on dexes: ${[...dexes].join(", ")} → ${pairs.length} arb pairs`);
    for (const p of pairs.slice(0, 3)) {
      console.log(`  L:${p.long.dex} S:${p.short.dex} spread:${p.annualSpread.toFixed(1)}% gap:${p.priceGapPct.toFixed(3)}%`);
    }
  }, 30000);

  it("pairs a native HL perp with the same underlying on a deployed dex", async (ctx) => {
    const assets = await fetchAllDexAssets();
    const nativeBases = new Set(assets.filter(a => a.dex === "hl").map(a => a.base));
    const pick = pickMultiDexUnderlying(assets.filter(a => nativeBases.has(a.base)));
    if (pick === null) {
      ctx.skip("no native HL perp is currently also listed on a deployed dex at a matching price — live HIP-3 listings drifted");
      return;
    }
    const native = pick.assets.find(a => a.dex === "hl")!;
    const deployed = pick.assets.filter(a => a.dex !== "hl");
    expect(deployed.length).toBeGreaterThanOrEqual(1);

    const pairs = findDexArbPairs(pick.assets);
    const nativePairs = pairs.filter(p => p.long.dex === "hl" || p.short.dex === "hl");
    expect(nativePairs.length).toBeGreaterThanOrEqual(1);
    for (const p of nativePairs) {
      expect(p.underlying).toBe(pick.base);
      expect(p.long.dex).not.toBe(p.short.dex);
      expect(p.priceGapPct).toBeLessThan(5);
    }
    // includeNative: false drops every hl leg
    expect(findDexArbPairs(pick.assets, { includeNative: false }).every(p => p.long.dex !== "hl" && p.short.dex !== "hl")).toBe(true);

    console.log(`${pick.base}: hl=$${native.markPrice} vs ${deployed.map(a => `${a.dex}=$${a.markPrice}`).join(", ")} → ${nativePairs.length} native pairs`);
  }, 30000);

  it("correctly rejects USAR vs US500 (different products)", async () => {
    const assets = await fetchAllDexAssets();
    const usar = assets.find(a => a.base === "USAR");
    const us500 = assets.find(a => a.base === "US500");

    if (usar && us500) {
      // Prices should be wildly different
      const gap = Math.abs(usar.markPrice - us500.markPrice) / Math.min(usar.markPrice, us500.markPrice) * 100;
      expect(gap).toBeGreaterThan(100); // way more than 5%

      // findDexArbPairs should not match these
      const pairs = findDexArbPairs([usar, us500]);
      expect(pairs).toHaveLength(0);
      console.log(`USAR=$${usar.markPrice.toFixed(2)} vs US500=$${us500.markPrice.toFixed(2)} → gap:${gap.toFixed(0)}% → correctly rejected`);
    }
  }, 30000);
});

describe("scanDexArb — live full scan", () => {
  it("returns sorted arb opportunities", async () => {
    const pairs = await scanDexArb({ minAnnualSpread: 5 });

    expect(pairs.length).toBeGreaterThan(0);

    // Should be sorted by annualSpread descending
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i].annualSpread).toBeLessThanOrEqual(pairs[i - 1].annualSpread);
    }

    // All pairs should have different dexes
    for (const p of pairs) {
      expect(p.long.dex).not.toBe(p.short.dex);
    }

    // All pairs should have < 5% price gap
    for (const p of pairs) {
      expect(p.priceGapPct).toBeLessThan(5);
    }

    console.log(`Found ${pairs.length} arb opportunities (>5% annual spread)`);
    console.log(`Top 5:`);
    for (const p of pairs.slice(0, 5)) {
      console.log(`  ${p.underlying}: ${p.annualSpread.toFixed(1)}% [${p.long.dex}↔${p.short.dex}]`);
    }
  }, 30000);

  it("no-native mode excludes HL base assets", async () => {
    const withNative = await scanDexArb({ minAnnualSpread: 0, includeNative: true });
    const withoutNative = await scanDexArb({ minAnnualSpread: 0, includeNative: false });

    // Without native, should have fewer pairs (no hl↔dex pairs)
    const nativePairs = withNative.filter(p => p.long.dex === "hl" || p.short.dex === "hl");
    const nonNativePairs = withoutNative.filter(p => p.long.dex === "hl" || p.short.dex === "hl");

    expect(nonNativePairs.length).toBe(0);
    if (nativePairs.length > 0) {
      expect(withNative.length).toBeGreaterThan(withoutNative.length);
    }

    console.log(`With native: ${withNative.length} pairs (${nativePairs.length} include HL native)`);
    console.log(`Without native: ${withoutNative.length} pairs`);
  }, 30000);
});
