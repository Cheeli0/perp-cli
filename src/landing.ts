import chalk from "chalk";
import { listAgents } from "./agent-wallet/store.js";
import { getVenue, listVenues } from "./exchanges/venue.js";
import "./exchanges/venues/index.js";

/** Every registered venue, in registry order (SSOT: the venue registry). */
export const LANDING_EXCHANGES: readonly string[] = listVenues().map(v => v.id);

export type LandingExchangeStatus = {
  exchange: string;
  /** Venue has no account API — rendered as market data only. */
  marketDataOnly?: boolean;
  /** Venue is read through an undocumented API (VenueDefinition.apiStatus) — labelled "unofficial API". */
  unofficialApi?: boolean;
  ok: boolean;
  equity: number;
  positions: number;
  errorCode?: string;
};

const ASTER_AGENT_REQUIRED_CODES = new Set([
  "NOT_IMPLEMENTED",
  "NO_SIGNER_AVAILABLE",
  "AGENT_EXPIRED",
]);

/** Single-token label (display name without spaces: "Lighter RH" → "LighterRH") so columns stay one word per venue. */
function exchangeLabel(exchange: string): string {
  return getVenue(exchange).displayName.replace(/\s+/g, "");
}

export function asterAgentMissing(): boolean {
  return listAgents("aster").length === 0;
}

export function renderLandingExchangeLine(
  status: LandingExchangeStatus,
  asterAgentMissing: boolean,
): string {
  if (
    !status.ok &&
    status.exchange === "aster" &&
    asterAgentMissing &&
    status.errorCode !== undefined &&
    ASTER_AGENT_REQUIRED_CODES.has(status.errorCode)
  ) {
    return `    ${chalk.yellow("⚙")} ${chalk.cyan(exchangeLabel(status.exchange).padEnd(14))} ${chalk.yellow("agent required")} ${chalk.gray("→ perp wallet agent approve aster")}`;
  }

  if (status.marketDataOnly) {
    return `    ${chalk.gray("◇")} ${chalk.cyan(exchangeLabel(status.exchange).padEnd(14))} ${chalk.gray("market data only")}${status.unofficialApi ? chalk.yellow(" (unofficial API)") : ""}`;
  }

  const icon = status.ok ? chalk.green("●") : chalk.red("○");
  const equity = status.ok
    ? chalk.white(`$${Number(status.equity).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    : chalk.gray("—");
  const positions = status.ok && status.positions > 0 ? chalk.yellow(` ${status.positions} pos`) : "";

  return `    ${icon} ${chalk.cyan(exchangeLabel(status.exchange).padEnd(14))} ${equity}${positions}`;
}
