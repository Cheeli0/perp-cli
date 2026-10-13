import type { ExchangeAdapter } from "../exchanges/index.js";
import { PerpError } from "../errors.js";
import { quarantineSymbol } from "../bot/quarantine.js";

/**
 * An order of a DCA / TWAP run whose outcome or fill size is unknown: it is NEVER resubmitted.
 * The symbol is quarantined (every automated path skips it until a human clears it) and the
 * returned ORDER_PENDING error ends the run.
 */
export function pendingStop(source: "dca" | "twap", adapter: ExchangeAdapter, symbol: string, reason: string, log: (msg: string) => void): PerpError {
  const remediation = `Check ${symbol} on ${adapter.name} (perp -e ${adapter.name} account positions; perp -e ${adapter.name} account orders) — do NOT resubmit; fix by hand, then: perp strategy quarantine-clear ${symbol}`;
  quarantineSymbol(source, symbol, `${reason} — not resubmitted`, remediation, log);
  return new PerpError("ORDER_PENDING", `${reason} — run stopped, ${symbol} quarantined`, { exchange: adapter.name, remediation });
}
