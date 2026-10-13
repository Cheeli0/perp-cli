/**
 * `perp wallet agent import <venue>` — keys created on the exchange WEBSITE (no master wallet on
 * this computer). Per venue: happy path (record fields, storage) + verification refusal (nothing
 * stored), argv key rejection, network separation, revoke / rotate for imported keys, `list`
 * source column, and no key material in any output.
 *
 * HOME is a per-file temp dir (helpers/isolate-home.ts). OWS is an in-memory fake; every venue
 * request goes to a mocked fetch — no network. Lighter's WASM signer is stubbed on the adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import { ethers } from "ethers";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { addRootSafetyOptions } from "../../cli-flags.js";

const HOME = process.env.HOME ?? "";
const PERP_DIR = resolve(HOME, ".perp");

// ── Fake OWS vault ──
type FakeWallet = { id: string; name: string; accounts: Array<{ chainId: string; address: string; derivationPath: string }>; createdAt: string };
const vault = new Map<string, FakeWallet>();
const mockOws = {
  listWallets: vi.fn(() => [...vault.values()]),
  deleteWallet: vi.fn((name: string) => { vault.delete(name); }),
  importWalletPrivateKey: vi.fn((name: string, key: string, _pp: string, _idx: unknown, chain: string) => {
    const accounts = chain === "evm"
      ? [{ chainId: "eip155:1", address: new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`).address, derivationPath: "" }]
      : [{ chainId: "solana:mainnet", address: Keypair.fromSeed(Uint8Array.from(Buffer.from(key, "hex"))).publicKey.toBase58(), derivationPath: "" }];
    const w = { id: `w-${name}`, name, accounts, createdAt: "2026-10-02T00:00:00.000Z" };
    vault.set(name, w);
    return w;
  }),
};
vi.mock("../../signer/ows-loader.js", () => ({ loadOws: () => mockOws }));

const { importVenueAgent, importedAgentWalletName, defaultImportAgentName } = await import("../../commands/agent-import.js");
const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const { getAgent, getVenueAgent } = await import("../../agent-wallet/store.js");
const { loadSettings } = await import("../../settings.js");
const { LighterAdapter } = await import("../../exchanges/lighter.js");
const { lighterFamilyKeystorePath } = await import("../../agent-wallet/lighter-keystore.js");

// ── Keys (test-only) ──
const HL_KEY = `0x${"11".repeat(32)}`;
const HL_AGENT = new ethers.Wallet(HL_KEY).address;
const MASTER_EVM = new ethers.Wallet(`0x${"99".repeat(32)}`).address;
const PAC_SEED = Uint8Array.from(Buffer.from("22".repeat(32), "hex"));
const PAC_KP = Keypair.fromSeed(PAC_SEED);
const PAC_KEY = bs58.encode(PAC_KP.secretKey); // Phantom-style 64-byte base58 export
const PAC_MASTER = Keypair.fromSeed(Uint8Array.from(Buffer.from("33".repeat(32), "hex"))).publicKey.toBase58();
const ARCUS_KEY = "44".repeat(32);
const ARCUS_PUB = Buffer.from(Keypair.fromSeed(Uint8Array.from(Buffer.from(ARCUS_KEY, "hex"))).publicKey.toBytes()).toString("hex");
const LT_KEY = "ab".repeat(40);
const ONDO_ID = "ondoKeyId_abc123";
const ONDO_SECRET = "ondoApiSecret_supersecretvalue123";
const ALL_SECRETS = [HL_KEY, HL_KEY.slice(2), PAC_KEY, ARCUS_KEY, LT_KEY, ONDO_SECRET];

// ── fetch router ──
type Route = (url: string, init: RequestInit | undefined) => Response | null;
let routes: Route[] = [];
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  for (const r of routes) {
    const res = r(url, init);
    if (res !== null) return res;
  }
  throw new Error(`unexpected fetch ${url}`);
});
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bodyType = (init: RequestInit | undefined): string | null => {
  try { return (JSON.parse(String(init?.body)) as { type?: string }).type ?? null; } catch { return null; }
};

function hlRoutes(opts: { role?: unknown; validUntil?: number; testnetOnly?: boolean } = {}): Route {
  return (url, init) => {
    if (!url.endsWith("/info")) return null;
    if (opts.testnetOnly === true && !url.includes("testnet")) return json({ role: "missing" });
    const t = bodyType(init);
    if (t === "userRole") return json(opts.role ?? { role: "agent", data: { user: MASTER_EVM.toLowerCase() } });
    if (t === "extraAgents") return json([{ name: "web", address: HL_AGENT.toLowerCase(), validUntil: opts.validUntil ?? Date.now() + 86_400_000 }]);
    return null;
  };
}

function base(venue: string, secret: { kind: "key"; key: string } | { kind: "ondo"; keyId: string; secret: string }, extra: Record<string, unknown> = {}) {
  return {
    venue, network: "mainnet", agentName: null, masterAddress: null, accountIndex: null, apiKeyIndex: null,
    expiresIn: null, replace: false, secret, ...extra,
  } as Parameters<typeof importVenueAgent>[0];
}

function makeProgram() {
  const prog = new Command();
  addRootSafetyOptions(prog);
  prog.exitOverride();
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  // Machine output only with an explicit --json (like the real root flag).
  registerWalletAgentCommands(prog.command("wallet"), () => false);
  return prog;
}

/** Run a CLI command; captures stdout (console.log + process.stdout.write) and the exit. */
async function run(args: string[]): Promise<{ out: string; exited: boolean; chunks: string[] }> {
  const chunks: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { chunks.push(a.map(String).join(" ")); });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { chunks.push(String(s)); return true; }) as never);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
  let exited = false;
  try {
    await makeProgram().parseAsync(["node", "perp", ...args]);
  } catch (e) {
    if (e instanceof Error && e.message === "process.exit") exited = true;
    else throw e;
  } finally {
    log.mockRestore();
    write.mockRestore();
    exit.mockRestore();
  }
  return { out: chunks.join("\n"), exited, chunks };
}

/** Last stdout chunk that is a JSON envelope (printJson may pretty-print across lines). */
function lastEnvelope(out: string | { chunks: string[] }): { ok: boolean; data?: any; error?: any } {
  const chunks = typeof out === "string" ? [out] : out.chunks;
  for (let i = chunks.length - 1; i >= 0; i--) {
    try { return JSON.parse(chunks[i]); } catch { /* not JSON */ }
  }
  throw new Error("no JSON envelope in output");
}

function setStdin(text: string | null): void {
  Object.defineProperty(process.stdin, "isTTY", { value: text === null, configurable: true });
  if (text === null) return;
  vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
  vi.spyOn(process.stdin, "on").mockImplementation(((ev: string, cb: (x?: string) => void) => {
    if (ev === "data") queueMicrotask(() => cb(text));
    if (ev === "end") setTimeout(() => cb(), 0);
    return process.stdin;
  }) as never);
}

beforeEach(() => {
  expect(HOME).toContain("perp-cli-test-home-");
  rmSync(PERP_DIR, { recursive: true, force: true });
  vault.clear();
  vi.clearAllMocks();
  routes = [];
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("import: hyperliquid", () => {
  it("verifies userRole = agent of the master, stores the key in OWS, records source/master/network", async () => {
    routes = [hlRoutes()];
    const o = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }));
    expect(o).toMatchObject({ venue: "hyperliquid", source: "imported", agentName: "web-hl", masterAddress: MASTER_EVM, agentAddress: HL_AGENT });
    expect(o.verification.status).toBe("verified");
    const meta = getAgent("hyperliquid", "web-hl")!;
    expect(meta).toMatchObject({
      source: "imported", network: "mainnet", masterWalletName: "", userEvmAddress: MASTER_EVM, agentEvmAddress: HL_AGENT,
      agentWalletName: importedAgentWalletName("hyperliquid", "web-hl"),
    });
    expect(meta.expiresAt).not.toBe("");
    expect(vault.has("agent-hl-import-web-hl")).toBe(true);
    // settings hold no secret (SSOT Rule #3)
    const raw = readFileSync(resolve(PERP_DIR, "settings.json"), "utf-8");
    for (const s of ALL_SECRETS) expect(raw).not.toContain(s);
  });

  it("refuses a key that is not an approved API wallet — nothing stored, key not echoed", async () => {
    routes = [hlRoutes({ role: { role: "missing" } })];
    const err = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY })).catch(e => e);
    expect(err.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(JSON.stringify(err.structured)).not.toContain(HL_KEY.slice(2));
    expect(getAgent("hyperliquid", "web-hl")).toBeNull();
    expect(vault.size).toBe(0);
  });

  it("refuses a --master-address that is not the key's master", async () => {
    routes = [hlRoutes()];
    const err = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { masterAddress: "0x000000000000000000000000000000000000dEaD" })).catch(e => e);
    expect(err.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(vault.size).toBe(0);
  });

  it("-n testnet checks the testnet host; a mainnet-only key is refused there", async () => {
    routes = [(url, init) => {
      if (!url.endsWith("/info")) return null;
      expect(url).toContain("testnet");
      return bodyType(init) === "userRole" ? json({ role: "missing" }) : json([]);
    }];
    const err = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { network: "testnet" })).catch(e => e);
    expect(err.structured.code).toBe("AGENT_NOT_REGISTERED");
  });
});

describe("import: aster", () => {
  it("verifies with a signed read (user=master, signer=agent); works on testnet (approve is unsupported there)", async () => {
    routes = [(url) => {
      if (!url.includes("/fapi/v3/balance")) return null;
      expect(url).toContain("testnet");
      const q = new URL(url).searchParams;
      expect(q.get("user")?.toLowerCase()).toBe(MASTER_EVM.toLowerCase());
      expect(q.get("signer")?.toLowerCase()).toBe(HL_AGENT.toLowerCase());
      return json([]);
    }];
    const o = await importVenueAgent(base("aster", { kind: "key", key: HL_KEY }, { network: "testnet", masterAddress: MASTER_EVM }));
    expect(o).toMatchObject({ venue: "aster", network: "testnet", agentName: "web-aster-tn", verification: { status: "verified" } });
    expect(getAgent("aster", "web-aster-tn")).toMatchObject({ source: "imported", network: "testnet", userEvmAddress: MASTER_EVM });
  });

  it("refuses when Aster rejects the signer — nothing stored", async () => {
    routes = [(url) => url.includes("/fapi/v3/balance") ? json({ code: -1000, msg: "Signature check failed" }, 401) : null];
    const err = await importVenueAgent(base("aster", { kind: "key", key: HL_KEY }, { masterAddress: MASTER_EVM })).catch(e => e);
    expect(err.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(getAgent("aster", "web-aster")).toBeNull();
    expect(vault.size).toBe(0);
  });

  it("requires --master-address", async () => {
    const err = await importVenueAgent(base("aster", { kind: "key", key: HL_KEY })).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("import: pacifica", () => {
  it("stores the agent key and reports the binding as UNVERIFIED (no read-only agent check exists)", async () => {
    const o = await importVenueAgent(base("pacifica", { kind: "key", key: PAC_KEY }, { masterAddress: PAC_MASTER }));
    expect(o.verification.status).toBe("unverified");
    expect(o.verification.method).toMatch(/master-signed/);
    expect(getAgent("pacifica", "web-pac")).toMatchObject({
      source: "imported", agentSolanaAddress: PAC_KP.publicKey.toBase58(), userSolanaAddress: PAC_MASTER, masterWalletName: "",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed master address and an unparsable key (input not shown)", async () => {
    expect((await importVenueAgent(base("pacifica", { kind: "key", key: PAC_KEY }, { masterAddress: "nope" })).catch(e => e)).structured.code).toBe("INVALID_PARAMS");
    const err = await importVenueAgent(base("pacifica", { kind: "key", key: "not-a-key-zzzzzzzz" }, { masterAddress: PAC_MASTER })).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.message).not.toContain("not-a-key-zzzzzzzz");
  });
});

describe("import: lighter", () => {
  function lighterRoutes(owner = MASTER_EVM): Route {
    return (url) => url.includes("/api/v1/account?by=index&value=77")
      ? json({ code: 200, accounts: [{ account_index: 77, l1_address: owner.toLowerCase() }] })
      : null;
  }
  beforeEach(() => {
    vi.spyOn(LighterAdapter.prototype, "init").mockResolvedValue(undefined);
  });

  it("verifies account + slot + accepted auth token, stores the key in the network-tagged keystore", async () => {
    routes = [lighterRoutes()];
    vi.spyOn(LighterAdapter.prototype, "listApiKeys").mockResolvedValue([{ apiKeyIndex: 6, publicKey: "0xPUBKEY6" }]);
    const accepted = vi.spyOn(LighterAdapter.prototype, "assertAgentKeyAccepted").mockResolvedValue(undefined);
    const o = await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 6 }));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(o).toMatchObject({ accountIndex: 77, apiKeyIndex: 6, publicKey: "PUBKEY6", masterAddress: MASTER_EVM, verification: { status: "verified" } });
    expect(getAgent("lighter", "web-lt")).toMatchObject({ source: "imported", accountIndex: 77, apiKeyIndex: 6, publicKey: "PUBKEY6", userEvmAddress: MASTER_EVM, network: "mainnet" });
    const path = lighterFamilyKeystorePath("lighter", "mainnet", 77, 6);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).not.toContain(LT_KEY);
  });

  it("refuses when the venue does not accept the key for the slot — nothing stored", async () => {
    routes = [lighterRoutes()];
    vi.spyOn(LighterAdapter.prototype, "listApiKeys").mockResolvedValue([{ apiKeyIndex: 6, publicKey: "0xPUBKEY6" }]);
    vi.spyOn(LighterAdapter.prototype, "assertAgentKeyAccepted").mockRejectedValue(new Error(`invalid auth for ${LT_KEY}`));
    const err = await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 6 })).catch(e => e);
    expect(err.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(JSON.stringify(err.structured)).not.toContain(LT_KEY);
    expect(getAgent("lighter", "web-lt")).toBeNull();
    expect(existsSync(lighterFamilyKeystorePath("lighter", "mainnet", 77, 6))).toBe(false);
  });

  it("refuses an empty slot and requires --account-index / --api-key-index", async () => {
    routes = [lighterRoutes()];
    vi.spyOn(LighterAdapter.prototype, "listApiKeys").mockResolvedValue([{ apiKeyIndex: 6, publicKey: "0x0000" }]);
    expect((await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 6 })).catch(e => e)).structured.code).toBe("AGENT_NOT_REGISTERED");
    expect((await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { apiKeyIndex: 6 })).catch(e => e)).structured.code).toBe("INVALID_PARAMS");
    expect((await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77 })).catch(e => e)).structured.code).toBe("INVALID_PARAMS");
  });
});

describe("import: arcus", () => {
  const listRoute = (status: string): Route => (url) => url.includes("/v1/apiKeys")
    ? json({ apiKeys: [{ apiKey: ARCUS_PUB, address: MASTER_EVM.toLowerCase(), status, accountIndex: 2, validUntil: Date.now() + 86_400_000 }] })
    : null;

  it("verifies the derived public key is ACTIVE for the owner and stores the key in OWS", async () => {
    routes = [listRoute("ACTIVE")];
    const o = await importVenueAgent(base("arcus", { kind: "key", key: ARCUS_KEY }, { masterAddress: MASTER_EVM }));
    expect(o).toMatchObject({ publicKey: ARCUS_PUB, accountIndex: 2, verification: { status: "verified" } });
    expect(getVenueAgent("arcus", "web-arcus")).toMatchObject({ source: "imported", apiKeyHex: ARCUS_PUB, accountIndex: 2, ownerAddress: MASTER_EVM.toLowerCase() });
  });

  it("refuses a key that is not ACTIVE, and a mismatched --account-index", async () => {
    routes = [listRoute("DELETED")];
    expect((await importVenueAgent(base("arcus", { kind: "key", key: ARCUS_KEY }, { masterAddress: MASTER_EVM })).catch(e => e)).structured.code).toBe("AGENT_NOT_REGISTERED");
    routes = [listRoute("ACTIVE")];
    expect((await importVenueAgent(base("arcus", { kind: "key", key: ARCUS_KEY }, { masterAddress: MASTER_EVM, accountIndex: 5 })).catch(e => e)).structured.code).toBe("INVALID_PARAMS");
    expect(vault.size).toBe(0);
  });
});

/** Ondo approve/import: GET /v1/account (open) + GET /v1/api_keys listing every test key id. */
function ondoOk(): Route {
  return (url) => url.includes("/v1/account") ? json({ success: true, result: { accountID: "acct-1", accountState: "open", withdrawalFeeUSD: "1" } })
    : url.includes("/v1/api_keys") ? json({ success: true, result: [ONDO_ID, "ondoKeyId_new456"].map(keyId => ({ keyId, name: "web", createdAt: "", scopes: ["trade"] })) })
    : null;
}

describe("import: ondo", () => {
  it("authenticates GET /v1/account and records source=imported", async () => {
    routes = [ondoOk()];
    const o = await importVenueAgent(base("ondo", { kind: "ondo", keyId: ONDO_ID, secret: ONDO_SECRET }));
    expect(o.verification.status).toBe("verified");
    expect(getVenueAgent("ondo", "web-ondo")).toMatchObject({ source: "imported", keyId: ONDO_ID, network: "mainnet" });
  });

  it("refuses a rejected key (nothing stored, secret not echoed)", async () => {
    routes = [(url) => url.includes("/v1/account") ? json({ success: false, error: "unauthorized", error_code: "unauthorized" }, 401) : null];
    const err = await importVenueAgent(base("ondo", { kind: "ondo", keyId: ONDO_ID, secret: ONDO_SECRET })).catch(e => e);
    expect(JSON.stringify(err.structured)).not.toContain(ONDO_SECRET);
    expect(getVenueAgent("ondo", "web-ondo")).toBeNull();
  });
});

describe("network separation and name collisions", () => {
  it("refuses a name already used on the other network, and an existing name without --replace", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { agentName: "web-hl" }));
    const other = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { agentName: "web-hl", network: "testnet" })).catch(e => e);
    expect(other.structured.code).toBe("INVALID_PARAMS");
    expect(other.structured.message).toMatch(/already registered on mainnet/);
    const dup = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { agentName: "web-hl" })).catch(e => e);
    expect(dup.structured.code).toBe("INVALID_PARAMS");
    expect(dup.structured.remediation).toMatch(/--replace/);
  });

  it("--replace swaps an imported record; never an approved one", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { agentName: "web-hl" }));
    const o = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { agentName: "web-hl", replace: true }));
    expect(o.agentName).toBe("web-hl");
    expect(mockOws.deleteWallet).toHaveBeenCalledWith("agent-hl-import-web-hl");

    const s = loadSettings();
    s.agents!.hyperliquid!["approved-one"] = { ...s.agents!.hyperliquid!["web-hl"], agentName: "approved-one", source: "approved", masterWalletName: "main" };
    const { saveSettings } = await import("../../settings.js");
    saveSettings(s);
    const err = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { agentName: "approved-one", replace: true })).catch(e => e);
    expect(err.structured.message).toMatch(/approved by this CLI/);
  });

  it("default import names are network-specific and distinct from approve defaults", () => {
    expect(defaultImportAgentName("hyperliquid", "mainnet")).toBe("web-hl");
    expect(defaultImportAgentName("lighter-rh", "testnet")).toBe("web-lrh-tn");
  });
});

describe("H1: the master key is never stored as an agent", () => {
  const MASTER_KEY = `0x${"99".repeat(32)}`;

  it("hyperliquid: --master-address equal to the key's address, or userRole \"user\", is refused", async () => {
    const err = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { masterAddress: HL_AGENT })).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.message).toMatch(/that is the master key — create an API wallet on the website/);
    expect(fetchMock).not.toHaveBeenCalled();
    routes = [hlRoutes({ role: { role: "user" } })];
    const err2 = await importVenueAgent(base("hyperliquid", { kind: "key", key: MASTER_KEY })).catch(e => e);
    expect(err2.structured.code).toBe("INVALID_PARAMS");
    expect(err2.structured.message).toMatch(/master key/);
    expect(vault.size).toBe(0);
    expect(getAgent("hyperliquid", "web-hl")).toBeNull();
  });

  it("aster: the key of --master-address is refused before any request", async () => {
    const err = await importVenueAgent(base("aster", { kind: "key", key: MASTER_KEY }, { masterAddress: MASTER_EVM })).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.message).toMatch(/that is the master key — create an API wallet on the website/);
    expect(JSON.stringify(err.structured)).not.toContain("99".repeat(32));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vault.size).toBe(0);
  });

  it("pacifica: the key of the master account is refused", async () => {
    const err = await importVenueAgent(base("pacifica", { kind: "key", key: PAC_KEY }, { masterAddress: PAC_KP.publicKey.toBase58() })).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.message).toMatch(/that is the master key/);
    expect(vault.size).toBe(0);
  });

  it("arcus: the owner's EVM private key pasted as the API key is refused before any request", async () => {
    const err = await importVenueAgent(base("arcus", { kind: "key", key: MASTER_KEY.slice(2) }, { masterAddress: MASTER_EVM })).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.message).toMatch(/that is the master key/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vault.size).toBe(0);
  });
});

describe("M1: --replace stages the new key before removing the old one", () => {
  it("hyperliquid: a failed store of the new key leaves the old record + key intact", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }));
    const before = getAgent("hyperliquid", "web-hl")!;
    mockOws.importWalletPrivateKey.mockImplementationOnce(() => { throw new Error("vault write failed"); });
    const err = await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { replace: true })).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(getAgent("hyperliquid", "web-hl")).toEqual(before);
    expect(vault.has(before.agentWalletName)).toBe(true);
    expect(mockOws.deleteWallet).not.toHaveBeenCalled();
  });

  it("hyperliquid: a refused verification leaves the old record + key intact; success swaps to a new wallet and deletes the old one", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }));
    routes = [hlRoutes({ role: { role: "missing" } })];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { replace: true })).catch(e => e);
    expect(vault.has("agent-hl-import-web-hl")).toBe(true);
    expect(getAgent("hyperliquid", "web-hl")!.agentWalletName).toBe("agent-hl-import-web-hl");

    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }, { replace: true }));
    const after = getAgent("hyperliquid", "web-hl")!;
    expect(after.agentWalletName).not.toBe("agent-hl-import-web-hl");
    expect(vault.has(after.agentWalletName)).toBe(true);
    expect(vault.has("agent-hl-import-web-hl")).toBe(false);
    expect(vault.size).toBe(1);
  });

  it("ondo: a rejected new key keeps the old keystore + record; success removes the old key id's keystore", async () => {
    const { venueKeystorePath } = await import("../../agent-wallet/venue-keystore.js");
    routes = [ondoOk()];
    await importVenueAgent(base("ondo", { kind: "ondo", keyId: ONDO_ID, secret: ONDO_SECRET }));
    const oldPath = venueKeystorePath("ondo-agents", ONDO_ID);
    expect(existsSync(oldPath)).toBe(true);

    routes = [(url) => url.includes("/v1/account") ? json({ success: false, error: "unauthorized", error_code: "unauthorized" }, 401) : null];
    await importVenueAgent(base("ondo", { kind: "ondo", keyId: "ondoKeyId_new456", secret: ONDO_SECRET }, { replace: true })).catch(e => e);
    expect(existsSync(oldPath)).toBe(true);
    expect(getVenueAgent("ondo", "web-ondo")).toMatchObject({ keyId: ONDO_ID });

    routes = [ondoOk()];
    await importVenueAgent(base("ondo", { kind: "ondo", keyId: "ondoKeyId_new456", secret: ONDO_SECRET }, { replace: true }));
    expect(getVenueAgent("ondo", "web-ondo")).toMatchObject({ keyId: "ondoKeyId_new456" });
    expect(existsSync(venueKeystorePath("ondo-agents", "ondoKeyId_new456"))).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
  });

  it("lighter: replacing with another slot stores the new key first, then deletes the old slot's keystore", async () => {
    vi.spyOn(LighterAdapter.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(LighterAdapter.prototype, "listApiKeys").mockResolvedValue([{ apiKeyIndex: 6, publicKey: "0xPUB6" }, { apiKeyIndex: 7, publicKey: "0xPUB7" }]);
    const accepted = vi.spyOn(LighterAdapter.prototype, "assertAgentKeyAccepted").mockResolvedValue(undefined);
    routes = [(url) => url.includes("by=index") ? json({ accounts: [{ account_index: 77, l1_address: MASTER_EVM }] }) : null];
    await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 6 }));
    const slot6 = lighterFamilyKeystorePath("lighter", "mainnet", 77, 6);
    const slot7 = lighterFamilyKeystorePath("lighter", "mainnet", 77, 7);

    accepted.mockRejectedValueOnce(new Error("bad key"));
    await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 7, replace: true })).catch(e => e);
    expect(existsSync(slot6)).toBe(true);
    expect(existsSync(slot7)).toBe(false);
    expect(getAgent("lighter", "web-lt")).toMatchObject({ apiKeyIndex: 6 });

    await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 7, replace: true }));
    expect(getAgent("lighter", "web-lt")).toMatchObject({ apiKeyIndex: 7 });
    expect(existsSync(slot7)).toBe(true);
    expect(existsSync(slot6)).toBe(false);
  });
});

describe("import security warning", () => {
  it("every import outcome carries the file-permission / withdraw-permission warning, and the human output prints it", async () => {
    const { IMPORT_KEY_WARNING } = await import("../../commands/agent-import.js");
    expect(IMPORT_KEY_WARNING).toMatch(/file permissions only/);
    expect(IMPORT_KEY_WARNING).toMatch(/WITHOUT withdraw permission/);
    const o = await importVenueAgent(base("pacifica", { kind: "key", key: PAC_KEY }, { masterAddress: PAC_MASTER }));
    expect(o.warnings).toEqual([IMPORT_KEY_WARNING]);
    routes = [hlRoutes()];
    setStdin(`${HL_KEY}\n`);
    const r = await run(["wallet", "agent", "import", "hyperliquid"]);
    expect(r.out).toContain("WITHOUT withdraw permission");
  });
});

describe("CLI: wallet agent import / list / revoke / rotate", () => {
  it("rejects a key on argv before reading anything", async () => {
    const r = await run(["wallet", "agent", "import", "hyperliquid", HL_KEY]);
    expect(r.exited).toBe(true);
    const env = lastEnvelope(r);
    expect(env.error.code).toBe("INVALID_PARAMS");
    expect(r.out).not.toContain(HL_KEY.slice(2));
    expect(fetchMock).not.toHaveBeenCalled();

    const r2 = await run(["wallet", "agent", "import", "hyperliquid", "--secret", HL_KEY]);
    expect(lastEnvelope(r2).error.code).toBe("INVALID_PARAMS");
  });

  it("reads the key from stdin, prints --json without key material; list shows source=imported", async () => {
    routes = [hlRoutes()];
    setStdin(`${HL_KEY}\n`);
    const r = await run(["wallet", "agent", "import", "hyperliquid", "--json"]);
    const env = lastEnvelope(r);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ source: "imported", agentName: "web-hl", verification: { status: "verified" } });
    for (const s of ALL_SECRETS) expect(r.out).not.toContain(s);

    const list = await run(["wallet", "agent", "list", "--json"]);
    const rows = lastEnvelope(list).data as Array<{ name: string; source: string; permissions: unknown }>;
    expect(rows.find(r => r.name === "web-hl")).toMatchObject({ source: "imported", permissions: null });

    const human = await run(["wallet", "agent", "list"]);
    expect(human.out).toMatch(/SOURCE/);
    expect(human.out).toMatch(/imported/);
  });

  it("revoke of an imported key without --local-only is refused (nothing pretends to revoke)", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }));
    fetchMock.mockClear();
    const r = await run(["wallet", "agent", "revoke", "hyperliquid", "web-hl", "--json"]);
    const env = lastEnvelope(r);
    expect(env.error.code).toBe("INVALID_PARAMS");
    expect(env.error.remediation).toMatch(/--local-only/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAgent("hyperliquid", "web-hl")).not.toBeNull();
    expect(vault.has("agent-hl-import-web-hl")).toBe(true);
  });

  it("revoke --local-only deletes the local key + record and says it is still authorized on the exchange", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }));
    fetchMock.mockClear();
    const r = await run(["wallet", "agent", "revoke", "hyperliquid", "web-hl", "--local-only", "--json"]);
    const env = lastEnvelope(r);
    expect(env).toMatchObject({ ok: true, data: { revoked: false, localOnly: true, keyRemoved: true } });
    expect(env.data.note).toMatch(/still authorized on the exchange/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAgent("hyperliquid", "web-hl")).toBeNull();
    expect(vault.has("agent-hl-import-web-hl")).toBe(false);
  });

  it("revoke --local-only of an imported Lighter key deletes its keystore file", async () => {
    vi.spyOn(LighterAdapter.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(LighterAdapter.prototype, "listApiKeys").mockResolvedValue([{ apiKeyIndex: 6, publicKey: "0xPUB" }]);
    vi.spyOn(LighterAdapter.prototype, "assertAgentKeyAccepted").mockResolvedValue(undefined);
    routes = [(url) => url.includes("by=index") ? json({ accounts: [{ account_index: 77, l1_address: MASTER_EVM }] }) : null];
    await importVenueAgent(base("lighter", { kind: "key", key: LT_KEY }, { accountIndex: 77, apiKeyIndex: 6 }));
    const path = lighterFamilyKeystorePath("lighter", "mainnet", 77, 6);
    expect(existsSync(path)).toBe(true);
    const r = await run(["wallet", "agent", "revoke", "lighter", "web-lt", "--local-only", "--json"]);
    expect(lastEnvelope(r).data).toMatchObject({ localOnly: true, keyRemoved: true });
    expect(existsSync(path)).toBe(false);
  });

  it("rotate of an imported key is refused with 'create a new key on the website and import it'", async () => {
    routes = [hlRoutes()];
    await importVenueAgent(base("hyperliquid", { kind: "key", key: HL_KEY }));
    fetchMock.mockClear();
    const r = await run(["wallet", "agent", "rotate", "hyperliquid", "web-hl", "--json"]);
    const env = lastEnvelope(r);
    expect(env.error.code).toBe("INVALID_PARAMS");
    expect(env.error.remediation).toMatch(/website.*wallet agent import hyperliquid --agent-name web-hl --replace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approve without any master wallet on this computer → NO_SIGNER_AVAILABLE pointing at import", async () => {
    setStdin("");
    const r = await run(["wallet", "agent", "approve", "hyperliquid", "--json"]);
    const env = lastEnvelope(r);
    expect(env.error.code).toBe("NO_SIGNER_AVAILABLE");
    expect(env.error.remediation).toMatch(/wallet agent import/);
  });
});

describe("QFEX import verification text: an unknown permission is not reported as denied", () => {
  it("true → ok, false → denied, null → unknown (account not funded yet)", async () => {
    // A never-funded account answers GET /user/positions with HTTP 500 "position balance not found":
    // the permission cannot be told (null) — it was not denied.
    const { qfexPermissionText } = await import("../../commands/agent-import.js");
    expect(qfexPermissionText(true)).toBe("ok");
    expect(qfexPermissionText(false)).toBe("denied");
    expect(qfexPermissionText(null)).toBe("unknown (account not funded yet)");
  });
});
