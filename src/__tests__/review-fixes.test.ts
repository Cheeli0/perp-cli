/**
 * Regressions for the venue-abstraction review findings that are not CLI-flag parsing
 * (see cli-safety.test.ts for C1/C2/H1/H2). Nothing here touches the network: fetch is
 * stubbed and every test runs under the isolated HOME (helpers/isolate-home.ts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── H3: Lighter adapter creation never signs ─────────────────────────────────

describe("H3 — Lighter master-key init does not auto-register an API key", () => {
  it("PK master, account exists, no agent → read-only, setupApiKey never called, no sendTx", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: unknown) => {
      const url = String(u);
      urls.push(url);
      if (url.includes("/api/v1/account?")) return new Response(JSON.stringify({ accounts: [{ account_index: 7, l1_address: "0x" }] }));
      if (url.includes("/orderBooks")) return new Response(JSON.stringify({ order_books: [{ symbol: "ETH", market_id: 0, supported_size_decimals: 4, supported_price_decimals: 2 }] }));
      throw new Error(`unexpected fetch ${url}`);
    }));
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const lt = LighterAdapter.forVenue("lighter", `0x${"42".repeat(32)}`, false);
    const setup = vi.spyOn(lt, "setupApiKey");
    await lt.init();
    expect(setup).not.toHaveBeenCalled();
    expect(urls.some(u => u.includes("sendTx") || u.includes("nextNonce"))).toBe(false);
    expect(lt.isReadOnly).toBe(true);
    expect(lt.accountIndex).toBe(7);
  });
});

// ── M1: Ondo / Arcus credentials follow -n ──────────────────────────────────

describe("M1 — Ondo/Arcus agent selection is network-aware", () => {
  it("resolveCredentials(ondo, testnet) never returns the mainnet key (and vice versa)", async () => {
    const store = await import("../agent-wallet/store.js");
    const { resolveCredentials, NO_CLI_CREDENTIAL_OPTS } = await import("../config.js");
    const base = { kind: "ondo" as const, keystorePath: "/x", scopes: null, approvedAt: new Date().toISOString() };
    store.setVenueAgent("ondo", { ...base, agentName: "main-key", keyId: "kMain", network: "mainnet" });
    expect((await resolveCredentials("ondo", NO_CLI_CREDENTIAL_OPTS, "testnet")).agent).toBeNull();
    store.setVenueAgent("ondo", { ...base, agentName: "test-key", keyId: "kTest", network: "testnet" });
    expect((await resolveCredentials("ondo", NO_CLI_CREDENTIAL_OPTS, "testnet")).agent).toMatchObject({ keyId: "kTest" });
    expect((await resolveCredentials("ondo", NO_CLI_CREDENTIAL_OPTS, "mainnet")).agent).toMatchObject({ keyId: "kMain" });
    expect(store.getVenueAgentForNetwork("arcus", "mainnet")).toBeNull();
  });
});

// ── L1: Pacifica revoke never widens to revoke_all ───────────────────────────

describe("L1 — Pacifica revoke with no agent address", () => {
  it.each([[null], [""]])("agent address %j → AGENT_NOT_REGISTERED, nothing signed or sent", async (addr) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const signer = { getPublicKeyBase58: () => "Master111", signMessage: vi.fn() };
    const { revokePacAgent } = await import("../commands/agent.js");
    await expect(revokePacAgent(signer as never, addr, "mainnet")).rejects.toMatchObject({ structured: { code: "AGENT_NOT_REGISTERED" } });
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── L2: Ondo / Arcus --rotate never overwrites the other network's record ────

describe("L2 — approve --rotate refuses a name registered on another network", () => {
  it.each([["ondo" as const], ["arcus" as const]])("%s: mainnet record + testnet approve --rotate → INVALID_PARAMS, record intact", async (venue) => {
    const store = await import("../agent-wallet/store.js");
    const { approveVenueAgent } = await import("../commands/agent.js");
    const meta = venue === "ondo"
      ? { kind: "ondo" as const, agentName: "shared", keyId: "kMain", keystorePath: "/x", scopes: null, network: "mainnet" as const, approvedAt: "" }
      : { kind: "arcus" as const, agentName: "shared", agentWalletName: "agent-arcus-main", apiKeyHex: "00", accountIndex: 0, ownerAddress: "0x1" as const, validUntil: "", network: "mainnet" as const, approvedAt: "" };
    store.setVenueAgent(venue, meta as never);
    await expect(approveVenueAgent({
      venue, network: "testnet", master: "main", agentName: "shared", expiresIn: "90d",
      canPerp: true, canSpot: false, canWithdraw: false, rotate: true, passphrase: "pp",
      apiKeyIndex: null, accountIndex: 0, forceSlot: false, aster: {}, ondoKey: { keyId: "kTest", secret: "s" },
    })).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(store.getVenueAgent(venue, "shared")).toMatchObject({ network: "mainnet" });
  });
});

// ── L3: key material never echoed by import errors ───────────────────────────

describe("L3 — wallet import errors never echo the key", () => {
  it("malformed Solana JSON byte array → fixed message without the input", async () => {
    const { importOwsWallet } = await import("../commands/wallet.js");
    const secret = "[12, 34, 56, 78, 90, 11, 22, 33, 44, 55, oops";
    const err = await importOwsWallet("w", "pp", { kind: "single", chain: "solana", key: secret }).then(() => null, e => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("12, 34");
    expect(err!.message).toMatch(/not valid JSON/);
  });

  it("redactSecrets strips the exact secret plus long hex / base58 / byte-array runs", async () => {
    const { redactSecrets } = await import("../commands/wallet.js");
    const hex = `0x${"ab".repeat(32)}`;
    const msg = `bad key ${hex} or ${"5".repeat(10)}${"K".repeat(40)} or [1,2,3,4,5,6,7,8,9]`;
    const out = redactSecrets(msg, [hex]);
    expect(out).not.toContain("abab");
    expect(out).not.toContain("KKKK");
    expect(out).not.toContain("1,2,3");
  });
});

// ── (b) Lighter keystore network separation + migration ──────────────────────

describe("(b) Lighter-family keystore paths are network-tagged", () => {
  it("mainnet and testnet keys for the same account+slot are separate files", async () => {
    const ks = await import("../agent-wallet/lighter-keystore.js");
    ks.saveLighterFamilyKey("lighter", "mainnet", 9, 5, "aa".repeat(20), "");
    ks.saveLighterFamilyKey("lighter", "testnet", 9, 5, "bb".repeat(20), "");
    expect(ks.lighterFamilyKeystorePath("lighter", "mainnet", 9, 5)).not.toBe(ks.lighterFamilyKeystorePath("lighter", "testnet", 9, 5));
    expect(ks.loadLighterFamilyKey("lighter", "mainnet", 9, 5, "")).toBe("aa".repeat(20));
    expect(ks.loadLighterFamilyKey("lighter", "testnet", 9, 5, "")).toBe("bb".repeat(20));
    ks.saveLighterFamilyKey("lighter-rh", "testnet", 9, 6, "cc".repeat(20), "");
    expect(() => ks.loadLighterFamilyKey("lighter-rh", "mainnet", 9, 6, "")).toThrow();
  });

  it("an untagged pre-migration file moves to the tagged path of the (network-tagged) record on first load", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ks = await import("../agent-wallet/lighter-keystore.js");
    const legacy = ks.saveLighterKey(11, 7, "dd".repeat(20), "");
    expect(existsSync(legacy)).toBe(true);
    expect(ks.loadLighterFamilyKey("lighter", "mainnet", 11, 7, "")).toBe("dd".repeat(20));
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(ks.lighterFamilyKeystorePath("lighter", "mainnet", 11, 7))).toBe(true);
    expect(ks.deleteLighterFamilyKey("lighter", "mainnet", 11, 7)).toBe(true);
  });

  it("untagged agent RECORDS still require re-registration (policy unchanged)", async () => {
    const store = await import("../agent-wallet/store.js");
    expect(() => store.agentNetworkOf("lighter", { agentName: "old" } as never)).toThrow(/no recorded network/);
  });
});

// H3 (`wallet set lighter` registers no API key) moved to wallet-set-vault.test.ts
// (wallet set now imports into the OWS vault from stdin / hidden prompt).

// ── M4 / M5: e2e runner safety helpers ───────────────────────────────────────

describe("M4/M5 — e2e runner write-outcome + exposure helpers", () => {
  it("only definite rejections are safe to continue after; EXCHANGE_ERROR / network / pending are unknown", async () => {
    const { unknownWriteOutcome, isDefiniteRejection } = await import("../../scripts/e2e/lib.js");
    const err = (code: string) => ({ ok: false, error: { code, message: "m" } });
    for (const c of ["ORDER_REJECTED", "INVALID_PARAMS", "CAPABILITY_UNSUPPORTED", "SIZE_TOO_SMALL"]) {
      expect(isDefiniteRejection(err(c))).toBe(true);
      expect(unknownWriteOutcome(err(c))).toBeNull();
    }
    for (const c of ["EXCHANGE_ERROR", "EXCHANGE_UNREACHABLE", "TIMEOUT", "UNKNOWN", "ORDER_PENDING", "ORDER_PARTIAL", "RATE_LIMITED"]) {
      expect(isDefiniteRejection(err(c))).toBe(false);
      expect(unknownWriteOutcome(err(c))).toMatch(/may have executed/);
    }
    expect(unknownWriteOutcome({ ok: true })).toBeNull();
  });

  it("openExposureUsd sums positions + unfilled resting orders and refuses unvaluable rows", async () => {
    const { openExposureUsd } = await import("../../scripts/e2e/lib.js");
    expect(openExposureUsd(
      [{ symbol: "ETH", size: "-0.5", markPrice: "2000" }, { symbol: "BTC", size: "0", markPrice: "1" }],
      [{ symbol: "ETH", size: "1", filled: "0.25", price: "1000" }],
    )).toBe(1000 + 750);
    expect(() => openExposureUsd([{ symbol: "ETH", size: "1" }], [])).toThrow(/cannot value/);
    expect(() => openExposureUsd([], [{ symbol: "ETH", size: "1", price: "0" }])).toThrow(/cannot value/);
  });

  it("spot holdings acquired during the run count toward exposure at the public mid; unreadable → throw", async () => {
    const { spotHoldingOf, spotAcquiredUsd } = await import("../../scripts/e2e/lib.js");
    const data = { exchange: "hyperliquid", balances: [{ token: "USDC", total: "50", available: "50" }, { token: "HYPE", total: "1.5", available: "1" }] };
    expect(spotHoldingOf(data, "hype")).toBe(1.5);
    expect(spotHoldingOf(data, "ETH")).toBe(0); // non-zero rows only → absent = 0
    expect(() => spotHoldingOf({ exchange: "x" }, "HYPE")).toThrow(/no balances array/);
    expect(() => spotHoldingOf({ balances: [{ token: "HYPE", total: "abc" }] }, "HYPE")).toThrow(/cannot read/);
    expect(spotAcquiredUsd(0.5, 1.5, 20)).toBe(20);
    expect(spotAcquiredUsd(1.5, 1.5, null)).toBe(0); // nothing acquired → no price needed
    expect(spotAcquiredUsd(2, 1, null)).toBe(0); // sold below baseline → no new exposure
    expect(() => spotAcquiredUsd(0, 1, null)).toThrow(/no public mid/);
    expect(() => spotAcquiredUsd(0, 1, Number.NaN)).toThrow(/no public mid/);
  });

  it("spot reference price must be within 5% of the public price; no public price → refuse", async () => {
    const { spotRefPriceProblem } = await import("../../scripts/e2e/lib.js");
    expect(spotRefPriceProblem(102, 100)).toBeNull();
    expect(spotRefPriceProblem(106, 100)).toMatch(/off the public price/);
    expect(spotRefPriceProblem(10, 100)).toMatch(/off the public price/);
    expect(spotRefPriceProblem(100, null)).toMatch(/no public reference/);
  });
});
