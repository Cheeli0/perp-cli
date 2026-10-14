/**
 * The /node entry with the optional peer `ws` not installed: importing it still works; creating a
 * stream or a transport throws INVALID_PARAMS with the install remediation (never a reconnect loop).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:module", () => ({
  createRequire: () => (id: string) => {
    throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
  },
}));

describe("perp-cli/ws/node without `ws`", () => {
  it("imports; createVenueStream / createNodeTransport throw INVALID_PARAMS with `npm install ws`", async () => {
    const m = await import("../../ws/node.js");
    expect(typeof m.nodeTransport).toBe("function");
    for (const fn of [() => m.createVenueStream(m.hyperliquid), () => m.createNodeTransport(), () => m.nodeTransport("ws://127.0.0.1:1")]) {
      let err: unknown = null;
      try { fn(); } catch (e) { err = e; }
      expect(err).toMatchObject({
        structured: { code: "INVALID_PARAMS", remediation: expect.stringContaining("npm install ws@^8.21.0") },
      });
    }
    // An explicit transport needs no `ws`.
    expect(() => m.createVenueStream(m.hyperliquid, { transport: () => { throw new Error("unused"); }, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) })).not.toThrow();
  });
});
