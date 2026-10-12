/**
 * Hyperliquid request weight: how much of the IP budget ONE CLI invocation spends.
 *
 * Docs ("Rate limits and user limits"): "REST requests share an aggregated weight limit of 1200
 * per minute." · "All documented `exchange` API requests have a weight of
 * `1 + floor(batch_length / 40)`." · "The following `info` requests have weight 2: `l2Book,
 * allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus.`" · "All
 * other documented `info` requests have weight 20."
 *
 * Every invocation is a fresh adapter (a new process), built the way createHyperliquid builds an
 * agent adapter, driven through the real command handlers; the fetch mock records each request.
 * "cold" = empty market-metadata disk cache, "warm" = `meta` (and `perpDexs`) cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerTradeCommands } from "../../commands/trade.js";
import { registerAccountCommands } from "../../commands/account.js";
import { HyperliquidAdapter, hlAbstractionCachePrefix } from "../../exchanges/hyperliquid.js";
import { LocalEvmSigner } from "../../signer/index.js";
import { invalidateCache } from "../../cache.js";
import type { AgentMeta } from "../../settings.js";

const MASTER = "0x00000000000000000000000000000000000000bb";
const WEIGHT_2 = new Set(["l2Book", "allMids", "clearinghouseState", "orderStatus", "spotClearinghouseState", "exchangeStatus"]);

/** Docs weight of one recorded request ("exchange:<type>" = 1 for a single-order batch; `userRole` 60 is never sent here). */
function weightOf(req: string): number {
  if (req.startsWith("exchange:")) return 1;
  return WEIGHT_2.has(req.split("{")[0]) ? 2 : 20;
}

let requests: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const CORE_UNIVERSE = [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }];
const XYZ_UNIVERSE = [{ name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10 }];

function fakeVenue(input: string | URL | Request, init?: RequestInit): Response {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  if (url.endsWith("/exchange")) {
    const type = String((body.action as { type: string }).type);
    requests.push(`exchange:${type}`);
    return json({ status: "ok", response: { type, data: { statuses: [type === "cancel" ? "success" : { resting: { oid: 123 } }] } } });
  }
  const dex = typeof body.dex === "string" ? body.dex : "";
  requests.push(`${String(body.type)}${dex ? `{${dex}}` : ""}`);
  switch (body.type) {
    case "meta": return json({ universe: dex ? XYZ_UNIVERSE : CORE_UNIVERSE, collateralToken: 0 });
    case "perpDexs": return json([null, { name: "xyz" }]);
    case "userAbstraction": return json("unifiedAccount");
    case "clearinghouseState": return json({ marginSummary: { accountValue: "100", totalMarginUsed: "0" }, withdrawable: "100", assetPositions: [] });
    case "spotClearinghouseState": return json({ balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }] });
    case "frontendOpenOrders": return json([]);
    case "metaAndAssetCtxs": return json([{ universe: dex ? XYZ_UNIVERSE : CORE_UNIVERSE }, (dex ? XYZ_UNIVERSE : CORE_UNIVERSE).map(() => ({ markPx: "300" }))]);
    case "allMids": return json({ BTC: "60000", ETH: "2000" });
    default: throw new Error(`unexpected info request: ${String(body.type)}`);
  }
}

const AGENT: AgentMeta = {
  agentName: "default", agentWalletName: "hl-agent", agentEvmAddress: "0x00000000000000000000000000000000000000aa",
  userEvmAddress: MASTER, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  masterWalletName: "main", owsApiKeyId: "ows_key_test", owsPolicyId: "policy-test", approvedAt: new Date().toISOString(),
  permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false }, asterApprovalNonce: "0",
};

/** A fresh adapter per invocation (venues/create-helpers.ts createHyperliquid, agent without a local master). */
async function agentAdapter(dex: string | null): Promise<HyperliquidAdapter> {
  const a = new HyperliquidAdapter(undefined, false);
  if (dex !== null) a.setDex(dex);
  a.setAddress(MASTER);
  await a.init();
  a.setAgentSigner(AGENT, await LocalEvmSigner.create(`0x${"11".repeat(32)}`));
  return a;
}

async function invoke(dex: string | null, args: string[]): Promise<{ requests: string[]; weight: number }> {
  requests = [];
  const program = new Command();
  addRootSafetyOptions(program);
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const getAdapter = () => agentAdapter(dex);
  registerTradeCommands(program, getAdapter, () => true);
  registerAccountCommands(program, getAdapter, () => true);
  await program.parseAsync(["node", "perp", ...args]);
  return { requests, weight: requests.reduce((s, r) => s + weightOf(r), 0) };
}

beforeEach(() => {
  invalidateCache();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => fakeVenue(input, init)));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const commands = (symbol: string): Array<{ name: string; args: string[] }> => [
  { name: "account positions", args: ["account", "positions"] },
  { name: "account orders", args: ["account", "orders"] },
  { name: "trade limit", args: ["trade", "limit", symbol, "buy", "300", "0.1"] },
  { name: "trade cancel", args: ["trade", "cancel", symbol, "123"] },
];

/**
 * Requests per invocation after the fix. `userAbstraction` (20) is read once per
 * HL_ABSTRACTION_TTL_MS for a network + address (disk cache outside the `acct:` prefix): the
 * adapter still resolves the per-user account mode at init (isUnifiedAccount — spot/perp balance
 * accounting depends on it), but a warm invocation does not ask the venue again.
 */
const EXPECTED: Record<string, { warm: string[]; weight: number }> = {
  "account positions": { warm: ["clearinghouseState"], weight: 2 },
  "account orders": { warm: ["frontendOpenOrders"], weight: 20 },
  // Local risk check: balance + positions share ONE clearinghouseState; unified account → spot state. Lot step from cached meta.
  "trade limit": { warm: ["clearinghouseState", "spotClearinghouseState", "exchange:order"], weight: 5 },
  "trade cancel": { warm: ["exchange:cancel"], weight: 1 },
};

describe.each([["core", null, "ETH"], ["--dex xyz", "xyz", "TSLA"]] as const)("hyperliquid %s weight per CLI invocation", (_label, dex, symbol) => {
  const meta = dex === null ? ["meta"] : [`meta{${dex}}`, "perpDexs"];
  const tag = (r: string) => (dex !== null && (r === "clearinghouseState" || r === "frontendOpenOrders") ? `${r}{${dex}}` : r);

  it.each(commands(symbol))("$name: metadata read once per cache window, nothing the command does not need", async (c) => {
    const cold = await invoke(dex, c.args);
    invalidateCache("acct"); // account state is never reused across invocations here
    const warm = await invoke(dex, c.args);
    const want = EXPECTED[c.name];
    expect(warm.requests).toEqual(want.warm.map(tag));
    expect(warm.weight).toBe(want.weight);
    expect(cold.requests).toEqual([...meta, "userAbstraction", ...want.warm.map(tag)]);
    expect(cold.weight).toBe(want.weight + 20 * (meta.length + 1));
  });

  it("the account mode is read again after its cache entry is dropped (wallet manage account-mode) — never served stale past that", async () => {
    await invoke(dex, ["account", "positions"]);
    invalidateCache("acct");
    invalidateCache(hlAbstractionCachePrefix("mainnet"));
    const again = await invoke(dex, ["account", "positions"]);
    expect(again.requests).toEqual(["userAbstraction", tag("clearinghouseState")]);
  });

  it("_getAbstractionMode({ fresh: true }) always asks the venue", async () => {
    const a = await agentAdapter(dex);
    requests = [];
    await a._getAbstractionMode();
    expect(requests).toEqual([]);
    await a._getAbstractionMode({ fresh: true });
    expect(requests).toEqual(["userAbstraction"]);
  });

  it("a rate-limited meta read is RATE_LIMITED for the order, never 'Unknown asset'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type?: string };
      return body.type === "meta" ? new Response("rate limited", { status: 429 }) : fakeVenue(input, init);
    }));
    const a = await agentAdapter(dex);
    await expect(a.getAssetIndex(symbol)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
  });

  it("a failed meta load at init prints nothing and fails only the calls that need it, with the real cause", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type?: string };
      return body.type === "meta" ? new Response("rate limited", { status: 429 }) : fakeVenue(input, init);
    }));
    const a = await agentAdapter(dex);
    expect(err).not.toHaveBeenCalled();
    // The size step (sync) and the asset id both surface the stored cause — one behaviour.
    expect(() => a.getSzDecimals(symbol)).toThrow(/rate limited \(HTTP 429\)/);
    await expect(a.getAssetIndex(symbol)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    // A read that needs no market metadata still works.
    await expect(a._getAbstractionMode()).resolves.toBe("unified");
  });

  it("the lot step comes from the loaded meta (no metaAndAssetCtxs / allMids read)", async () => {
    const { lotStepOf } = await import("../../exchanges/precision.js");
    const a = await agentAdapter(dex);
    requests = [];
    expect(await lotStepOf(a, symbol)).toBe(dex === null ? "0.0001" : "0.001");
    expect(requests).toEqual([]);
  });

  it("a failed read before an order / cancel / leverage change is ORDER_REJECTED 'not sent' and nothing is posted", async () => {
    const a = await agentAdapter(dex);
    // The asset map is gone (as after a failed init load) and `meta` is rate limited.
    const maps = a as unknown as { _assetMap: Map<string, number>; _szDecimalsMap: Map<string, number> };
    maps._assetMap.clear(); maps._szDecimalsMap.clear();
    invalidateCache("mkt");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type?: string };
      if (body.type === "meta" || body.type === "frontendOpenOrders") { requests.push(String(body.type)); return new Response("rate limited", { status: 429 }); }
      return fakeVenue(input, init);
    }));
    requests = [];
    const notSent = { structured: { code: "ORDER_REJECTED", retryable: false, details: { exchange: "hyperliquid" } } };
    await expect(a.limitOrder(symbol, "buy", "300", "0.1")).rejects.toMatchObject(notSent);
    await expect(a.limitOrder(symbol, "buy", "300", "0.1")).rejects.toThrow(/^hyperliquid limit buy 0\.1 .* not sent: hyperliquid: rate limited \(HTTP 429\)$/);
    await expect(a.cancelOrder(symbol, "123")).rejects.toMatchObject(notSent);
    await expect(a.updateLeverage(symbol, 3, false)).rejects.toMatchObject(notSent);
    await expect(a.cancelAllOrders()).rejects.toMatchObject(notSent);
    await expect(a.editOrder(symbol, "123", "300", "0.1")).rejects.toMatchObject(notSent);
    expect(requests.some(r => r.startsWith("exchange:"))).toBe(false);
  });
});
