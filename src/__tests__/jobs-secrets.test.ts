/**
 * Background children (tmux) and the OWS CLI child never receive key material via
 * argv or env (SSOT Rule #3). jobs.ts used to prefix the tmux command with
 * `PRIVATE_KEY='0x…' LIGHTER_PRIVATE_KEY='…'` — visible in `ps` — and alerts did the same.
 *
 *  - the tmux command line carries only secret NAMES (`env -u NAME`), never values;
 *  - the tmux client is spawned with a scrubbed env (a fresh tmux server inherits it);
 *  - a secret the child cannot re-read itself (shell-exported, not in ~/.perp/.env) is
 *    refused with INVALID_PARAMS when the child signs — no job is started;
 *  - keys in ~/.perp/.env stay usable: the child re-reads the file itself.
 *
 * child_process is mocked: no tmux, no OWS binary, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

const execSync = vi.fn((..._a: unknown[]) => Buffer.from(""));
// tmux is invoked without a shell (execFileSync: review L6).
const execFileSync = vi.fn((..._a: unknown[]) => Buffer.from(""));
const spawnSync = vi.fn((..._a: unknown[]) => ({ stdout: "ok", stderr: "", status: 0 }));
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execSync, execFileSync, spawnSync }));
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), execSync, execFileSync, spawnSync }));

const isNewSession = (c: unknown[]): boolean => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "new-session";

const { startJob, launchTmuxChild } = await import("../jobs.js");

const PK = `0x${"ab".repeat(32)}`;
const PP = "master-passphrase-xyz";
const HOME = process.env.HOME as string;
const SECRET_VARS = ["PRIVATE_KEY", "HL_PRIVATE_KEY", "LIGHTER_PRIVATE_KEY", "OWS_PASSPHRASE", "OWS_API_KEY", "pk", "MY_VENUE_SECRET"];

const baseOpts = {
  strategy: "twap", exchange: "hyperliquid", params: {}, venue: "hyperliquid",
  network: "testnet" as const, dryRun: false,
  selectors: { ows: "main", wallet: null, noAgent: false, dex: null, noBuilder: false },
  cliArgs: ["strategy", "twap", "BTC", "buy", "0.1", "600"],
};

function newSessionCall(): { cmd: string; env: NodeJS.ProcessEnv } {
  const call = execFileSync.mock.calls.find(isNewSession);
  expect(call).toBeDefined();
  return { cmd: String((call![1] as string[])[4]), env: (call![2] as { env: NodeJS.ProcessEnv }).env };
}

function writeDotenv(lines: string[]): void {
  mkdirSync(join(HOME, ".perp"), { recursive: true });
  writeFileSync(join(HOME, ".perp", ".env"), lines.join("\n") + "\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of SECRET_VARS) delete process.env[k];
  writeDotenv([]);
});
afterEach(() => {
  for (const k of SECRET_VARS) delete process.env[k];
});

describe("startJob: no key material on the child's argv / env", () => {
  it("keys loaded from ~/.perp/.env: job starts, command has only `env -u` names, tmux env is scrubbed", () => {
    writeDotenv([`PRIVATE_KEY=${PK}`, `LIGHTER_PRIVATE_KEY=${PK}`]);
    process.env.PRIVATE_KEY = PK; // as dotenv loaded it in index.ts
    process.env.LIGHTER_PRIVATE_KEY = PK;
    process.env.OWS_PASSPHRASE = ""; // empty = the child's default, nothing to hand over

    const job = startJob(baseOpts);
    expect(job.tmuxSession).toMatch(/^perp-/);
    const { cmd, env } = newSessionCall();
    expect(cmd).not.toContain(PK);
    expect(cmd).not.toContain("ab".repeat(8));
    expect(cmd).toContain("-u");
    for (const k of ["PRIVATE_KEY", "LIGHTER_PRIVATE_KEY", "OWS_PASSPHRASE", "OWS_API_KEY"]) expect(cmd).toContain(`'${k}'`);
    expect(cmd).not.toMatch(/PRIVATE_KEY=/);
    for (const k of SECRET_VARS) expect(env).not.toHaveProperty(k);
    // Non-secret selectors still reach the child.
    expect(cmd).toMatch(/--ows\W+main\W/);
    expect(cmd).toMatch(/-n\W+testnet\W/);
  });

  it.each([
    ["PRIVATE_KEY", PK],
    ["HL_PRIVATE_KEY", PK],
    ["OWS_PASSPHRASE", PP],
    ["OWS_API_KEY", "ows_key_abcdef"],
  ])("shell-only %s → INVALID_PARAMS with remediation, no tmux session", (name, value) => {
    process.env[name] = value;
    let err: unknown = null;
    try { startJob(baseOpts); } catch (e) { err = e; }
    expect(err).toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect((err as Error).message).toContain(name);
    expect((err as Error).message).not.toContain(value);
    expect((err as { structured: { remediation: string } }).structured.remediation).toMatch(/OWS vault|agent approve/);
    expect(execFileSync.mock.calls.some(isNewSession)).toBe(false);
  });

  it("a shell value that differs from ~/.perp/.env is still shell-only → refused", () => {
    writeDotenv([`PRIVATE_KEY=0x${"cd".repeat(32)}`]);
    process.env.PRIVATE_KEY = PK;
    expect(() => startJob(baseOpts)).toThrow(/PRIVATE_KEY/);
  });

  it("launchTmuxChild without credentials (alerts daemon): secrets are stripped, never refused or forwarded", () => {
    process.env.PRIVATE_KEY = PK;
    process.env.OWS_PASSPHRASE = PP;
    process.env.MY_VENUE_SECRET = "s3cr3t-value";
    launchTmuxChild("perp-alerts-x", ["alerts", "start", "--interval", "60"], null, false);
    const { cmd, env } = newSessionCall();
    for (const v of [PK, PP, "s3cr3t-value"]) expect(cmd).not.toContain(v);
    expect(cmd).toContain("'MY_VENUE_SECRET'");
    for (const k of SECRET_VARS) expect(env).not.toHaveProperty(k);
  });
});

describe("OWS CLI child (wallet backup / deposit) gets a scrubbed env", () => {
  it("runOwsCli passes no secret env var to the ows binary", async () => {
    const bin = join(HOME, ".ows", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ows"), "#!/bin/sh\n");
    chmodSync(join(bin, "ows"), 0o755);
    process.env.PRIVATE_KEY = PK;
    process.env.OWS_PASSPHRASE = PP;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { registerWalletCommands } = await import("../commands/wallet.js");
    const p = new Command();
    p.exitOverride();
    registerWalletCommands(p, () => true);
    await p.parseAsync(["node", "perp", "wallet", "backup", "-o", join(HOME, "b.enc")]);

    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnSync.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args.join(" ")).not.toContain(PK);
    expect(opts.env).not.toHaveProperty("PRIVATE_KEY");
    expect(opts.env).not.toHaveProperty("OWS_PASSPHRASE");
    expect(opts.env.PATH).toContain(".ows/bin");
  });
});

describe("L6: tmux session names, file modes, alerts network", () => {
  it("job file and log are created 0600; tmux gets the session name as a plain argv element", async () => {
    const { statSync } = await import("node:fs");
    const { logFile } = await import("../jobs.js");
    writeDotenv([]);
    const job = startJob(baseOpts);
    const call = execFileSync.mock.calls.find(isNewSession)!;
    expect((call[1] as string[]).slice(0, 4)).toEqual(["new-session", "-d", "-s", job.tmuxSession]);
    expect(statSync(join(HOME, ".perp", "jobs", `${job.id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(logFile(job.id)).mode & 0o777).toBe(0o600);
  });

  it("a tampered session name from a job file is refused before tmux runs", async () => {
    const { saveJob, stopJob, assertTmuxSessionName } = await import("../jobs.js");
    expect(() => assertTmuxSessionName("perp-abc; rm -rf ~")).toThrow(/Invalid tmux session name/);
    expect(() => assertTmuxSessionName("perp-alerts-k3x9")).not.toThrow();
    saveJob({ id: "deadbeef", strategy: "twap", exchange: "hyperliquid", params: {}, tmuxSession: "perp-x;touch /tmp/pwn", startedAt: "", status: "running" });
    execFileSync.mockClear();
    await expect(stopJob("deadbeef")).rejects.toThrow(/Invalid tmux session name/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("launchTmuxChild refuses an invalid session name", () => {
    expect(() => launchTmuxChild("bad name", ["alerts", "start"], null, false)).toThrow(/Invalid tmux session name/);
  });
});


describe("L6: alerts --background child runs on the parent's network", () => {
  it("passes -n <network> to the alerts child", async () => {
    const { saveSettings, loadSettings } = await import("../settings.js");
    const st = loadSettings();
    st.alerts = { ...st.alerts, telegram: { botToken: "t", chatId: "1" }, rules: [{ id: "r1", symbol: "ETH", exchange: "*", threshold: 30, direction: "above", enabled: true }] };
    saveSettings(st);
    const { addRootSafetyOptions } = await import("../cli-flags.js");
    const { registerAlertCommands } = await import("../commands/alerts.js");
    const prog = addRootSafetyOptions(new Command()).option("--json");
    registerAlertCommands(prog, () => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    execFileSync.mockClear();
    await prog.parseAsync(["node", "perp", "-n", "testnet", "--json", "alerts", "start", "--background"]);
    vi.restoreAllMocks();
    const call = execFileSync.mock.calls.find(isNewSession)!;
    expect(String((call[1] as string[])[4])).toMatch(/'-n' 'testnet' 'alerts' 'start'/);
  });
});
