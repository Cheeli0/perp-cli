/**
 * Tests for Phase 2b — Hyperliquid agent wallet support.
 *
 * AC coverage: AC-24/25/26/27/28 from plan v3.4.
 * Covers approve/revoke/rotate commands, adapter 3-tier signer, and verify cross-check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import os from "os";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

// ── Stable temp-dir for settings I/O ──────────────────────────────────────

const TEST_HOME = resolve(os.tmpdir(), `perp-hl-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// ── Mock OWS loader BEFORE module imports ─────────────────────────────────

const MOCK_AGENT_WALLET = {
  id: "wallet-agent-hl-id",
  name: "agent-hl-main",
  accounts: [
    { chainId: "eip155:1", address: "0xAgentHLAddr00000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" },
  ],
  createdAt: new Date().toISOString(),
};

const MOCK_MASTER_WALLET = {
  id: "wallet-master-id",
  name: "main",
  accounts: [
    { chainId: "eip155:1", address: "0xMasterHLAddr0000000000000000000000000001", derivationPath: "m/44'/60'/0'/0/0" },
  ],
  createdAt: new Date().toISOString(),
};

// A valid canonical 65-byte EIP-712 signature — ethers.Signature.from requires canonical s (s <= half-order).
// Generated via ethers.Wallet.signTypedData so r/s/v are all valid secp256k1 values.
const FAKE_SIG = "0x1aee1548148536475582711c39958806646195b294c0bbc0d52ed8aae77988175240c82244cf8e1e0d4387d107ef558090bae5d6a603235750e93ee0be1b1bbf1b";

const mockOws = {
  listWallets: vi.fn((): Array<{ name: string }> => []),
  deleteWallet: vi.fn(),
  createWallet: vi.fn(),
  createPolicy: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  getWallet: vi.fn(),
  signTypedData: vi.fn(),
  signMessage: vi.fn(),
};

vi.mock("../../signer/ows-loader.js", () => ({
  loadOws: () => mockOws,
}));

// ── Mock readline (AC-17 allowlist) ──────────────────────────────────────

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Import modules after mocks ────────────────────────────────────────────

const { registerWalletAgentCommands } = await import("../../commands/agent.js");
const { getAgent, setAgent, deleteAgent } = await import("../../agent-wallet/store.js");
const { loadSettings, saveSettings } = await import("../../settings.js");
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProgram() {
  const prog = new Command();
  addRootSafetyOptions(prog);
  prog.exitOverride();
  // Register `agent` as a subcommand of `wallet` to match the production
  // command tree post-consolidation (`perp wallet agent ...`).
  const walletCmd = prog.command("wallet").description("Wallet management");
  registerWalletAgentCommands(walletCmd, () => false);
  return prog;
}

function makeHlAgentMeta(name = "perp-cli-hl") {
  return {
    agentName: name,
    agentWalletName: "agent-hl-main",
    agentEvmAddress: "0xAgentHLAddr00000000000000000000000000001" as `0x${string}`,
    userEvmAddress: "0xMasterHLAddr0000000000000000000000000001" as `0x${string}`,
    masterWalletName: "main",
    owsApiKeyId: "",
    owsPolicyId: "",
    expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: String(Date.now()),
    status: "active" as const,
  };
}

function setupOkOws() {
  mockOws.createWallet.mockReturnValue(MOCK_AGENT_WALLET);
  mockOws.createPolicy.mockReturnValue(undefined);
  mockOws.createApiKey.mockReturnValue({ id: "key-hl-001", token: "ows_key_NEVER_STORED", name: "api-hl-perp-cli-hl" });
  mockOws.revokeApiKey.mockReturnValue(undefined);
  mockOws.getWallet.mockReturnValue(MOCK_MASTER_WALLET);
  // OwsEvmSigner.signTypedData() calls ows.signTypedData() and expects {signature, recoveryId}
  // FAKE_SIG is 65 bytes: 32 r + 32 s + 1 v(0x1b=27), strip 0x prefix for OWS raw hex
  const rawHex = FAKE_SIG.slice(2, 2 + 128); // 64 hex chars = 32 bytes (r+s only, OWS provides r+s without v)
  mockOws.signTypedData.mockReturnValue({ signature: "0x" + rawHex, recoveryId: 0 });
  mockOws.signMessage.mockReturnValue({ signature: "0x" + rawHex, recoveryId: 0 });
}

/** HL approveAgent exchange response: {status:"ok"} */
function stubHlFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: "ok", response: { data: { statuses: ["filled"] } } }),
    text: async () => JSON.stringify({ status: "ok" }),
  }));
}

function stubHlFetchErr(message: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: "err", response: message }),
    text: async () => JSON.stringify({ status: "err", response: message }),
  }));
}

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("HOME", TEST_HOME);
  // Ensure non-TTY so resolvePassphrase falls back to env/flag without prompting
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: HL approve happy path (AC-24)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1: HL approve happy path (AC-24)", () => {
  it("approves agent, persists meta with owsApiKeyId='' and correct agentEvmAddress", async () => {
    setupOkOws();
    stubHlFetchOk();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
      text: async () => JSON.stringify({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);

    const prog = makeProgram();
    try {
      await prog.parseAsync([
        "node", "perp", "wallet", "agent", "approve", "hyperliquid",
        "--master", "main",
        "--agent-name", "perp-cli-hl",
        "--expires-in", "90d",
        "--passphrase", "testpass",
        "--json",
      ]);
    } catch (e) {
      // If process.exit was thrown, show captured stderr for diagnosis
      throw new Error(`Command failed. Stderr: ${stderrLines.join("")}. Exit err: ${e instanceof Error ? e.message : e}`);
    }

    const meta = getAgent("hyperliquid", "perp-cli-hl");
    expect(meta).toBeTruthy();
    expect(meta!.agentEvmAddress).toBe("0xAgentHLAddr00000000000000000000000000001");
    expect(meta!.owsApiKeyId).toBe("");       // HL has no OWS API key
    expect(meta!.owsPolicyId).toBe("");       // HL has no OWS policy
    expect(meta!.masterWalletName).toBe("main");
    expect(meta!.status).toBe("active");

    // Verify /exchange was called with HL action shape
    expect(fetchMock).toHaveBeenCalled();
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.action.type).toBe("approveAgent");
    expect(callBody.action.hyperliquidChain).toBe("Mainnet");
    expect(callBody.action.agentAddress).toBe("0xAgentHLAddr00000000000000000000000000001");
    expect(callBody.vaultAddress).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1b: HL approve creates agent wallet with empty passphrase (MAJOR-1 fix)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 1b: HL approve creates agent wallet with empty passphrase (P1 prompt-free hot-path)", () => {
  it("createWallet is called with empty string passphrase, NOT the master passphrase", async () => {
    setupOkOws();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
      text: async () => JSON.stringify({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "hyperliquid",
      "--master", "main",
      "--agent-name", "perp-cli-hl",
      "--expires-in", "90d",
      "--passphrase", "supersecret",
      "--json",
    ]);

    // Agent wallet must be created with "" (empty passphrase) so runtime can open
    // it without prompting. Master passphrase "supersecret" must NOT be forwarded.
    // See runHlApproveFlow comment for rationale.
    expect(mockOws.createWallet).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-hl-/),
      "", // empty passphrase — agent wallet relies on OWS storage encryption, not per-wallet passphrase
    );
    // Confirm master passphrase was NOT used for createWallet
    expect(mockOws.createWallet).not.toHaveBeenCalledWith(
      expect.anything(),
      "supersecret",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: HL approve --rotate (AC-26)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 2: HL approve --rotate replaces existing entry", () => {
  it("overwrites existing settings entry with new agent address", async () => {
    setupOkOws();
    // Pre-populate with old meta
    const oldMeta = makeHlAgentMeta("perp-cli-hl");
    oldMeta.agentEvmAddress = "0xOldAgentAddr0000000000000000000000000001" as `0x${string}`;
    setAgent("hyperliquid", oldMeta);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
      text: async () => JSON.stringify({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "approve", "hyperliquid",
      "--master", "main",
      "--agent-name", "perp-cli-hl",
      "--expires-in", "90d",
      "--rotate",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("hyperliquid", "perp-cli-hl");
    expect(meta!.agentEvmAddress).toBe("0xAgentHLAddr00000000000000000000000000001"); // new
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: HL revoke happy path (AC-25)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 3: HL revoke happy path (AC-25)", () => {
  it("sends zero-address revoke action and deletes settings entry", async () => {
    setupOkOws();
    setAgent("hyperliquid", makeHlAgentMeta());

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
      text: async () => JSON.stringify({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "revoke", "hyperliquid", "perp-cli-hl",
      "--passphrase", "testpass",
      "--json",
    ]);

    // Settings entry deleted (getAgent returns null when not found)
    expect(getAgent("hyperliquid", "perp-cli-hl")).toBeNull();

    // Verify revoke POST was sent with zero-address
    expect(fetchMock).toHaveBeenCalled();
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.action.type).toBe("approveAgent");
    expect(callBody.action.agentAddress).toBe("0x0000000000000000000000000000000000000000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: HL revoke idempotent (AC-25)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 4: HL revoke idempotent (AC-25)", () => {
  it("returns alreadyRevoked:true when agent not found locally", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const consoleLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "revoke", "hyperliquid", "nonexistent-agent",
      "--passphrase", "testpass",
      "--json",
    ]);

    // fetch should NOT have been called (local idempotent check fires first)
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleLines.some(l => l.includes("alreadyRevoked"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: HL rotate end-to-end (AC-26)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 5: HL rotate (AC-26)", () => {
  it("revokes existing and approves with same name; final settings has new agent", async () => {
    setupOkOws();
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      // First call = revoke (zero-address), second call = approve (real agent address)
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
        text: async () => JSON.stringify({ status: "ok" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "rotate", "hyperliquid", "perp-cli-hl",
      "--passphrase", "testpass",
      "--json",
    ]);

    const meta = getAgent("hyperliquid", "perp-cli-hl");
    expect(meta).toBeTruthy();
    expect(meta!.agentEvmAddress).toBe("0xAgentHLAddr00000000000000000000000000001");
    // Two fetch calls: one revoke + one approve
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 6-10: HyperliquidAdapter 3-tier signer (AC-27)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 6: HyperliquidAdapter Tier 1 selection", () => {
  it("agent + master + PK all set → activeSignerTier === 'agent'", () => {
    mockOws.getWallet.mockReturnValue(MOCK_MASTER_WALLET);
    mockOws.signTypedData.mockReturnValue(FAKE_SIG);

    const adapter = new HyperliquidAdapter("0x" + "a".repeat(64));
    // Tier 2: master signer
    const masterSigner = {
      getAddress: () => "0xMasterHLAddr0000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setSigner(masterSigner as never);
    // Tier 1: agent
    const agentSigner = {
      getAddress: () => "0xAgentHLAddr00000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setAgentSigner(makeHlAgentMeta(), agentSigner as never);

    expect(adapter.activeSignerTier).toBe("agent");
  });
});

describe("Test 7: HyperliquidAdapter Tier 2 selection", () => {
  it("no agent, master set → activeSignerTier === 'master'", () => {
    const adapter = new HyperliquidAdapter("0x" + "a".repeat(64));
    const masterSigner = {
      getAddress: () => "0xMasterHLAddr0000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setSigner(masterSigner as never);
    // No agent set

    expect(adapter.activeSignerTier).toBe("master");
  });
});

describe("Test 8: HyperliquidAdapter Tier 2 with master+PK both set, master wins", () => {
  it("master OWS signer + PK constructor arg, no agent → activeSignerTier === 'master'", () => {
    // When both master OWS signer and PK are available, OWS master (Tier 2) takes priority
    // over PK (Tier 3) because setSigner always sets _evmSigner which is checked before PK.
    const adapter = new HyperliquidAdapter("0x" + "b".repeat(64)); // PK provided
    expect(adapter.isReadOnly).toBe(false); // PK set → not read-only

    const masterSigner = {
      getAddress: () => "0xMasterHLAddr0000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setSigner(masterSigner as never); // also set OWS master

    // Master signer wins over PK; no agent set
    expect(adapter.activeSignerTier).toBe("master");
  });
});

describe("Test 9: HyperliquidAdapter NO_SIGNER_AVAILABLE", () => {
  it("no agent, no master, no PK → activeSignerTier is null", () => {
    const adapter = new HyperliquidAdapter(); // no PK
    // isReadOnly should be true
    expect(adapter.isReadOnly).toBe(true);
    expect(adapter.activeSignerTier).toBeNull();
  });
});

describe("Test 10: HyperliquidAdapter --no-agent bypass (AC-27)", () => {
  it("setNoAgent(true) → Tier 1 skipped even when agent is set", () => {
    const adapter = new HyperliquidAdapter();
    const agentSigner = {
      getAddress: () => "0xAgentHLAddr00000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setAgentSigner(makeHlAgentMeta(), agentSigner as never);

    const masterSigner = {
      getAddress: () => "0xMasterHLAddr0000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setSigner(masterSigner as never);

    adapter.setNoAgent(true);
    expect(adapter.activeSignerTier).toBe("master");
  });
});

describe("Test 11: HyperliquidAdapter AGENT_EXPIRED", () => {
  it("only Tier 1 set + expired meta + no Tier 2/3 → activeSignerTier is null (would throw AGENT_EXPIRED on action)", () => {
    const adapter = new HyperliquidAdapter(); // no PK
    const expiredMeta = makeHlAgentMeta();
    expiredMeta.expiresAt = new Date(Date.now() - 1000).toISOString(); // expired
    const agentSigner = {
      getAddress: () => "0xAgentHLAddr00000000000000000000000000001",
      signTypedData: vi.fn().mockResolvedValue(FAKE_SIG),
      signMessage: vi.fn(),
    };
    adapter.setAgentSigner(expiredMeta, agentSigner as never);
    // No master, no PK → AGENT_EXPIRED → null
    expect(adapter.activeSignerTier).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 12-13: verify cross-check (AC-28)
// ─────────────────────────────────────────────────────────────────────────────

describe("Test 12: HL verify cross-check warning (AC-28)", () => {
  it("settings has agentEvmAddress X, live response returns different Y → warnings non-empty", async () => {
    setupOkOws();

    // Persist agent meta with address X
    const meta = makeHlAgentMeta("perp-cli-hl");
    meta.agentEvmAddress = "0xExpectedAddr000000000000000000000000001" as `0x${string}`;
    meta.userEvmAddress = "0xMasterHLAddr0000000000000000000000000001" as `0x${string}`;
    setAgent("hyperliquid", meta);

    // Live response returns address Y (different)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ address: "0xdifferentaddr0000000000000000000000001", validUntil: 9999999999 }],
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "verify", "hyperliquid", "perp-cli-hl",
      "--master-address", "0xMasterHLAddr0000000000000000000000000001",
      "--json",
    ]);

    const output = stdoutLines.join("");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.meta?.warnings).toBeDefined();
    expect(parsed.meta?.warnings?.length).toBeGreaterThan(0);
    expect(parsed.meta?.warnings?.[0]).toContain("0xExpectedAddr000000000000000000000000001");
  });
});

describe("Test 13: HL verify cross-check happy (AC-28)", () => {
  it("settings X, live returns X → no warnings", async () => {
    setupOkOws();

    const meta = makeHlAgentMeta("perp-cli-hl");
    meta.agentEvmAddress = "0xExpectedAddr000000000000000000000000001" as `0x${string}`;
    meta.userEvmAddress = "0xMasterHLAddr0000000000000000000000000001" as `0x${string}`;
    setAgent("hyperliquid", meta);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ address: "0xExpectedAddr000000000000000000000000001", validUntil: 9999999999 }],
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutLines.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      "node", "perp", "wallet", "agent", "verify", "hyperliquid", "perp-cli-hl",
      "--master-address", "0xMasterHLAddr0000000000000000000000000001",
      "--json",
    ]);

    const output = stdoutLines.join("");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    // No warnings when address matches
    expect(!parsed.meta?.warnings || parsed.meta?.warnings?.length === 0).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review fixes: M3 (approve acceptance rule) + (a) revoked OWS agent wallet removal
// ─────────────────────────────────────────────────────────────────────────────

describe("M3: HL approve requires HTTP 2xx AND status \"ok\"", () => {
  it.each([
    ["HTTP 502 with ok body", { ok: false, status: 502, body: { status: "ok" } }],
    ["200 without a status field", { ok: true, status: 200, body: { response: "?" } }],
    ["200 with an unexpected status", { ok: true, status: 200, body: { status: "pending" } }],
  ])("%s → APPROVE_PARTIAL, no agent persisted, local agent wallet kept (outcome unknown)", async (_l, r) => {
    setupOkOws();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body) }));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { out.push(String(c)); return true; });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(makeProgram().parseAsync([
      "node", "perp", "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--passphrase", "testpass", "--json",
    ])).rejects.toThrow("process.exit");
    const env = JSON.parse(out.find(l => l.includes('"ok":false'))!);
    expect(env.error.code).toBe("APPROVE_PARTIAL");
    expect(getAgent("hyperliquid", "perp-cli-hl")).toBeNull();
    expect(mockOws.deleteWallet).not.toHaveBeenCalled();
  });
});

describe("(a) a confirmed revoke deletes the OWS agent wallet so rotate can recreate the name", () => {
  it("revoke: venue confirms → deleteWallet(agent-hl-main)", async () => {
    setupOkOws();
    mockOws.listWallets.mockReturnValue([{ name: "agent-hl-main" }]);
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));
    stubHlFetchOk();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    await makeProgram().parseAsync(["node", "perp", "wallet", "agent", "revoke", "hyperliquid", "perp-cli-hl", "--passphrase", "testpass", "--json"]);
    expect(mockOws.deleteWallet).toHaveBeenCalledWith("agent-hl-main");
    expect(getAgent("hyperliquid", "perp-cli-hl")).toBeNull();
  });

  it("revoke --force (nothing sent) keeps the OWS agent wallet", async () => {
    mockOws.listWallets.mockReturnValue([{ name: "agent-hl-main" }]);
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await makeProgram().parseAsync(["node", "perp", "wallet", "agent", "revoke", "hyperliquid", "perp-cli-hl", "--force", "--json"]);
    expect(mockOws.deleteWallet).not.toHaveBeenCalled();
  });

  it("rotate: old wallet deleted after the confirmed revoke and BEFORE createWallet of the same name", async () => {
    setupOkOws();
    const order: string[] = [];
    // Stateful: the old agent wallet exists until the confirmed revoke deletes it.
    let wallets = [{ name: "agent-hl-main" }];
    mockOws.listWallets.mockImplementation(() => wallets);
    mockOws.deleteWallet.mockImplementation((n: string) => { order.push(`delete:${n}`); wallets = wallets.filter(w => w.name !== n); });
    mockOws.createWallet.mockImplementation((n: string) => { order.push(`create:${n}`); return MOCK_AGENT_WALLET; });
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));
    stubHlFetchOk();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await makeProgram().parseAsync(["node", "perp", "wallet", "agent", "rotate", "hyperliquid", "perp-cli-hl", "--master", "main", "--passphrase", "testpass", "--json"]);
    expect(order).toEqual(["delete:agent-hl-main", "create:agent-hl-main"]);
    expect(getAgent("hyperliquid", "perp-cli-hl")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Docs/review fixes: venue expiry suffix, expired agent, approve --rotate, wallet-name collision
// ─────────────────────────────────────────────────────────────────────────────

/** Runs a `wallet agent …` command that must fail; returns the JSON error envelope's `error`. */
async function failingRun(args: string[]): Promise<{ code: string; message: string; remediation?: string }> {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { out.push(String(c)); return true; });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await expect(makeProgram().parseAsync(["node", "perp", "wallet", "agent", ...args, "--json"])).rejects.toThrow("process.exit");
  return JSON.parse(out.find(l => l.includes('"ok":false'))!).error;
}

describe("HL approveAgent carries the venue expiry (`<name> valid_until <ms>`, max 180 days)", () => {
  it("signed and posted agentName end with the stored expiresAt in ms; the stored name stays bare", async () => {
    setupOkOws();
    stubHlFetchOk();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await makeProgram().parseAsync(["node", "perp", "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--expires-in", "30d", "--passphrase", "testpass", "--json"]);
    const meta = getAgent("hyperliquid", "perp-cli-hl")!;
    expect(meta.agentName).toBe("perp-cli-hl");
    const expiryMs = new Date(meta.expiresAt).getTime();
    expect(Math.abs(expiryMs - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000);
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.action.agentName).toBe(`perp-cli-hl valid_until ${expiryMs}`);
    // The EIP-712 message the master signed names the same string.
    const typedData = JSON.parse(mockOws.signTypedData.mock.calls[0][2] as string) as { message: { agentName: string } };
    expect(typedData.message.agentName).toBe(body.action.agentName);
  });

  it.each(["181d", "1y"])("--expires-in %s (> 180 days) → INVALID_PARAMS before any wallet is created or anything is sent", async (expiresIn) => {
    setupOkOws();
    stubHlFetchOk();
    const err = await failingRun(["approve", "hyperliquid", "--master", "main", "--expires-in", expiresIn, "--passphrase", "testpass"]);
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.message).toMatch(/at most 180 days/);
    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(getAgent("hyperliquid", "perp-cli-hl")).toBeNull();
  });

  it("an agent name containing valid_until is refused", async () => {
    setupOkOws();
    stubHlFetchOk();
    const err = await failingRun(["approve", "hyperliquid", "--master", "main", "--agent-name", "a valid_until 1", "--passphrase", "testpass"]);
    expect(err.code).toBe("INVALID_PARAMS");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("HyperliquidAdapter: an expired agent never falls through to the master signer", () => {
  const expiredAdapter = () => {
    const adapter = new HyperliquidAdapter();
    const meta = makeHlAgentMeta();
    meta.expiresAt = new Date(Date.now() - 1000).toISOString();
    const signer = (addr: string) => ({ getAddress: () => addr, signTypedData: vi.fn().mockResolvedValue(FAKE_SIG), signMessage: vi.fn() });
    adapter.setAgentSigner(meta, signer("0xAgentHLAddr00000000000000000000000000001") as never);
    adapter.setSigner(signer("0xMasterHLAddr0000000000000000000000000001") as never);
    return adapter;
  };

  it("expired agent + master available → AGENT_EXPIRED with the re-approve remediation, nothing signed", async () => {
    const adapter = expiredAdapter();
    expect(adapter.activeSignerTier).toBeNull();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await adapter.exchangeAction({ type: "cancel", cancels: [{ a: 0, o: 1 }] }).catch(e => e);
    expect(err.structured.code).toBe("AGENT_EXPIRED");
    expect(err.structured.remediation).toContain("perp wallet agent approve hyperliquid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--no-agent → the master signer is used", () => {
    const adapter = expiredAdapter();
    adapter.setNoAgent(true);
    expect(adapter.activeSignerTier).toBe("master");
  });
});

describe("approve vs an existing agent OWS wallet (name collision) and approve --rotate", () => {
  afterEach(() => {
    // mockImplementation survives vi.clearAllMocks(): restore the file-level defaults.
    mockOws.listWallets.mockReset().mockImplementation(() => []);
    mockOws.deleteWallet.mockReset();
    mockOws.createWallet.mockReset();
  });

  /** OWS wallet list that follows deleteWallet / createWallet; records their order. */
  const statefulWallets = (initial: string[]) => {
    let wallets = initial.map(name => ({ name }));
    const order: string[] = [];
    mockOws.listWallets.mockImplementation(() => wallets);
    mockOws.deleteWallet.mockImplementation((n: string) => { order.push(`delete:${n}`); wallets = wallets.filter(w => w.name !== n); });
    mockOws.createWallet.mockImplementation((n: string) => {
      if (wallets.some(w => w.name === n)) throw new Error(`wallet name already exists: '${n}'`);
      order.push(`create:${n}`); wallets = [...wallets, { name: n }];
      return MOCK_AGENT_WALLET;
    });
    return order;
  };

  it("approve without --rotate while the agent exists → INVALID_PARAMS telling the user to pass --rotate, never DUPLICATE_ORDER", async () => {
    setupOkOws();
    statefulWallets(["agent-hl-main"]);
    const expired = makeHlAgentMeta("perp-cli-hl");
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    setAgent("hyperliquid", expired);
    stubHlFetchOk();
    const err = await failingRun(["approve", "hyperliquid", "--master", "main", "--passphrase", "testpass"]);
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.message).toContain('agent "perp-cli-hl" already exists');
    expect(err.remediation).toContain("perp wallet agent approve hyperliquid --rotate");
    expect(fetch).not.toHaveBeenCalled();
    expect(mockOws.signTypedData).not.toHaveBeenCalled();
  });

  it("a NEW --agent-name still collides with the master's agent wallet: without --rotate → INVALID_PARAMS naming the owner", async () => {
    setupOkOws();
    statefulWallets(["agent-hl-main"]);
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));
    stubHlFetchOk();
    const err = await failingRun(["approve", "hyperliquid", "--master", "main", "--agent-name", "fresh", "--passphrase", "testpass"]);
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.message).toContain('agent "perp-cli-hl" already exists');
    expect(err.remediation).toContain("perp wallet agent approve hyperliquid --rotate");
    expect(err.remediation).toContain("perp wallet agent rotate hyperliquid perp-cli-hl");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("approve --rotate under a NEW --agent-name replaces the agent that owns the wallet (revoked by ITS name), then registers the new one", async () => {
    setupOkOws();
    const order = statefulWallets(["agent-hl-main"]);
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: "ok" }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await makeProgram().parseAsync(["node", "perp", "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--agent-name", "fresh", "--rotate", "--passphrase", "testpass", "--json"]);
    expect(order).toEqual(["delete:agent-hl-main", "create:agent-hl-main"]);
    const actions = fetchMock.mock.calls.map(c => JSON.parse(c[1].body as string).action as { agentAddress: string; agentName: string });
    expect(actions[0]).toMatchObject({ agentAddress: "0x0000000000000000000000000000000000000000", agentName: "perp-cli-hl" });
    expect(actions[1].agentName).toMatch(/^fresh valid_until \d{13}$/);
    expect(getAgent("hyperliquid", "perp-cli-hl")).toBeNull();
    expect(getAgent("hyperliquid", "fresh")).not.toBeNull();
  });

  it.each([["rotate", ["rotate", "hyperliquid", "perp-cli-hl"]], ["approve --rotate", ["approve", "hyperliquid", "--master", "main", "--rotate"]]])(
    "%s: the venue already pruned the expired agent (\"Extra agent does not exist.\") → treated as gone: local wallet replaced, fresh key approved", async (_l, args) => {
      setupOkOws();
      const order = statefulWallets(["agent-hl-main"]);
      const expired = makeHlAgentMeta("perp-cli-hl");
      expired.expiresAt = new Date(Date.now() - 1000).toISOString();
      setAgent("hyperliquid", expired);
      const fetchMock = vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
        const zero = JSON.parse(init.body).action.agentAddress === "0x0000000000000000000000000000000000000000";
        const body = zero ? { status: "err", response: "Extra agent does not exist." } : { status: "ok" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as never);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await makeProgram().parseAsync(["node", "perp", "wallet", "agent", ...args, "--passphrase", "testpass", "--json"]);
      expect(order).toEqual(["delete:agent-hl-main", "create:agent-hl-main"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Date(getAgent("hyperliquid", "perp-cli-hl")!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

  it("any OTHER revoke refusal aborts the rotate: the still-possibly-active agent's wallet and record are kept", async () => {
    setupOkOws();
    const order = statefulWallets(["agent-hl-main"]);
    setAgent("hyperliquid", makeHlAgentMeta("perp-cli-hl"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: "err", response: "Must deposit before performing actions." }) }));
    const err = await failingRun(["approve", "hyperliquid", "--master", "main", "--rotate", "--passphrase", "testpass"]);
    expect(err.code).toBe("APPROVE_FAILED");
    expect(order).toEqual([]);
    expect(getAgent("hyperliquid", "perp-cli-hl")).not.toBeNull();
  });

  it("a leftover wallet no agent record uses → INVALID_PARAMS with the cleanup step", async () => {
    setupOkOws();
    statefulWallets(["agent-hl-main"]);
    stubHlFetchOk();
    const err = await failingRun(["approve", "hyperliquid", "--master", "main", "--passphrase", "testpass"]);
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.remediation).toContain("ows wallet delete agent-hl-main");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("approve --rotate with an EXPIRED previous agent takes the rotate path: revoke → delete wallet → create → approve", async () => {
    setupOkOws();
    const order = statefulWallets(["agent-hl-main"]);
    const expired = makeHlAgentMeta("perp-cli-hl");
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    setAgent("hyperliquid", expired);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: "ok" }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await makeProgram().parseAsync(["node", "perp", "wallet", "agent", "approve", "hyperliquid", "--master", "main", "--rotate", "--passphrase", "testpass", "--json"]);
    expect(order).toEqual(["delete:agent-hl-main", "create:agent-hl-main"]);
    const actions = fetchMock.mock.calls.map(c => JSON.parse(c[1].body as string).action as { agentAddress: string; agentName: string });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ agentAddress: "0x0000000000000000000000000000000000000000", agentName: "perp-cli-hl" });
    expect(actions[1].agentAddress).toBe("0xAgentHLAddr00000000000000000000000000001");
    const meta = getAgent("hyperliquid", "perp-cli-hl")!;
    expect(new Date(meta.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
