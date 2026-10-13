/**
 * MCP review fixes (no network: adapter creation, TradingV2 send and the risk gate are mocked):
 *  - trade_execute parses `size` once (parsePositiveDecimal) — "1,000" / "abc" refused before any read or send;
 *  - trade_preview matches the existing position with symbolMatch (no substring: "BTC" ≠ "WBTC");
 *  - the server loads only ~/.perp/.env like the CLI (SSOT Rule #3), never a CWD .env.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource() { /* not exercised */ }
    prompt() { /* not exercised */ }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));

const pos = (symbol: string, size: string) => ({
  symbol, side: "long", size, entryPrice: "100", markPrice: "100", liquidationPrice: null, unrealizedPnl: "0", leverage: 1,
});
const fakeAdapter = {
  name: "hyperliquid",
  getPositions: vi.fn(async () => [] as unknown[]),
  getBalance: vi.fn(async () => ({ equity: "1000", available: "1000", marginUsed: "0", unrealizedPnl: "0" })),
  getOrderbook: vi.fn(async () => ({ bids: [["99", "1"]], asks: [["101", "1"]] })),
  getMarkets: vi.fn(async () => []),
};
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  hasCredentials: async () => true,
  resolveCredentials: async () => ({}),
}));
vi.mock("../exchanges/venues/create-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exchanges/venues/create-helpers.js")>()),
  createHyperliquid: async () => fakeAdapter,
}));
vi.mock("../exchanges/legacy-trading-v2.js", () => ({ tradingV2Of: () => ({}) }));
const placeAndConfirm = vi.fn();
vi.mock("../exchanges/trading-v2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exchanges/trading-v2.js")>()),
  placeAndConfirm: (...a: unknown[]) => placeAndConfirm(...a),
}));
const enforceOrderRisk = vi.fn();
vi.mock("../trade-validator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trade-validator.js")>()),
  enforceOrderRisk: (...a: unknown[]) => enforceOrderRisk(...a),
  validateTrade: vi.fn(async () => ({ valid: true, checks: [], warnings: [] })),
}));

async function loadServer(): Promise<void> {
  tools.clear();
  vi.resetModules();
  delete process.env["PERP_NETWORK"];
  await import("../mcp-server.js");
}

function parse(r: { content: { text: string }[] }): { ok: boolean; code?: string; data?: Record<string, unknown> } {
  return JSON.parse(r.content[0].text);
}

const BUY = { exchange: "hyperliquid", symbol: "BTC", side: "buy", orderType: "market", reduceOnly: false };

beforeEach(() => {
  placeAndConfirm.mockReset();
  enforceOrderRisk.mockReset().mockResolvedValue(undefined);
  fakeAdapter.getPositions.mockReset().mockResolvedValue([]);
});

describe("trade_execute: size parsed once, up front", () => {
  it.each([["1,000"], ["abc"], ["0"], ["1e3"]])("size %s → INVALID_PARAMS; no risk read, nothing sent", async (size) => {
    await loadServer();
    const r = await tools.get("trade_execute")!({ ...BUY, size });
    expect(r.isError).toBe(true);
    expect(parse(r).code ?? JSON.stringify(parse(r))).toMatch(/INVALID_PARAMS/);
    expect(enforceOrderRisk).not.toHaveBeenCalled();
    expect(placeAndConfirm).not.toHaveBeenCalled();
  });

  it("a valid size reaches the risk gate as the parsed number", async () => {
    await loadServer();
    placeAndConfirm.mockResolvedValue({ status: "filled", finality: "final", orderId: "1", clientOrderId: null, filledSize: "0.5", avgPrice: "100", venueRaw: {}, execution: null });
    await tools.get("trade_execute")!({ ...BUY, size: " 0.5 " });
    expect(enforceOrderRisk.mock.calls[0][1]).toMatchObject({ symbol: "BTC", size: 0.5 });
  });
});

describe("trade_preview: exact symbol match for the existing position", () => {
  it("BTC does not pick up a WBTC position (substring), only BTC itself", async () => {
    await loadServer();
    fakeAdapter.getPositions.mockResolvedValue([pos("WBTC", "7"), pos("BTC", "3")]);
    const r = await tools.get("trade_preview")!({ ...BUY, size: "0.01" });
    expect(parse(r).ok).toBe(true);
    expect(parse(r).data!.existingPosition).toMatchObject({ size: "3" });
  });

  it("only a WBTC position → no existing BTC position", async () => {
    await loadServer();
    fakeAdapter.getPositions.mockResolvedValue([pos("WBTC", "7")]);
    const r = await tools.get("trade_preview")!({ ...BUY, size: "0.01" });
    expect(parse(r).data!.existingPosition).toBeNull();
  });
});

describe("env loading (SSOT Rule #3)", () => {
  it("does not import dotenv/config (which reads ./.env from the CWD)", () => {
    const src = readFileSync(resolve(__dirname, "..", "mcp-server.ts"), "utf-8");
    expect(src).not.toMatch(/import\s+["']dotenv\/config["']/);
  });

  it("loads ~/.perp/.env and ignores a .env in the CWD", async () => {
    const perpDir = resolve(process.env.HOME!, ".perp");
    mkdirSync(perpDir, { recursive: true });
    writeFileSync(join(perpDir, ".env"), "PERP_MCP_TEST_HOME_VAR=home\n");
    const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
    writeFileSync(join(cwd, ".env"), "PERP_MCP_TEST_CWD_VAR=cwd\n");
    const prev = process.cwd();
    delete process.env["PERP_MCP_TEST_HOME_VAR"];
    delete process.env["PERP_MCP_TEST_CWD_VAR"];
    try {
      process.chdir(cwd);
      await loadServer();
      expect(process.env["PERP_MCP_TEST_HOME_VAR"]).toBe("home");
      expect(process.env["PERP_MCP_TEST_CWD_VAR"]).toBeUndefined();
    } finally {
      process.chdir(prev);
      delete process.env["PERP_MCP_TEST_HOME_VAR"];
    }
  });
});
