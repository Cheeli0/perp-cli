import { execFileSync, execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { parse as parseDotenv } from "dotenv";
import type { Network } from "./exchanges/venue-types.js";
import { PerpError } from "./errors.js";
import { QFEX_AUTOMATION_VERIFIED, QFEX_REDUCE_ONLY_WIRE, qfexAutomationGate, qfexReduceOnlyGate } from "./exchanges/qfex/signing.js";
import { startRefusal } from "./exchanges/trading-v2.js";
import { scrubSecretEnv, secretEnvNamesIn } from "./secret-env.js";

const JOBS_DIR = join(homedir(), ".perp", "jobs");
const LOGS_DIR = join(homedir(), ".perp", "logs");

export interface JobEntry {
  id: string;
  strategy: string;
  exchange: string;
  params: Record<string, unknown>;
  tmuxSession: string;
  pid?: number;
  startedAt: string;
  status: "running" | "stopped" | "done" | "error";
  result?: Record<string, unknown>;
}

function ensureDirs() {
  mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
}

/**
 * tmux session names we create: "perp-<hex id>" (jobs) / "perp-alerts-<base36>" (alerts).
 * A name read back from a job file is validated before it reaches tmux (review L6) — tmux is
 * also invoked without a shell (execFileSync), so a tampered name can never run a command.
 */
const TMUX_SESSION_RE = /^perp-[A-Za-z0-9_-]{1,64}$/;
export function assertTmuxSessionName(name: string): string {
  if (!TMUX_SESSION_RE.test(name)) {
    throw new PerpError("INVALID_PARAMS", `Invalid tmux session name ${JSON.stringify(name)}`, {
      remediation: "Job files under ~/.perp/jobs must hold a perp-<id> session name; remove the corrupted job: perp background remove <id>",
    });
  }
  return name;
}

/** Write a job/log file owner-only (0600) — they hold strategy params and order logs. */
function writePrivate(path: string, data: string, flag: "w" | "a"): void {
  writeFileSync(path, data, { mode: 0o600, flag });
  chmodSync(path, 0o600);
}

function jobFile(id: string) {
  return join(JOBS_DIR, `${id}.json`);
}

export function logFile(id: string) {
  return join(LOGS_DIR, `${id}.log`);
}

function genId(): string {
  return randomBytes(4).toString("hex");
}

function hasTmux(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore", env: scrubSecretEnv(process.env) });
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionExists(name: string): boolean {
  const session = assertTmuxSessionName(name);
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore", env: scrubSecretEnv(process.env) });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session by (validated) name, without a shell. */
export function killTmuxSession(name: string): void {
  execFileSync("tmux", ["kill-session", "-t", assertTmuxSessionName(name)], { stdio: "ignore", env: scrubSecretEnv(process.env) });
}

export function saveJob(job: JobEntry): void {
  ensureDirs();
  writePrivate(jobFile(job.id), JSON.stringify(job, null, 2), "w");
}

export function loadJob(id: string): JobEntry | null {
  const path = jobFile(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function listJobs(): JobEntry[] {
  ensureDirs();
  const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const job = JSON.parse(readFileSync(join(JOBS_DIR, f), "utf-8")) as JobEntry;
    // Check if tmux session is still alive
    if (job.status === "running" && !tmuxSessionExists(job.tmuxSession)) {
      job.status = "done";
      saveJob(job);
    }
    return job;
  });
}

import { readdirSync } from "node:fs";

/**
 * Root flags that pick WHICH account / market a command uses. A background child
 * must run with the same ones as its parent (otherwise it silently trades another
 * wallet, skips the agent, or another HIP-3 dex). Only non-secret selectors are
 * forwarded; the child resolves the credentials themselves (OWS vault / agent keystores).
 */
export interface JobRootSelectors {
  /** --ows <name> */
  ows: string | null;
  /** -w, --wallet <name> */
  wallet: string | null;
  /** --no-agent */
  noAgent: boolean;
  /** --dex <name> (Hyperliquid HIP-3) */
  dex: string | null;
  /** --no-builder (no builder fee on this run's orders) */
  noBuilder: boolean;
}

const SECRET_HANDOFF_REMEDIATION =
  "Background jobs never receive key material. Import the master key into the OWS vault (perp wallet set <exchange>) " +
  "and select it with --ows/-w, and register an agent (perp wallet agent approve <venue>) — agent keys sign without the " +
  "master passphrase. Keys in ~/.perp/.env are re-read by the job itself.";

/**
 * The parent's root selectors, read from the root program. Throws INVALID_PARAMS when the
 * parent was given key material on argv (-k / --passphrase / --ows-key): it cannot be handed
 * to the child (argv and env are visible in the process list), and the child would otherwise
 * sign with a different account or fail on the passphrase.
 */
export function jobSelectorsOf(cmd: Command): JobRootSelectors {
  let root = cmd;
  while (root.parent) root = root.parent;
  const o = root.opts() as { ows?: string; wallet?: string; agent?: boolean; builder?: boolean; dex?: string; privateKey?: string; passphrase?: string; owsKey?: string };
  const secretFlags = [
    ...(o.privateKey !== undefined ? ["-k/--private-key"] : []),
    ...(o.passphrase !== undefined ? ["--passphrase"] : []),
    ...(o.owsKey !== undefined ? ["--ows-key"] : []),
  ];
  if (secretFlags.length > 0) {
    throw new PerpError("INVALID_PARAMS", `--background cannot hand ${secretFlags.join(", ")} to the background job`, {
      remediation: `Drop ${secretFlags.join(", ")}. ${SECRET_HANDOFF_REMEDIATION}`,
    });
  }
  return {
    ows: o.ows ?? null,
    wallet: o.wallet ?? null,
    // Commander's --no-agent sets opts.agent === false.
    noAgent: o.agent === false,
    dex: o.dex ?? null,
    // Commander's --no-builder sets opts.builder === false.
    noBuilder: o.builder === false,
  };
}

/** Options for a background job: `cliArgs` is the child's full command (path + args), e.g. ["strategy", "grid", "BTC"]. */
export interface StartJobOpts {
  strategy: string;
  exchange: string;
  params: Record<string, unknown>;
  /** Root `-e` for the child (omit for multi-venue commands). */
  venue?: string;
  /** The parent's validated `-n` — the child always runs on the same network. */
  network: Network;
  /** The parent's root `--dry-run` — inherited by the child. */
  dryRun: boolean;
  /** The parent's account / market selectors (jobSelectorsOf) — inherited by the child. */
  selectors: JobRootSelectors;
  cliArgs: string[];
}

/**
 * The child's argv after `node <cli>`: root flags first (`-n`, `--dry-run`, `-e`,
 * `--ows`, `-w`, `--no-agent`, `--dex`, `--no-builder`), then the real command path + args, then
 * `--job-id`. Every target command must exist in buildProgram() and declare
 * `--job-id` (regression-tested).
 */
export function jobArgv(opts: StartJobOpts, id: string): string[] {
  const sel = opts.selectors;
  return [
    "-n", opts.network,
    ...(opts.dryRun ? ["--dry-run"] : []),
    ...(opts.venue !== undefined ? ["-e", opts.venue] : []),
    ...(sel.ows !== null ? ["--ows", sel.ows] : []),
    ...(sel.wallet !== null ? ["-w", sel.wallet] : []),
    ...(sel.noAgent ? ["--no-agent"] : []),
    ...(sel.dex !== null ? ["--dex", sel.dex] : []),
    ...(sel.noBuilder ? ["--no-builder"] : []),
    ...opts.cliArgs,
    "--job-id", id,
  ];
}

const shQuote = (a: string): string => `'${a.replace(/'/g, "'\\''")}'`;

/**
 * Start a job in a tmux background session.
 * Returns the job entry.
 */
export function startJob(opts: StartJobOpts): JobEntry {
  // A background job trades unattended: refuse to start one on QFEX while its reduce-only
  // (closing) orders are gated — it could open a position it cannot close — or while automation
  // is unverified there (no stop orders: no protective exit). Dry runs send nothing.
  if (!opts.dryRun) {
    for (const v of new Set([opts.venue, opts.exchange])) {
      if (v === undefined || v.toLowerCase() !== "qfex") continue;
      const what = `Background job "${opts.strategy}"`;
      const reduceOnly = qfexReduceOnlyGate(QFEX_REDUCE_ONLY_WIRE);
      if (reduceOnly !== null) throw startRefusal(what, "it could open a position it cannot close", reduceOnly);
      const automation = qfexAutomationGate(QFEX_AUTOMATION_VERIFIED);
      if (automation !== null) throw startRefusal(what, "it would trade unattended", automation);
    }
  }
  if (!hasTmux()) {
    throw new Error("tmux is required for background jobs. Install with: brew install tmux");
  }

  ensureDirs();
  const id = genId();
  const session = `perp-${id}`;
  const log = logFile(id);

  // Re-invoke ourselves with the real command (jobArgv) — no key material on argv or env.
  launchTmuxChild(session, jobArgv(opts, id), log, true);

  const job: JobEntry = {
    id,
    strategy: opts.strategy,
    exchange: opts.exchange,
    params: opts.params,
    tmuxSession: session,
    startedAt: new Date().toISOString(),
    status: "running",
  };

  saveJob(job);
  return job;
}

/**
 * Stop a running job.
 */
export function stopJob(id: string): boolean {
  const job = loadJob(id);
  if (!job) return false;

  if (tmuxSessionExists(job.tmuxSession)) {
    try {
      killTmuxSession(job.tmuxSession);
    } catch { /* exited between has-session and kill-session */ }
  }

  job.status = "stopped";
  saveJob(job);
  return true;
}

/**
 * Update job state file (called from within the running job).
 */
export function updateJobState(id: string, data: Partial<JobEntry>): void {
  const job = loadJob(id);
  if (!job) return;
  Object.assign(job, data);
  saveJob(job);
}

/**
 * Remove a job entry.
 */
export function removeJob(id: string): boolean {
  const path = jobFile(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  // Also remove log
  const log = logFile(id);
  if (existsSync(log)) unlinkSync(log);
  return true;
}

/**
 * Secret env vars the parent holds that the child could NOT re-read itself (i.e. not
 * from ~/.perp/.env). Handing them over would put key material on the child's env;
 * dropping them would make the child sign with a different account — so refuse.
 */
function shellOnlySecrets(env: NodeJS.ProcessEnv): string[] {
  const envFile = join(process.env.HOME || homedir(), ".perp", ".env");
  const fromFile = existsSync(envFile) ? parseDotenv(readFileSync(envFile, "utf-8")) : {};
  return secretEnvNamesIn(env).filter((k) => {
    const v = env[k];
    return v !== undefined && v !== "" && fromFile[k] !== v;
  });
}

/**
 * The tmux shell command for a child: `env -u <secret>... node cli <argv>`.
 * `env -u` removes secrets the tmux server's global environment may carry (a server started
 * earlier from another shell). Only variable NAMES of secrets ever appear on the command line.
 */
export function childShellCommand(nodeCmd: string, cliPath: string, argv: string[], log: string | null, env: NodeJS.ProcessEnv): string {
  const unset = secretEnvNamesIn(env).flatMap((k) => ["-u", k]);
  // No config env passthrough: builder fees come from settings.json (read by the child) only.
  const parts = ["env", ...unset, nodeCmd, cliPath, ...argv].map(shQuote).join(" ");
  return log === null ? parts : `${parts} 2>&1 | tee -a ${shQuote(log)}`;
}

/**
 * Launch `node <cli> <argv>` in a detached tmux session. The child never receives key
 * material: every secret var is stripped from the tmux client's env (a fresh tmux server
 * inherits it) and from the session command (`env -u`). `needsCredentials`: the child
 * signs, so a shell-only secret env var (one the child cannot re-read from ~/.perp/.env)
 * is refused with INVALID_PARAMS instead of silently switching the child's account.
 */
export function launchTmuxChild(session: string, argv: string[], log: string | null, needsCredentials: boolean): void {
  const shellOnly = needsCredentials ? shellOnlySecrets(process.env) : [];
  if (shellOnly.length > 0) {
    throw new PerpError("INVALID_PARAMS", `--background cannot hand ${shellOnly.join(", ")} (set in the shell environment) to the background job`, {
      remediation: `Unset ${shellOnly.join(", ")}. ${SECRET_HANDOFF_REMEDIATION}`,
    });
  }
  assertTmuxSessionName(session);
  // The log is created owner-only BEFORE tee appends to it (tee would create it 0644).
  if (log !== null) writePrivate(log, "", "a");
  const cmd = childShellCommand(process.argv[0], process.argv[1], argv, log, process.env);
  execFileSync("tmux", ["new-session", "-d", "-s", session, cmd], { env: scrubSecretEnv(process.env) });
}
