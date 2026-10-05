import { Command } from "commander";
import { isDryRun, supportsDryRun } from "../cli-flags.js";
import { readFileSync } from "fs";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import { validatePlan, executePlan, type ExecutionPlan } from "../plan-executor.js";
import chalk from "chalk";

export function registerStrategyPlanCommands(
  parent: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const plan = parent.command("plan").description("Composite execution plans (multi-step atomic operations)");

  // ── plan validate ──
  plan
    .command("validate <file>")
    .description("Validate a JSON execution plan without executing")
    .action(async (file: string) => {
      await withJsonErrors(isJson(), async () => {
        const raw = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
        const planData = JSON.parse(raw);
        const result = validatePlan(planData);

        if (isJson()) return printJson(jsonOk(result));

        if (result.valid) {
          console.log(chalk.green(`\n  Plan is valid (${planData.steps?.length ?? 0} steps).\n`));
        } else {
          console.log(chalk.red(`\n  Plan validation failed:\n`));
          for (const err of result.errors) {
            console.log(chalk.red(`    • ${err}`));
          }
          console.log();
        }
      });
    });

  // ── plan execute ──
  supportsDryRun(plan.command("execute <file>"))
    .description("Execute a JSON plan (use - for stdin; supports --dry-run)")
    .action(async (file: string, _opts: Record<string, never>, cmd: Command) => {
      const dryRun = isDryRun(cmd);
      await withJsonErrors(isJson(), async () => {
        const raw = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
        const planData = JSON.parse(raw) as ExecutionPlan;

        // Validate first
        const validation = validatePlan(planData);
        if (!validation.valid) {
          process.exitCode = 1;
          if (isJson()) return printJson(jsonError("INVALID_PARAMS", `Plan validation failed: ${validation.errors.join("; ")}`));
          console.error(chalk.red(`\n  Plan validation failed:`));
          for (const err of validation.errors) console.error(chalk.red(`    • ${err}`));
          return;
        }

        const adapter = await getAdapter();
        const log = isJson() ? () => {} : (msg: string) => console.log(chalk.gray(`  ${msg}`));

        if (!isJson()) {
          console.log(chalk.cyan.bold(`\n  Executing plan (${planData.steps.length} steps)${dryRun ? " [DRY RUN]" : ""}...\n`));
        }

        const result = await executePlan(adapter, planData, {
          dryRun,
          log,
        });

        // Unknown / quarantined / failed outcomes must not look like success to scripts.
        const bad = result.status === "pending" || result.status === "quarantined" || result.status === "failed" || result.status === "partial";
        const badCode = result.status === "pending" ? "ORDER_PENDING"
          : result.status === "quarantined" ? "ORDER_PARTIAL"
          : result.status === "partial" ? "ORDER_PARTIAL"
          : "ORDER_REJECTED";
        const badRemediation = result.status === "pending" || result.status === "quarantined"
          ? "An order outcome is unknown or a symbol was quarantined — do NOT re-run the plan. Check positions, then: perp strategy quarantine"
          : "Check the failed step and current positions before re-running";
        if (isJson()) {
          if (bad) {
            printJson(jsonError(badCode, `Plan ended with status "${result.status}"`, { details: { result }, remediation: badRemediation }));
            process.exitCode = 1;
            return;
          }
          return printJson(jsonOk(result));
        }

        // Pretty print results
        for (const step of result.steps) {
          const icon = step.status === "success" ? chalk.green("✓")
            : step.status === "dry_run" ? chalk.blue("○")
            : step.status === "skipped" ? chalk.yellow("–")
            : chalk.red("✗");
          const duration = chalk.gray(`(${step.durationMs}ms)`);
          const err = step.error ? chalk.red(` — ${step.error.message}`) : "";
          console.log(`  ${icon} ${step.stepId} (${step.action}) ${duration}${err}`);
        }

        const statusColor = result.status === "completed" ? chalk.green
          : result.status === "dry_run" ? chalk.blue
          : result.status === "partial" ? chalk.yellow
          : chalk.red;
        console.log(`\n  Status: ${statusColor(result.status)} | ${result.totalDurationMs}ms\n`);
        if (bad) {
          console.log(chalk.red(`  ${badRemediation}\n`));
          process.exitCode = 1;
        }
      });
    });

  // ── plan example ──
  plan
    .command("example")
    .description("Print an example execution plan")
    .action(() => {
      const example: ExecutionPlan = {
        version: "1.0",
        description: "Open hedged position with stop loss",
        steps: [
          { id: "check", action: "check_balance", params: { minAvailable: 100 }, onFailure: "abort" },
          { id: "leverage", action: "set_leverage", params: { symbol: "ETH", leverage: 5 }, onFailure: "abort" },
          { id: "entry", action: "market_order", params: { symbol: "ETH", side: "buy", size: "0.5" }, onFailure: "rollback" },
          { id: "verify", action: "check_position", params: { symbol: "ETH", mustExist: true }, dependsOn: "entry", onFailure: "rollback" },
          { id: "stop", action: "stop_order", params: { symbol: "ETH", side: "sell", size: "0.5", triggerPrice: "1800", reduceOnly: true }, dependsOn: "verify", onFailure: "skip" },
        ],
      };
      printJson(jsonOk(example));
    });
}
