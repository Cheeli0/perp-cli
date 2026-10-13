/**
 * `perp setup` wizard (rebuilt): non-interactive flag path, slippage validation,
 * settings writes, agent-approval gating / failure isolation, legacy .env warning,
 * and the interactive flow driven through an injected Prompter.
 *
 * HOME is a per-file temp dir (helpers/isolate-home.ts); this file asserts it before
 * touching settings. OWS and agent approval are mocked — no network, no vault.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import { addRootSafetyOptions } from "../../cli-flags.js";

const HOME = process.env.HOME ?? "";
const PERP_DIR = resolve(HOME, ".perp");
const SETTINGS_FILE = resolve(PERP_DIR, "settings.json");

// ── Mocks (before importing the module under test) ──

const WALLET = {
  id: "w-main",
  name: "main",
  accounts: [
    { chainId: "eip155:1", address: "0xMasterEvm", derivationPath: "m/44'/60'/0'/0/0" },
    { chainId: "solana:mainnet", address: "MasterSol", derivationPath: "m/44'/501'/0'/0'" },
  ],
  createdAt: "2026-10-01T00:00:00.000Z",
};

const mockOws = {
  createWallet: vi.fn(),
  listWallets: vi.fn(),
};
vi.mock("../../signer/ows-loader.js", () => ({ loadOws: () => mockOws }));

const approveVenueAgent = vi.fn();
const verifyVenueAgent = vi.fn();
vi.mock("../../commands/agent.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../commands/agent.js")>();
  return {
    ...orig,
    approveVenueAgent: (...a: unknown[]) => approveVenueAgent(...a),
    verifyVenueAgent: (...a: unknown[]) => verifyVenueAgent(...a),
    printApproveOutcome: () => {},
  };
});

const importVenueAgent = vi.fn();
const deleteImportedAgentLocal = vi.fn(async () => ({ keyRemoved: true }));
vi.mock("../../commands/agent-import.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../commands/agent-import.js")>();
  return {
    ...orig,
    importVenueAgent: (...a: unknown[]) => importVenueAgent(...a),
    deleteImportedAgentLocal: (...a: unknown[]) => deleteImportedAgentLocal(...(a as [])),
    printImportOutcome: () => {},
  };
});

/** Records the import mock "stored" (so the batch rollback finds them). */
const storedImports = new Map<string, Record<string, unknown>>();
vi.mock("../../agent-wallet/store.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../agent-wallet/store.js")>();
  return {
    ...orig,
    getAgent: (venue: string, name: string) => storedImports.get(`${venue}:${name}`) ?? orig.getAgent(venue, name),
  };
});

const { registerInitCommand, runInteractiveSetup, slippageExplanation, nextStepCommands } = await import("../../commands/init.js");
const { PerpError } = await import("../../errors.js");

// ── Helpers ──

function makeProgram() {
  const prog = new Command();
  addRootSafetyOptions(prog);
  prog.exitOverride();
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerInitCommand(prog);
  return prog;
}

/** Run `perp setup --non-interactive <args> --json` and return the parsed JSON envelope. */
async function runJson(args: string[]): Promise<{ ok: boolean; data?: any; error?: any }> {
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((m) => { out.push(String(m)); });
  process.argv.push("--json");
  try {
    await makeProgram().parseAsync(["node", "perp", "setup", "--non-interactive", ...args]);
  } finally {
    process.argv.pop();
    log.mockRestore();
  }
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]);
}

function savedSettings(): any {
  return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
}

beforeEach(() => {
  expect(HOME).toContain("perp-cli-test-home-");
  rmSync(PERP_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
  mockOws.listWallets.mockReturnValue([WALLET]);
  mockOws.createWallet.mockImplementation((name: string) => ({ ...WALLET, name, id: `w-${name}` }));
  delete process.env.OWS_PASSPHRASE;
});

afterEach(() => {
  delete process.env.OWS_PASSPHRASE;
  process.exitCode = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setup --non-interactive: settings", () => {
  it("selects an existing wallet and writes venues' default + slippage without signing anything", async () => {
    const res = await runJson([
      "--wallet", "main", "--venues", "hyperliquid,aster", "--network", "testnet",
      "--default-venue", "hyperliquid", "--slippage-bps", "30", "--slippage", "aster=80", "--slippage", "hl=120",
    ]);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      walletName: "main", walletCreated: false, owsActiveWallet: "main", network: "testnet",
      venues: ["hyperliquid", "aster"], defaultExchange: "hyperliquid",
      defaultSlippageBps: 30, slippageBps: { aster: 80, hyperliquid: 120 }, agents: [],
    });
    expect(res.data.nextSteps).toContain("perp -n testnet portfolio");

    const s = savedSettings();
    expect(s.owsActiveWallet).toBe("main");
    expect(s.defaultExchange).toBe("hyperliquid");
    expect(s.defaultSlippageBps).toBe(30);
    expect(s.slippageBps).toEqual({ aster: 80, hyperliquid: 120 });

    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(approveVenueAgent).not.toHaveBeenCalled();
    // SSOT Rule #3: setup never writes a .env.
    expect(existsSync(resolve(PERP_DIR, ".env"))).toBe(false);
  });

  it("keeps the current slippage when no slippage flags are passed and defaults to the only venue", async () => {
    const res = await runJson(["--wallet", "main", "--venues", "arcus"]);
    expect(res.ok).toBe(true);
    expect(res.data.defaultExchange).toBe("arcus");
    expect(savedSettings().defaultSlippageBps).toBe(50);
    expect(savedSettings().slippageBps).toEqual({});
  });

  it("rejects a per-venue slippage above the venue maximum (no clamping) and writes nothing", async () => {
    const res = await runJson(["--wallet", "main", "--venues", "arcus", "--slippage", "arcus=1001"]);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toMatch(/slippageBps\.arcus.*1\.\.1000/);
    expect(existsSync(SETTINGS_FILE)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a global default above the tightest venue maximum, and non-numeric / zero values", async () => {
    for (const bad of ["1001", "0", "abc"]) {
      const res = await runJson(["--wallet", "main", "--slippage-bps", bad]);
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    expect(existsSync(SETTINGS_FILE)).toBe(false);
  });

  it("accepts a per-venue value above the global cap when that venue allows it", async () => {
    const res = await runJson(["--wallet", "main", "--slippage", "hyperliquid=2000"]);
    expect(res.ok).toBe(true);
    expect(savedSettings().slippageBps).toEqual({ hyperliquid: 2000 });
  });

  it("rejects unknown venues, a default venue outside --venues, and malformed overrides", async () => {
    expect((await runJson(["--wallet", "main", "--venues", "ftx"])).error.code).toBe("INVALID_PARAMS");
    expect((await runJson(["--wallet", "main", "--venues", "aster", "--default-venue", "hyperliquid"])).error.code).toBe("INVALID_PARAMS");
    expect((await runJson(["--wallet", "main", "--slippage", "aster"])).error.code).toBe("INVALID_PARAMS");
    expect(existsSync(SETTINGS_FILE)).toBe(false);
  });

  it("requires exactly one of --wallet / --wallet-name and an existing wallet for --wallet", async () => {
    expect((await runJson(["--venues", "aster"])).error.code).toBe("INVALID_PARAMS");
    expect((await runJson(["--wallet", "main", "--wallet-name", "x", "--passphrase", "p"])).error.code).toBe("INVALID_PARAMS");
    expect((await runJson(["--wallet", "nope"])).error.code).toBe("KEY_NOT_FOUND");
    expect(existsSync(SETTINGS_FILE)).toBe(false);
  });

  it("creates a new wallet with --wallet-name + passphrase", async () => {
    const res = await runJson(["--wallet-name", "fresh", "--passphrase", "pp"]);
    expect(res.ok).toBe(true);
    expect(mockOws.createWallet).toHaveBeenCalledWith("fresh", "pp");
    expect(res.data.walletCreated).toBe(true);
    expect(savedSettings().owsActiveWallet).toBe("fresh");
  });

  it("warns about legacy .env keys by name only — never their values", async () => {
    mkdirSync(PERP_DIR, { recursive: true });
    writeFileSync(resolve(PERP_DIR, ".env"), "HL_PRIVATE_KEY=0xdeadbeefsecret\nPACIFICA_PRIVATE_KEY=solsecret\n");
    const res = await runJson(["--wallet", "main"]);
    expect(res.data.legacyEnvKeys).toEqual(["PACIFICA_PRIVATE_KEY", "HL_PRIVATE_KEY"]);
    expect(JSON.stringify(res)).not.toMatch(/deadbeef|solsecret/);
    // Not migrated, not rewritten.
    expect(readFileSync(resolve(PERP_DIR, ".env"), "utf-8")).toContain("0xdeadbeefsecret");
  });
});

describe("setup --non-interactive: agent approval", () => {
  it("--approve-agents without --yes is refused before any side effect", async () => {
    const res = await runJson(["--wallet", "main", "--venues", "aster", "--approve-agents", "--passphrase", "pp"]);
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(approveVenueAgent).not.toHaveBeenCalled();
    expect(existsSync(SETTINGS_FILE)).toBe(false);
  });

  it("ondo approval requires --ondo-secret-stdin, and that flag requires ondo approval", async () => {
    expect((await runJson(["--wallet", "main", "--venues", "ondo", "--approve-agents", "--yes"])).error.code).toBe("INVALID_PARAMS");
    expect((await runJson(["--wallet", "main", "--venues", "ondo", "--ondo-secret-stdin"])).error.code).toBe("INVALID_PARAMS");
    expect(approveVenueAgent).not.toHaveBeenCalled();
  });

  it("a failure on one venue is reported and does not stop the others; settings are still saved", async () => {
    approveVenueAgent.mockImplementation(async (p: { venue: string }) => {
      if (p.venue === "lighter") throw new PerpError("APPROVE_FAILED", "lighter said no", { remediation: "retry" });
      return { venue: p.venue, agentName: `agent-for-${p.venue}`, expiresAt: "x", result: {} };
    });
    const res = await runJson([
      "--wallet", "main", "--venues", "lighter,arcus", "--approve-agents", "--yes", "--passphrase", "pp",
      "--arcus-account-index", "3", "--lighter-api-key-index", "9",
    ]);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("APPROVE_FAILED");
    expect(res.error.details.result.agents).toEqual([
      { venue: "lighter", status: "failed", error: expect.objectContaining({ code: "APPROVE_FAILED", message: "lighter said no" }) },
      { venue: "arcus", status: "approved", agentName: "agent-for-arcus" },
    ]);
    expect(approveVenueAgent).toHaveBeenCalledTimes(2);
    expect(approveVenueAgent.mock.calls[0][0]).toMatchObject({ venue: "lighter", master: "main", passphrase: "pp", apiKeyIndex: 9, canWithdraw: false });
    expect(approveVenueAgent.mock.calls[1][0]).toMatchObject({ venue: "arcus", accountIndex: 3 });
    expect(savedSettings().owsActiveWallet).toBe("main");
    expect(process.exitCode).toBe(1);
  });

  it("approves testnet agents with network=testnet (Aster via registerAndApproveAgent)", async () => {
    approveVenueAgent.mockImplementation(async (p: { venue: string }) => ({ venue: p.venue, agentName: "a", expiresAt: "x", result: {} }));
    const res = await runJson(["--wallet", "main", "--venues", "aster,hyperliquid,pacifica,lighter", "--network", "testnet", "--approve-agents", "--yes", "--passphrase", "pp"]);
    expect(res.ok).toBe(true);
    expect(res.data.agents).toEqual([
      expect.objectContaining({ venue: "aster", status: "approved" }),
      expect.objectContaining({ venue: "hyperliquid", status: "approved" }),
      expect.objectContaining({ venue: "pacifica", status: "approved" }),
      expect.objectContaining({ venue: "lighter", status: "approved" }),
    ]);
    expect(approveVenueAgent).toHaveBeenCalledTimes(4);
    for (const call of approveVenueAgent.mock.calls) expect(call[0]).toMatchObject({ network: "testnet" });
  });

  it("rejects reserved Lighter RH slots up front", async () => {
    const res = await runJson(["--wallet", "main", "--venues", "lighter-rh", "--lighter-rh-api-key-index", "157"]);
    expect(res.error.code).toBe("INVALID_PARAMS");
  });
});

describe("setup copy", () => {
  it("explains the single slippage bound incl. trigger gap risk and per-venue maxima", () => {
    const text = slippageExplanation(["arcus", "hyperliquid"]).join(" ");
    expect(text).toMatch(/IOC/);
    expect(text).toMatch(/50 bps \(0\.5%\)/);
    expect(text).toMatch(/trigger/i);
    expect(text).toMatch(/arcus 1000/);
    expect(text).toMatch(/hyperliquid 5000/);
  });

  it("next steps only name commands that exist", () => {
    const cmds = nextStepCommands(["pacifica", "ondo"], "mainnet");
    expect(cmds).toContain("perp funds deposit pacifica <amount>");
    expect(cmds.some(c => c.includes("funds deposit ondo"))).toBe(false);
    expect(cmds.some(c => /perp (deposit|dashboard)\b/.test(c))).toBe(false);
  });
});

describe("interactive setup (scripted prompter)", () => {
  function scripted(answers: string[], hidden: string[]) {
    return {
      ask: vi.fn(async (_question: string) => {
        if (answers.length === 0) throw new Error("unexpected prompt");
        return answers.shift() as string;
      }),
      askHidden: vi.fn(async () => {
        if (hidden.length === 0) throw new Error("unexpected hidden prompt");
        return hidden.shift() as string;
      }),
      remaining: () => answers.length + hidden.length,
    };
  }

  it("L6: the global -n network is preselected — a blank network answer keeps -n testnet", async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m) => { printed.push(String(m)); });
    const p = scripted([
      "1",            // master wallet: main
      "",             // network: blank → preselected testnet
      "hyperliquid",  // venues (hyperliquid has a testnet)
      "",             // register agent? [Y/n] → yes
      "",             // Sign and submit? [y/N] → No
      "",             // slippage default: keep
      "",             // per-venue: none
    ], []);
    try {
      await runInteractiveSetup(p, undefined, "testnet");
    } finally {
      log.mockRestore();
    }
    expect(p.ask.mock.calls.some(c => String(c[0]).includes("2) testnet [2]"))).toBe(true);
    expect(printed.join("\n")).toMatch(/Network:\s+testnet/);
    expect(approveVenueAgent).not.toHaveBeenCalled();
  });

  it("L7: the Lighter slot prompt states the same range assertLighterSlot accepts (4-254)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const p = scripted(["1", "", "lighter", "", "4", "", "", ""], []);
    try {
      await runInteractiveSetup(p, undefined, "mainnet");
    } finally {
      log.mockRestore();
    }
    const slotPrompt = p.ask.mock.calls.map(c => String(c[0])).find(q => q.includes("API key slot"));
    expect(slotPrompt).toContain("4-254");
    expect(p.remaining()).toBe(0);
  });

  it("default answer at the signing confirmation is No — nothing is signed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const p = scripted([
      "1",        // master wallet: main
      "",         // network: mainnet
      "aster",    // venues
      "",         // register aster agent? [Y/n] → yes
      "",         // aster spot? [y/N] → no
      "",         // Sign and submit? [y/N] → default No
      "",         // slippage default: keep
      "",         // per-venue: none
    ], []);
    try {
      await runInteractiveSetup(p, undefined, "mainnet");
    } finally {
      log.mockRestore();
    }
    expect(p.remaining()).toBe(0);
    expect(approveVenueAgent).not.toHaveBeenCalled();
    expect(p.askHidden).not.toHaveBeenCalled();
    const s = savedSettings();
    expect(s.owsActiveWallet).toBe("main");
    expect(s.defaultExchange).toBe("aster");
  });

  it("signs after explicit y, imports the Ondo key (secret hidden), and keeps going after a venue failure", async () => {
    approveVenueAgent.mockImplementation(async () => { throw new PerpError("EXCHANGE_ERROR", "hl down"); });
    importVenueAgent.mockImplementation(async (p: { venue: string }) => ({
      venue: p.venue, agentName: "web-ondo", verification: { status: "verified", method: "GET /v1/account" },
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const p = scripted([
      "1",                 // master wallet
      "1",                 // mainnet
      "hyperliquid,ondo",  // venues
      "y", "y",            // HL: approve (menu "y" = 1), sign
      "y", "ondoKeyId_1",  // Ondo (website keys only): import? key id
      "40",                // slippage default
      "ondo=200",          // per-venue
      "2",                 // default venue: ondo
    ], ["vault-pp", "ondo-secret"]);
    const printed: string[] = [];
    log.mockImplementation((m) => { printed.push(String(m)); });
    // The interactive wizard runs on a terminal: the passphrase comes from the hidden prompt.
    const prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await runInteractiveSetup(p, undefined, "mainnet");
    } finally {
      log.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: prevTty, configurable: true });
    }
    expect(p.remaining()).toBe(0);
    expect(approveVenueAgent).toHaveBeenCalledTimes(1);
    expect(approveVenueAgent.mock.calls[0][0]).toMatchObject({ venue: "hyperliquid", passphrase: "vault-pp", canWithdraw: false });
    expect(importVenueAgent).toHaveBeenCalledTimes(1);
    expect(importVenueAgent.mock.calls[0][0]).toMatchObject({ venue: "ondo", network: "mainnet", secret: { kind: "ondo", keyId: "ondoKeyId_1", secret: "ondo-secret" } });
    // Secrets are never printed.
    expect(printed.join("\n")).not.toMatch(/ondo-secret|vault-pp/);
    const s = savedSettings();
    expect(s.defaultSlippageBps).toBe(40);
    expect(s.slippageBps).toEqual({ ondo: 200 });
    expect(s.defaultExchange).toBe("ondo");
  });
});

// ── Website-created keys (no master wallet on this computer) ──

function pipeStdin(text: string): void {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
  vi.spyOn(process.stdin, "on").mockImplementation(((ev: string, cb: (x?: string) => void) => {
    if (ev === "data") queueMicrotask(() => cb(text));
    if (ev === "end") setTimeout(() => cb(), 0);
    return process.stdin;
  }) as never);
}

describe("setup --non-interactive --import-agents (no master wallet)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
  });

  it("imports one key per venue from stdin in order, with no master wallet; owsActiveWallet untouched", async () => {
    importVenueAgent.mockImplementation(async (p: { venue: string }) => ({
      venue: p.venue, agentName: `web-${p.venue}`,
      verification: p.venue === "pacifica" ? { status: "unverified", method: "no read-only check" } : { status: "verified", method: "userRole" },
    }));
    pipeStdin("0xHLKEYLINE\nPACKEYLINE\nondoKeyId_x\nondoApiSecret_y\n");
    const res = await runJson([
      "--venues", "hyperliquid,pacifica,ondo", "--import-agents", "hyperliquid,pacifica,ondo", "--yes",
      "--master-address", "pacifica=PacMasterAddr", "--network", "testnet", "--allow-unverified", "pacifica",
    ]);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ walletName: null, walletCreated: false, owsActiveWallet: "", network: "testnet" });
    expect(res.data.agents).toEqual([
      { venue: "hyperliquid", status: "imported", agentName: "web-hyperliquid", verification: { status: "verified", method: "userRole" } },
      { venue: "pacifica", status: "imported", agentName: "web-pacifica", verification: { status: "unverified", method: "no read-only check" } },
      { venue: "ondo", status: "imported", agentName: "web-ondo", verification: { status: "verified", method: "userRole" } },
    ]);
    expect(importVenueAgent.mock.calls.map(c => (c[0] as { secret: unknown }).secret)).toEqual([
      { kind: "key", key: "0xHLKEYLINE" },
      { kind: "key", key: "PACKEYLINE" },
      { kind: "ondo", keyId: "ondoKeyId_x", secret: "ondoApiSecret_y" },
    ]);
    expect(importVenueAgent.mock.calls[1][0]).toMatchObject({ venue: "pacifica", network: "testnet", masterAddress: "PacMasterAddr" });
    expect(approveVenueAgent).not.toHaveBeenCalled();
    expect(mockOws.createWallet).not.toHaveBeenCalled();
    expect(savedSettings().owsActiveWallet).toBe("");
    // Keys are never echoed.
    expect(JSON.stringify(res)).not.toMatch(/HLKEYLINE|PACKEYLINE|ondoApiSecret_y/);
  });

  it("validates before any side effect: --yes, venues ⊆ --venues, a master for approved venues, stdin line count", async () => {
    pipeStdin("k1\n");
    expect((await runJson(["--venues", "hyperliquid", "--import-agents", "hyperliquid"])).error.code).toBe("INVALID_PARAMS");
    expect((await runJson(["--venues", "aster", "--import-agents", "hyperliquid", "--yes"])).error.code).toBe("INVALID_PARAMS");
    // aster would need an approve (master) but there is no wallet
    expect((await runJson(["--venues", "aster,hyperliquid", "--import-agents", "hyperliquid", "--approve-agents", "--yes"])).error.code).toBe("INVALID_PARAMS");
    const short = await runJson(["--venues", "hyperliquid,lighter", "--import-agents", "hyperliquid,lighter", "--yes", "--lighter-account-index", "1", "--lighter-api-key-index", "6"]);
    expect(short.error.code).toBe("INVALID_PARAMS");
    expect(short.error.message).toMatch(/expects 2 line/);
    expect(importVenueAgent).not.toHaveBeenCalled();
    expect(existsSync(SETTINGS_FILE)).toBe(false);
  });

  it("refuses --import-agents when stdin is a terminal (keys are never prompted for or taken from argv here)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const res = await runJson(["--venues", "hyperliquid", "--import-agents", "hyperliquid", "--yes"]);
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(importVenueAgent).not.toHaveBeenCalled();
  });

  it("M3: pacifica (unverifiable) needs --allow-unverified pacifica — refused before reading stdin or importing", async () => {
    pipeStdin("0xHLKEYLINE\nPACKEYLINE\n");
    const res = await runJson(["--venues", "hyperliquid,pacifica", "--import-agents", "hyperliquid,pacifica", "--yes", "--master-address", "pacifica=PacMasterAddr"]);
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toMatch(/UNVERIFIED/);
    expect(res.error.details.remediation).toMatch(/--allow-unverified pacifica/);
    expect(importVenueAgent).not.toHaveBeenCalled();
    expect(existsSync(SETTINGS_FILE)).toBe(false);
    // --allow-unverified must name an --import-agents venue
    pipeStdin("0xHLKEYLINE\n");
    expect((await runJson(["--venues", "hyperliquid", "--import-agents", "hyperliquid", "--yes", "--allow-unverified", "pacifica"])).error.code).toBe("INVALID_PARAMS");
  });

  it("M3: the same key for two venues in one batch is refused before any import (key not echoed)", async () => {
    pipeStdin(`0x${"ab".repeat(32)}\n${"AB".repeat(32)}\n`);
    const res = await runJson(["--venues", "hyperliquid,aster", "--import-agents", "hyperliquid,aster", "--yes", "--master-address", `aster=0x${"11".repeat(20)}`]);
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toMatch(/same key was given for hyperliquid and aster/);
    expect(JSON.stringify(res)).not.toMatch(/abababab/i);
    expect(importVenueAgent).not.toHaveBeenCalled();
  });

  it("M3: when another import in the batch fails, the batch's unverified pacifica import is rolled back", async () => {
    importVenueAgent.mockImplementation(async (p: { venue: string }) => {
      if (p.venue === "hyperliquid") throw new PerpError("AGENT_NOT_REGISTERED", "not an agent");
      storedImports.set(`${p.venue}:web-${p.venue}`, { agentName: `web-${p.venue}`, source: "imported" });
      return { venue: p.venue, agentName: `web-${p.venue}`, verification: { status: "unverified", method: "no read-only check" } };
    });
    pipeStdin("PACKEYLINE\n0xHLKEYLINE\n");
    const res = await runJson([
      "--venues", "pacifica,hyperliquid", "--import-agents", "pacifica,hyperliquid", "--yes",
      "--master-address", "pacifica=PacMasterAddr", "--allow-unverified", "pacifica",
    ]);
    storedImports.clear();
    expect(res.ok).toBe(false);
    expect(deleteImportedAgentLocal).toHaveBeenCalledTimes(1);
    expect(deleteImportedAgentLocal.mock.calls[0]).toEqual(["pacifica", "mainnet", { agentName: "web-pacifica", source: "imported" }]);
    const agents = res.error.details.result.agents;
    expect(agents[0]).toMatchObject({ venue: "pacifica", status: "failed", error: { code: "APPROVE_FAILED" } });
    expect(agents[0].error.message).toMatch(/removed again because hyperliquid failed/);
    expect(agents[1]).toMatchObject({ venue: "hyperliquid", status: "failed", error: { code: "AGENT_NOT_REGISTERED" } });
  });

  it("an import failure is reported per venue (settings saved) with an import remediation", async () => {
    importVenueAgent.mockImplementation(async () => { throw new PerpError("AGENT_NOT_REGISTERED", "not an agent"); });
    pipeStdin("k1\n");
    const res = await runJson(["--venues", "hyperliquid", "--import-agents", "hyperliquid", "--yes"]);
    expect(res.ok).toBe(false);
    expect(res.error.details.result.agents[0]).toMatchObject({ venue: "hyperliquid", status: "failed", error: { code: "AGENT_NOT_REGISTERED" } });
    expect(res.error.details.remediation).toMatch(/wallet agent import/);
  });
});

describe("interactive setup without a master wallet", () => {
  it("skip master → every venue offers import only (Aster testnet included); copy explains the master is needed for funds", async () => {
    importVenueAgent.mockImplementation(async (p: { venue: string }) => ({ venue: p.venue, agentName: "web-aster-tn", verification: { status: "verified", method: "signed read" } }));
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m) => { printed.push(String(m)); });
    const answers = [
      "s",            // master wallet: skip
      "2",            // testnet
      "aster",        // venues
      "",             // import a key created on the website? [Y/n]
      "0xMasterEvm",  // master address
      "",             // slippage default: keep
      "",             // per-venue: none
    ];
    const hidden = ["0xasterkey"];
    const p = {
      ask: vi.fn(async () => answers.shift() as string),
      askHidden: vi.fn(async () => hidden.shift() as string),
    };
    try {
      await runInteractiveSetup(p, undefined, "mainnet");
    } finally {
      log.mockRestore();
    }
    expect(answers).toHaveLength(0);
    expect(hidden).toHaveLength(0);
    expect(approveVenueAgent).not.toHaveBeenCalled();
    expect(importVenueAgent).toHaveBeenCalledTimes(1);
    expect(importVenueAgent.mock.calls[0][0]).toMatchObject({ venue: "aster", network: "testnet", masterAddress: "0xMasterEvm", secret: { kind: "key", key: "0xasterkey" } });
    const text = printed.join("\n");
    expect(text).toMatch(/Deposits, withdrawals/);
    expect(text).toMatch(/none on this computer/);
    expect(text).not.toContain("0xasterkey");
    expect(savedSettings().owsActiveWallet).toBe("");
  });
});
