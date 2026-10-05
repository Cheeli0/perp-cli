/**
 * An error envelope must always exit non-zero. Live testnet run 2026-10-02 (lighter-rh, t-mid):
 * `perp --json -n testnet -e lighter-rh market mid TSLA` printed
 * {"ok":false,"error":{"code":"SYMBOL_NOT_FOUND","message":"No orderbook data for TSLA"}} and
 * exited 0. The RH testnet TSLA book was genuinely empty (GET /api/v1/orderBookOrders?market_id=112
 * → {"code":200,"total_asks":0,"asks":[],"total_bids":0,"bids":[]}), so the honest answer is
 * PRICE_STALE ("no mid price"), not "unknown symbol" — and exit 1.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerMarketCommands } from "../../commands/market.js";
import { jsonError, jsonOk, printJson } from "../../utils.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

afterEach(() => { process.exitCode = undefined; });

async function runMid(book: { bids: [string, string][]; asks: [string, string][] } | Error, json: boolean) {
  const adapter = {
    name: "lighter-rh",
    getOrderbook: vi.fn(async () => { if (book instanceof Error) throw book; return book; }),
  } as unknown as ExchangeAdapter;
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMarketCommands(program, async () => adapter, () => json);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["node", "perp", "market", "mid", "TSLA"]);
    return { out: log.mock.calls.map(c => String(c[0])), exitCode: process.exitCode };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("error envelope ⇒ exit code 1", () => {
  it("printJson sets exitCode 1 for any ok:false envelope, leaves it alone for ok:true", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printJson(jsonOk({ a: 1 }));
      expect(process.exitCode).toBeUndefined();
      printJson(jsonError("SYMBOL_NOT_FOUND", "x"));
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      printJson({ ok: false, error: { code: "INSUFFICIENT_BALANCE", message: "gas" } });
      expect(process.exitCode).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("market mid on an empty book (RH testnet TSLA) → PRICE_STALE envelope, exit 1", async () => {
    const r = await runMid({ bids: [], asks: [] }, true);
    const env = JSON.parse(r.out.join("\n"));
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("PRICE_STALE");
    expect(env.error.message).toMatch(/TSLA orderbook on lighter-rh is empty/);
    expect(r.exitCode).toBe(1);
  });

  it("market mid human mode: an empty book also exits 1", async () => {
    const r = await runMid({ bids: [], asks: [] }, false);
    expect(r.exitCode).toBe(1);
  });

  it("market mid: an orderbook read failure surfaces (exit 1), never an empty book", async () => {
    const r = await runMid(new Error("GET /orderBookOrders failed (500): boom"), true);
    const env = JSON.parse(r.out.join("\n"));
    expect(env.ok).toBe(false);
    expect(env.error.message).toMatch(/500/);
    expect(r.exitCode).toBe(1);
  });

  it("market mid two-sided book → ok, exit 0", async () => {
    const r = await runMid({ bids: [["355.10", "1"]], asks: [["355.30", "2"]] }, true);
    const env = JSON.parse(r.out.join("\n"));
    expect(env.ok).toBe(true);
    expect(env.data.bid).toBe("355.10");
    expect(env.data.ask).toBe("355.30");
    expect(r.exitCode).toBeUndefined();
  });

  it("walks src/commands: an error envelope written straight to stdout/stderr is followed by an exit", () => {
    // printJson() covers printJson(jsonError(...)); a raw console.log/error(JSON.stringify(jsonError(...)))
    // bypasses it and must exit (process.exit / exitCode) within the next lines.
    const dir = join(__dirname, "..", "..", "commands");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter(n => n.endsWith(".ts"))) {
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/console\.(log|error)\(JSON\.stringify\(jsonError\(/.test(line)) return;
        const next = lines.slice(i, i + 6).join("\n");
        if (!/process\.exit\(1\)|process\.exitCode = 1/.test(next)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
