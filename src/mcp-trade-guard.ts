/**
 * MCP write-path safety (review N4): the MCP `trade_execute` / `trade_close` tools go through
 * the same gates as `perp trade`:
 *
 *  - network: PERP_NETWORK, validated by the same parser as `-n` (unset = mainnet, the
 *    documented default — never a silent substitution for an invalid value);
 *  - quarantine: a non-reduce-only order on a quarantined symbol is refused (an earlier
 *    unknown outcome must be resolved by a human first);
 *  - local risk limits: enforceOrderRisk with force=false — there is NO force override over
 *    MCP (an agent must not be able to bypass the user's limits);
 *  - execution log: every placed / failed order is appended to ~/.perp/executions.jsonl,
 *    tagged source "mcp" and the network;
 *  - venue gates: a reduce-only order (trade_execute reduceOnly, trade_close) on a venue whose
 *    reduce-only orders are currently refused (none today) fails with the uniform
 *    CAPABILITY_UNSUPPORTED before any read or send (mcpReduceOnlyGate).
 */
import { parseNetwork } from "./cli-flags.js";
import { PerpError } from "./errors.js";
import { logExecution, type ExecutionRecord } from "./execution-log.js";
import { quarantineEntryFor } from "./bot/quarantine.js";
import { enforceOrderRisk } from "./trade-validator.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import type { Network } from "./exchanges/venue-types.js";
import { reduceOnlyGateOf } from "./exchanges/trading-v2.js";

/** Refuse a reduce-only order up front on a venue whose reduce-only orders are gated (uniform CAPABILITY_UNSUPPORTED). */
export function mcpReduceOnlyGate(adapter: ExchangeAdapter): void {
  const gate = reduceOnlyGateOf(adapter);
  if (gate !== null) throw gate;
}

/** PERP_NETWORK → network. Unset = "mainnet" (documented default); any other value must parse. */
export function resolveMcpNetwork(env: string | undefined): Network {
  if (env === undefined) return "mainnet";
  return parseNetwork(env);
}

/** Pre-send gate for an MCP order: quarantine (non-reduce-only), then local risk limits (never forced). */
export async function mcpPreTradeGate(
  adapter: ExchangeAdapter,
  p: { symbol: string; size: number; price: number | null; reduceOnly: boolean },
  log: (msg: string) => void,
): Promise<void> {
  if (p.reduceOnly) mcpReduceOnlyGate(adapter);
  if (!p.reduceOnly) {
    const q = quarantineEntryFor(p.symbol, log);
    if (q !== null) {
      throw new PerpError("RISK_VIOLATION", `${p.symbol} is quarantined by ${q.strategy}: ${q.reason}`, {
        exchange: adapter.name,
        remediation: `${q.remediation} — only reduce-only orders are accepted until a human clears it (perp strategy quarantine-clear ${p.symbol})`,
      });
    }
  }
  await enforceOrderRisk(adapter, {
    symbol: p.symbol,
    size: p.size,
    ...(p.price !== null ? { price: p.price } : {}),
    reduceOnly: p.reduceOnly,
    force: false,
  });
}

/** Execution-log entry for an MCP order (source + network recorded in meta). */
export function logMcpExecution(
  network: Network,
  record: Omit<ExecutionRecord, "id" | "timestamp" | "dryRun">,
): ExecutionRecord {
  return logExecution({ ...record, dryRun: false, meta: { ...(record.meta ?? {}), source: "mcp", network } });
}
