import { describe, it, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";

// In-memory settings: alert rules only, no messaging service configured.
const store: { alerts: { rules: Array<Record<string, unknown>>; intervalSec: number; cooldownMin: number } } = {
  alerts: { rules: [], intervalSec: 300, cooldownMin: 60 },
};
vi.mock("../../settings.js", () => ({
  loadSettings: () => store,
  saveSettings: () => {},
}));

const { registerAlertCommands } = await import("../../commands/alerts.js");

/** Root program with the real root `-e, --exchange` option (default pacifica), like the CLI. */
function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.option("-e, --exchange <exchange>", "Exchange", "pacifica");
  p.option("--json", "JSON");
  registerAlertCommands(p, () => true);
  return p;
}

describe("alerts add --exchange (also the root option)", () => {
  beforeEach(() => { store.alerts.rules = []; vi.spyOn(console, "log").mockImplementation(() => {}); });

  it("stores the venue filter given as --exchange after the subcommand", async () => {
    await program().parseAsync(["node", "perp", "--json", "alerts", "add", "ETH", "50", "--exchange", "hl"]);
    expect(store.alerts.rules[0]).toMatchObject({ symbol: "ETH", exchange: "hyperliquid" });
  });

  it("without --exchange the rule covers every venue — the root default venue is not taken as a filter", async () => {
    await program().parseAsync(["node", "perp", "--json", "alerts", "add", "BTC", "10"]);
    expect(store.alerts.rules[0]).toMatchObject({ symbol: "BTC", exchange: "*" });
  });
});

describe("alerts test / start without a messaging service", () => {
  it.each([["test"], ["start"]])("%s → INVALID_PARAMS, never a silent success", async (sub) => {
    await expect(program().parseAsync(["node", "perp", "--json", "alerts", sub])).rejects.toMatchObject({
      structured: { code: "INVALID_PARAMS" },
    });
  });
});
