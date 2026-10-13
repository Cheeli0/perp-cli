/**
 * Review L7: HIP-3 dex scan (dex-asset-map) reads Hyperliquid market data from the SELECTED
 * network (-n → setSharedApiNetwork), not a hard-coded mainnet URL. fetch is mocked.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { setSharedApiNetwork } from "../api/public/urls.js";
import { fetchAllDexAssets } from "../dex-asset-map.js";

afterEach(() => {
  setSharedApiNetwork("mainnet");
  vi.unstubAllGlobals();
});

describe("dex-asset-map follows the selected network", () => {
  it.each([
    ["testnet", "https://api.hyperliquid-testnet.xyz/info"],
    ["mainnet", "https://api.hyperliquid.xyz/info"],
  ] as const)("%s → %s", async (network, url) => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);
    setSharedApiNetwork(network);
    await fetchAllDexAssets().catch(() => { /* empty mocked payloads may not parse — only the URL matters */ });
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls as unknown as Array<[string]>) expect(call[0]).toBe(url);
  });
});
