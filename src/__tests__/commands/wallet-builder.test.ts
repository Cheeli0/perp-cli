/**
 * `perp wallet builder status|approve|revoke <venue>` (src/commands/builder.ts).
 *
 * Approve only ever signs the builder configured in settings builder.<venue>, needs an
 * explicit y/N or --yes, is master-signed (NO_SIGNER_AVAILABLE without a master on this
 * computer → "approve on the website"), and --dry-run prints the plan without signing.
 * No network: fetch is mocked; the OWS master signer is stubbed; HOME isolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import os from "os";

const TEST_HOME = resolve(os.tmpdir(), `perp-wallet-builder-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

// A syntactically valid 65-byte signature (ethers.Signature.from parses it).
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
const MASTER = "0x00000000000000000000000000000000000000Aa";
const signTypedData = vi.fn(async () => SIG);
vi.mock("../../signer/ows-evm.js", () => ({
  OwsEvmSigner: { create: vi.fn(() => ({ getAddress: () => MASTER, signTypedData })) },
}));

const { buildProgram } = await import("../../cli-program.js");

const HL_BUILDER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

function writeSettings(obj: Record<string, unknown>): void {
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
  writeFileSync(resolve(TEST_HOME, ".perp", "settings.json"), JSON.stringify(obj));
}

async function run(args: string[]): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => { lines.push(String(m)); });
  try {
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    await program.parseAsync(["node", "perp", "--json", ...args]);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines.join("\n"));
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  fetchSpy = vi.fn(async () => { throw new Error("unexpected network call"); });
  vi.stubGlobal("fetch", fetchSpy);
  signTypedData.mockClear();
  vi.stubEnv("OWS_PASSPHRASE", "pp");
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("wallet builder approve", () => {
  it("unsupported venue → CAPABILITY_UNSUPPORTED (lighter: integrator fields not yet implemented)", async () => {
    const r = await run(["wallet", "builder", "approve", "lighter"]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(String(r.error?.message)).toMatch(/not yet implemented/);
  });

  it("not configured → INVALID_PARAMS pointing at the explicit opt-in (builder fees are off)", async () => {
    const r = await run(["wallet", "builder", "approve", "hyperliquid"]);
    expect(r.error?.code).toBe("INVALID_PARAMS");
    expect(String(r.error?.remediation)).toContain("perp settings set builder.hyperliquid");
  });

  it("--dry-run prints the plan (configured builder + fee in venue units) and signs / sends nothing — even without a master", async () => {
    writeSettings({ builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["--dry-run", "wallet", "builder", "approve", "hl"]);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      dryRun: true, sent: false, venue: "hyperliquid", network: "mainnet", identity: HL_BUILDER.toLowerCase(),
      feeBps: 1, capBps: 10, venueFeeValue: "0.01%", master: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("no master on this computer → NO_SIGNER_AVAILABLE with 'approve on the website'", async () => {
    writeSettings({ builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["wallet", "builder", "approve", "hyperliquid", "--yes"]);
    expect(r.error?.code).toBe("NO_SIGNER_AVAILABLE");
    expect(String(r.error?.remediation)).toMatch(/website/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aster on testnet → CAPABILITY_UNSUPPORTED (no testnet builder flow); nothing signed", async () => {
    writeSettings({ owsActiveWallet: "main", builder: { aster: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["-n", "testnet", "wallet", "builder", "approve", "aster", "--yes"]);
    expect(r.error?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("ondo has no approval step → reported, nothing signed", async () => {
    writeSettings({ builder: { ondo: { code: "c1", feeBps: 2 } } });
    const r = await run(["wallet", "builder", "approve", "ondo"]);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ approvalRequired: false, sent: false, approval: "none" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without --yes in a non-interactive run → INVALID_PARAMS (explicit consent), nothing signed", async () => {
    writeSettings({ owsActiveWallet: "main", builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["wallet", "builder", "approve", "hyperliquid"]);
    expect(r.error?.code).toBe("INVALID_PARAMS");
    expect(String(r.error?.message)).toMatch(/explicit confirmation/);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--yes with a master: one master-signed approveBuilderFee for exactly the configured builder / fee", async () => {
    writeSettings({ owsActiveWallet: "main", builder: { hyperliquid: { address: HL_BUILDER, feeBps: 2.5 } } });
    const bodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body: string }) => {
      expect(url).toBe("https://api.hyperliquid.xyz/exchange");
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", response: { type: "default" } }) };
    });
    const r = await run(["wallet", "builder", "approve", "hyperliquid", "--yes"]);
    expect(r.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].action).toMatchObject({
      type: "approveBuilderFee", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1",
      maxFeeRate: "0.025%", builder: HL_BUILDER.toLowerCase(),
    });
    const [domain, types, message] = signTypedData.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(domain).toMatchObject({ name: "HyperliquidSignTransaction", chainId: 42161 });
    expect(Object.keys(types)).toEqual(["HyperliquidTransaction:ApproveBuilderFee"]);
    expect(message).toMatchObject({ hyperliquidChain: "Mainnet", maxFeeRate: "0.025%", builder: HL_BUILDER.toLowerCase() });
  });

  it("aster --yes: master-signed ApproveBuilder with maxFeeRate as a decimal", async () => {
    writeSettings({ owsActiveWallet: "main", builder: { aster: { address: HL_BUILDER, feeBps: 1 } } });
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200 }) };
    });
    const r = await run(["wallet", "builder", "approve", "aster", "--yes"]);
    expect(r.ok).toBe(true);
    const u = new URL(urls[0]);
    expect(u.pathname).toBe("/fapi/v3/approveBuilder");
    expect(u.searchParams.get("builder")).toBe(HL_BUILDER.toLowerCase());
    expect(u.searchParams.get("maxFeeRate")).toBe("0.0001");
    expect(u.searchParams.get("user")).toBe(MASTER);
  });
});

describe("wallet builder revoke", () => {
  it("hyperliquid → CAPABILITY_UNSUPPORTED (no documented revoke) with the unset remediation", async () => {
    writeSettings({ owsActiveWallet: "main", builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["wallet", "builder", "revoke", "hyperliquid", "--yes"]);
    expect(r.error?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(String(r.error?.remediation)).toContain("perp settings unset builder.hyperliquid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aster --dry-run → DelBuilder plan, nothing sent", async () => {
    writeSettings({ owsActiveWallet: "main", builder: { aster: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["--dry-run", "wallet", "builder", "revoke", "aster"]);
    expect(r.data).toMatchObject({ dryRun: true, sent: false, venue: "aster" });
    expect(String(r.data?.action)).toMatch(/DelBuilder/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("wallet builder status", () => {
  it("lists supported / unsupported venues; unconfigured = off, no account access", async () => {
    const r = await run(["wallet", "builder", "status"]);
    expect(r.ok).toBe(true);
    const rows = r.data?.venues as Array<Record<string, unknown>>;
    const by = Object.fromEntries(rows.map(x => [x.venue, x]));
    expect(by.lighter).toMatchObject({ supported: false, attaches: false });
    expect(by.arcus).toMatchObject({ supported: false });
    expect(by.hyperliquid).toMatchObject({ supported: true, configured: null, approval: null, attaches: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("configured but the approval cannot be read → unknown, not attached", async () => {
    writeSettings({ builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 } } });
    const r = await run(["wallet", "builder", "status", "hyperliquid"]);
    const row = (r.data?.venues as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ venue: "hyperliquid", configured: { identity: HL_BUILDER.toLowerCase(), feeBps: 1 }, attaches: false });
    expect((row.approval as Record<string, unknown>).status).toBe("unknown");
  });

  it("ondo configured → attaches without approval", async () => {
    writeSettings({ builder: { ondo: { code: "c1", feeBps: 2 } } });
    const r = await run(["wallet", "builder", "status", "ondo"]);
    expect((r.data?.venues as Array<Record<string, unknown>>)[0]).toMatchObject({ attaches: true, approval: { status: "approved", maxFeeBps: null } });
  });
});

const { stepBuilder } = await import("../../commands/init.js");

describe("perp setup — optional builder step", () => {
  const prompter = (answers: string[]) => {
    const asked: string[] = [];
    return { asked, p: { ask: vi.fn(async (q: string) => { asked.push(q); return answers.shift() ?? ""; }), askHidden: vi.fn(async () => "pp") } };
  };

  it("not offered at all when settings.builder is empty (default)", async () => {
    const { p, asked } = prompter([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await stepBuilder(p, ["hyperliquid", "ondo"], "mainnet", "main", async () => "pp");
    expect(asked).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("explains the fee, asks with default No, and Enter skips (nothing signed)", async () => {
    writeSettings({ builder: { hyperliquid: { address: HL_BUILDER, feeBps: 1 }, ondo: { code: "c1", feeBps: 2 } } });
    const { p, asked } = prompter([""]);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m) => { lines.push(String(m)); });
    await stepBuilder(p, ["hyperliquid", "ondo"], "mainnet", "main", async () => "pp");
    log.mockRestore();
    expect(asked).toHaveLength(1); // ondo has no approval step → informational only
    expect(asked[0]).toMatch(/Approve builder .* charge 1 bps on your hyperliquid perp orders .*\[y\/N\]/);
    expect(lines.join("\n")).toMatch(/extra fee on YOUR perp orders/);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
