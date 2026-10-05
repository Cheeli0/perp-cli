/**
 * Referral signing is explicit only.
 *
 *  - Adapter creation (createHyperliquid / createLighterFamily) with a signer must NOT
 *    sign or send a referral action (it used to fire HL setReferrer / Lighter
 *    referral/use on every non-read-only creation — including read-only paths).
 *  - `wallet manage referral set` is the explicit step: --dry-run returns a plan and
 *    builds no adapter; a live run sends exactly one referral action.
 *  - HL setReferrer surfaces a venue rejection (no silent swallow — SSOT Rule #2).
 *
 * No network: global fetch throws; adapter init is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Command } from "commander";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import type { VenueCreateContext } from "../exchanges/venue.js";

const PK = `0x${"42".repeat(32)}`;

let liveAdapter: unknown = null;
const venueCreate = vi.fn(async () => liveAdapter);
vi.mock("../exchanges/venue.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../exchanges/venue.js")>();
  return {
    ...orig,
    getVenue: (input: string) => {
      const def = orig.getVenue(input);
      return def.create === null ? def : { ...def, create: venueCreate };
    },
  };
});
vi.mock("../config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config.js")>();
  return { ...orig, hasCredentials: vi.fn(async () => false) };
});

const { createHyperliquid, createLighterFamily } = await import("../exchanges/venues/create-helpers.js");
const { buildProgram } = await import("../cli-program.js");
const { allCommands } = await import("../cli-flags.js");
const { loadSettings } = await import("../settings.js");

function ctx(): VenueCreateContext {
  return {
    network: "mainnet",
    credentials: { pk: PK, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: null },
    noAgent: false,
    hlDex: null,
    readOnly: false,
    noBuilder: false,
  };
}

const fetchSpy = vi.fn(async (url: unknown) => { throw new Error(`unexpected network call: ${String(url)}`); });
let out: string[];

beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  liveAdapter = null;
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("adapter creation never signs a referral", () => {
  it("createHyperliquid with a PK signer → setReferrer / exchange action never called", async () => {
    vi.spyOn(HyperliquidAdapter.prototype, "init").mockResolvedValue(undefined);
    const setRef = vi.spyOn(HyperliquidAdapter.prototype, "setReferrer");
    const send = vi.spyOn(HyperliquidAdapter.prototype as unknown as { _sendExchangeAction: () => Promise<unknown> }, "_sendExchangeAction");
    await createHyperliquid(ctx());
    await new Promise(r => setTimeout(r, 0));
    expect(setRef).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createLighterFamily(lighter) with an active signer → useReferralCode never called", async () => {
    vi.spyOn(LighterAdapter.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(LighterAdapter.prototype, "isReadOnly", "get").mockReturnValue(false);
    const useRef = vi.spyOn(LighterAdapter.prototype, "useReferralCode");
    await createLighterFamily("lighter", ctx());
    await new Promise(r => setTimeout(r, 0));
    expect(useRef).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HyperliquidAdapter.setReferrer", () => {
  it("throws EXCHANGE_ERROR on a venue rejection (no silent swallow)", async () => {
    const a = new HyperliquidAdapter(PK, false);
    vi.spyOn(a as unknown as { _sendExchangeAction: () => Promise<unknown> }, "_sendExchangeAction")
      .mockResolvedValue({ status: "err", response: "Referrer already set" });
    await expect(a.setReferrer("CODE")).rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("sends exactly one setReferrer action with the code", async () => {
    const a = new HyperliquidAdapter(PK, false);
    const send = vi.spyOn(a as unknown as { _sendExchangeAction: (x: unknown) => Promise<unknown> }, "_sendExchangeAction")
      .mockResolvedValue({ status: "ok" });
    await a.setReferrer("CODE");
    expect(send).toHaveBeenCalledWith({ type: "setReferrer", code: "CODE" });
  });
});

describe("wallet manage referral set (explicit)", () => {
  function program(): Command {
    const { program: p } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    for (const c of [p, ...allCommands(p)]) {
      c.exitOverride();
      c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    }
    return p;
  }
  const run = (args: string[]) => program().parseAsync(["node", "perp", ...args]);
  const lastJson = () => JSON.parse(out.filter(l => l.trim().startsWith("{")).at(-1)!);

  it.each([
    [["--json", "--dry-run", "-e", "hl", "wallet", "manage", "referral", "set"], "hyperliquid", "HYPERCASH"],
    [["--json", "-e", "lighter", "wallet", "manage", "referral", "set", "ABC", "--dry-run"], "lighter", "ABC"],
  ])("%j → plan with sent:false; no adapter built, nothing sent", async (argv, venue, code) => {
    await run(argv);
    expect(lastJson()).toMatchObject({ ok: true, data: { dryRun: true, sent: false, venue, code } });
    expect(venueCreate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadSettings().referralApplied).toEqual({ hyperliquid: false, lighter: false });
  });

  it("live -e hl → one setReferrer with the given code, referralApplied.hyperliquid = true", async () => {
    const a = new HyperliquidAdapter(PK, false);
    const setRef = vi.spyOn(a, "setReferrer").mockResolvedValue({ status: "ok" });
    liveAdapter = a;
    await run(["--json", "--ows", "main", "-e", "hl", "wallet", "manage", "referral", "set", "XYZ"]);
    expect(setRef).toHaveBeenCalledTimes(1);
    expect(setRef).toHaveBeenCalledWith("XYZ");
    expect(lastJson()).toMatchObject({ ok: true, data: { sent: true, venue: "hyperliquid", code: "XYZ" } });
    expect(loadSettings().referralApplied.hyperliquid).toBe(true);
  });

  it("live without a master wallet on this computer → NO_SIGNER_AVAILABLE, nothing built or sent", async () => {
    await run(["--json", "-e", "hl", "wallet", "manage", "referral", "set", "XYZ"]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "NO_SIGNER_AVAILABLE" } });
    expect(String((lastJson() as { error: { remediation: string } }).error.remediation)).toMatch(/website|perp wallet import/);
    expect(venueCreate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("-e pacifica → CAPABILITY_UNSUPPORTED, nothing built", async () => {
    await run(["--json", "-e", "pacifica", "wallet", "manage", "referral", "set", "X"]);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(venueCreate).not.toHaveBeenCalled();
  });
});
