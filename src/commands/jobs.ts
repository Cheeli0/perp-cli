import { Command } from "commander";
import { listJobs, stopJob, removeJob, loadJob, logFile, startJob, assertTmuxSessionName, JOB_STOP_TIMEOUT_MS, type JobEntry } from "../jobs.js";
import { printJson, jsonOk, symbolMatch } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { PerpError } from "../errors.js";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { scrubSecretEnv } from "../secret-env.js";

/**
 * What a stopped job left on its venue(s): open orders and positions on its symbol (every symbol
 * when the job has none). One entry per venue; a failed read is reported, never "nothing left".
 */
async function leftoversOf(job: JobEntry, getAdapterFor: (venue: string) => Promise<ExchangeAdapter>): Promise<Array<{ venue: string; orders: unknown[]; positions: unknown[]; error: string | null }>> {
  const sym = typeof job.params.symbol === "string" && job.params.symbol !== "ALL" ? job.params.symbol.toUpperCase() : null;
  const venues = job.exchange === "multi" ? [] : job.exchange.split(/[+,]/).map(v => v.trim()).filter(Boolean);
  const out: Array<{ venue: string; orders: unknown[]; positions: unknown[]; error: string | null }> = [];
  for (const venue of venues) {
    try {
      const a = await getAdapterFor(venue);
      const [orders, positions] = await Promise.all([a.getOpenOrders(), a.getPositions()]);
      const mine = <T extends { symbol: string }>(xs: T[]) => sym === null ? xs : xs.filter(x => symbolMatch(x.symbol, sym));
      out.push({ venue, orders: mine(orders), positions: mine(positions).filter(p => Number(p.size) !== 0), error: null });
    } catch (e) {
      out.push({ venue, orders: [], positions: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export function registerBackgroundCommands(
  program: Command,
  isJson: () => boolean,
  getAdapterFor?: (venue: string) => Promise<ExchangeAdapter>,
) {
  const jobs = program.command("background").description("Background process supervisor (tmux sessions for strategies, alerts, etc.)");

  jobs
    .command("list", { isDefault: true })
    .description("List all jobs")
    .action(() => {
      const all = listJobs();
      if (isJson()) return printJson(jsonOk(all));

      if (all.length === 0) {
        console.log(chalk.gray("\n  No jobs.\n"));
        return;
      }

      console.log(chalk.cyan.bold("\n  Background Jobs\n"));
      for (const j of all) {
        const statusColor = j.status === "running" ? chalk.green : j.status === "error" ? chalk.red : chalk.gray;
        const elapsed = j.status === "running"
          ? ` (${formatElapsed(Date.now() - new Date(j.startedAt).getTime())})`
          : "";

        console.log(
          `  ${chalk.white.bold(j.id)}  ${statusColor(j.status.padEnd(8))} ` +
          `${chalk.cyan(j.strategy.padEnd(14))} ` +
          `${chalk.gray(j.exchange.padEnd(12))} ` +
          `${chalk.gray(new Date(j.startedAt).toLocaleString())}${elapsed}`
        );

        // Show result summary if available
        if (j.result) {
          const r = j.result;
          if (r.pctComplete !== undefined) {
            console.log(chalk.gray(`         Progress: ${r.pctComplete}% | Filled: ${r.filled}/${(Number(r.filled) + Number(r.remaining)).toFixed(4)}`));
          } else if (r.activePositions !== undefined) {
            console.log(chalk.gray(`         Positions: ${r.activePositions} | Cycle: ${r.cycle}`));
          }
        }
      }
      console.log();
    });

  jobs
    .command("stop <id>")
    .description("Stop a running job gracefully: SIGINT (the job cancels its orders / saves state), wait up to --timeout, only then kill; reports what is left on the venue")
    .option("--timeout <sec>", "Seconds to wait for the job's own cleanup before killing it", String(JOB_STOP_TIMEOUT_MS / 1000))
    .action(async (id: string, opts: { timeout: string }) => {
      const job = loadJob(id);
      if (!job) {
        console.log(chalk.red(`\n  Job ${id} not found.\n`));
        return;
      }
      const timeoutSec = Number(opts.timeout);
      if (!(timeoutSec > 0)) throw new PerpError("INVALID_PARAMS", `--timeout must be a positive number of seconds (got ${opts.timeout})`);
      if (!isJson()) console.log(chalk.gray(`\n  Stopping job ${id} (SIGINT, waiting up to ${timeoutSec}s for its cleanup)...`));
      const r = await stopJob(id, timeoutSec * 1000);
      if (r === null) return;
      const log = logFile(id);
      const tail = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(l => l.trim() !== "").slice(-12) : [];
      const left = getAdapterFor !== undefined ? await leftoversOf(job, getAdapterFor) : [];
      const leftCount = left.reduce((n, v) => n + v.orders.length + v.positions.length, 0);
      if (isJson()) return printJson(jsonOk({ id, status: "stopped", stop: r, leftovers: left, logTail: tail }));
      if (r.outcome === "forced") console.log(chalk.red.bold(`  Job ${id} was FORCE-KILLED: ${r.note}. Its own cleanup (cancel orders / save state) did NOT run.`));
      else if (r.outcome === "graceful") console.log(chalk.green(`  Job ${id} exited after SIGINT (${(r.waitedMs / 1000).toFixed(1)}s).`));
      else console.log(chalk.gray(`  Job ${id} was not running.`));
      if (tail.length > 0) {
        console.log(chalk.gray("  Last log lines:"));
        for (const l of tail) console.log(chalk.gray(`    ${l}`));
      }
      for (const v of left) {
        if (v.error !== null) { console.log(chalk.yellow(`  ${v.venue}: could not read what is left (${v.error}) — check: perp -e ${v.venue} account orders / account positions`)); continue; }
        for (const o of v.orders as Array<{ symbol: string; side: string; size: string; price: string; orderId: string }>) console.log(chalk.yellow(`  LEFT OPEN on ${v.venue}: order ${o.side} ${o.size} ${o.symbol} @ ${o.price} (${o.orderId}) — cancel: perp -e ${v.venue} trade cancel ${o.symbol} ${o.orderId}`));
        for (const p of v.positions as Array<{ symbol: string; side: string; size: string }>) console.log(chalk.yellow(`  LEFT OPEN on ${v.venue}: position ${p.side} ${p.size.replace(/^-/, "")} ${p.symbol} — close: perp -e ${v.venue} trade close ${p.symbol}`));
      }
      if (left.length > 0 && leftCount === 0 && left.every(v => v.error === null)) console.log(chalk.green(`  Nothing left open on ${left.map(v => v.venue).join(", ")}${typeof job.params.symbol === "string" ? ` for ${job.params.symbol}` : ""}.`));
      if (job.exchange === "multi") console.log(chalk.gray("  Multi-venue job: check every venue: perp arb status"));
      console.log();
    });

  jobs
    .command("logs <id>")
    .description("Show logs for a job")
    .option("-f, --follow", "Follow log output (tail -f)")
    .option("--lines <n>", "Number of lines to show", "50")
    .action((id: string, opts: { follow?: boolean; lines: string }) => {
      const log = logFile(id);
      if (!existsSync(log)) {
        console.log(chalk.gray(`\n  No logs for job ${id}.\n`));
        return;
      }

      if (opts.follow) {
        // Attach to tmux session if running, otherwise tail -f
        const job = loadJob(id);
        if (job?.status === "running") {
          try {
            execFileSync("tmux", ["attach-session", "-t", assertTmuxSessionName(job.tmuxSession)], { stdio: "inherit", env: scrubSecretEnv(process.env) });
            return;
          } catch { /* fall through to tail */ }
        }
        try {
          execFileSync("tail", ["-f", log], { stdio: "inherit", env: scrubSecretEnv(process.env) });
        } catch { /* ctrl-c */ }
      } else {
        const content = readFileSync(log, "utf-8");
        const lines = content.split("\n");
        const n = parseInt(opts.lines);
        const show = lines.slice(-n).join("\n");
        console.log(show);
      }
    });

  jobs
    .command("remove <id>")
    .description("Remove a job entry and its logs (a running job is stopped gracefully first)")
    .action(async (id: string) => {
      const job = loadJob(id);
      if (!job) {
        console.log(chalk.red(`\n  Job ${id} not found.\n`));
        return;
      }
      if (job.status === "running") {
        const r = await stopJob(id);
        if (r?.outcome === "forced" && !isJson()) console.log(chalk.red(`  Job ${id} was force-killed (${r.note}); its cleanup did not run — check its venue for open orders / positions.`));
      }
      removeJob(id);
      if (isJson()) return printJson(jsonOk({ id, removed: true }));
      console.log(chalk.green(`\n  Job ${id} removed.\n`));
    });

  jobs
    .command("clean")
    .description("Remove all stopped/done jobs")
    .action(() => {
      const all = listJobs();
      let removed = 0;
      for (const j of all) {
        if (j.status !== "running") {
          removeJob(j.id);
          removed++;
        }
      }
      if (isJson()) return printJson(jsonOk({ removed }));
      console.log(chalk.green(`\n  Removed ${removed} finished jobs.\n`));
    });
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
