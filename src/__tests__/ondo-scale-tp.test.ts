/**
 * Ondo scale-tp: docs.ondoperps.xyz take-profit-and-stop-loss — position TP/SL "Via Risk
 * Management Module ... applies to the full position, with a limit of one TP and one SL per
 * market"; partial legs exist only "At Order Placement". Several position-level take-profits
 * cannot coexist, so scale-tp is refused up front (CAPABILITY_UNSUPPORTED), nothing read or sent.
 */
import { describe, it, expect, vi } from "vitest";
import "../exchanges/venues/index.js";
import { PerpError } from "../errors.js";
import { buildProgram } from "../cli-program.js";

describe("ondo scale-tp", () => {
  it("is CAPABILITY_UNSUPPORTED before any request, naming the single partial TP alternative", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("no network in tests"); });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
    let err: unknown = null;
    try {
      await program.parseAsync(["node", "perp", "--json", "-e", "ondo", "trade", "scale-tp", "ETH", "--levels", "3000:50,3100:50"]);
    } catch (e) {
      err = e;
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured).toMatchObject({ code: "CAPABILITY_UNSUPPORTED", details: { feature: "scaleTp" } });
    expect((err as PerpError).structured.remediation).toMatch(/perp trade tpsl ETH .*--size/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
