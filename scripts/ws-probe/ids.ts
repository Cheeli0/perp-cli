/**
 * Phase 0 WS probe: resolve the `main` wallet's PUBLIC identifiers through the CLI's own read paths.
 *
 * - EVM + Solana addresses: `perp -n mainnet --json wallet show` (stdin from /dev/null).
 * - Lighter / Lighter-RH account index: the agent metadata in ~/.perp/settings.json (getAgentForNetwork).
 * - Arcus owner: the arcus venue-agent record.
 *
 * Nothing secret is read here. These ids are used in memory by probe.ts / make-fixtures.ts and are
 * never written to a fixture (make-fixtures.ts refuses to write a file that still contains one).
 * Not part of the CLI build (tsconfig includes only src/).
 */
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";
import { getAgentForNetwork, getVenueAgentForNetwork } from "../../src/agent-wallet/store.js";

export interface RealIds {
  evm: string;
  solana: string;
  lighterAccountIndex: number | null;
  lighterRhAccountIndex: number | null;
  arcusOwner: string | null;
  arcusAccountIndex: number | null;
}

const REPO = resolve(import.meta.dirname, "../..");

export function resolveRealIds(): RealIds {
  const out = execFileSync(process.execPath, [resolve(REPO, "dist/index.js"), "-n", "mainnet", "--json", "wallet", "show"], {
    stdio: [openSync("/dev/null", "r"), "pipe", "pipe"],
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as { ok: boolean; data?: { owsActive?: { name?: string; evmAddress?: string; solanaAddress?: string } } };
  const ows = parsed.data?.owsActive;
  if (!parsed.ok || ows?.name !== "main" || !ows.evmAddress || !ows.solanaAddress) {
    throw new Error("wallet show did not return the active `main` OWS wallet with evm + solana addresses");
  }
  const lt = getAgentForNetwork("lighter", "mainnet");
  const lrh = getAgentForNetwork("lighter-rh", "mainnet");
  const arcus = getVenueAgentForNetwork("arcus", "mainnet");
  return {
    evm: ows.evmAddress,
    solana: ows.solanaAddress,
    lighterAccountIndex: typeof lt?.accountIndex === "number" ? lt.accountIndex : null,
    lighterRhAccountIndex: typeof lrh?.accountIndex === "number" ? lrh.accountIndex : null,
    arcusOwner: arcus ? (arcus as { ownerAddress?: string }).ownerAddress ?? null : null,
    arcusAccountIndex: arcus ? (arcus as { accountIndex?: number }).accountIndex ?? null : null,
  };
}
