/**
 * Bridge / mainnet-only deposit routes follow -n: a testnet run throws
 * NO_BRIDGE_ROUTE before any key is loaded, quote fetched or payload signed;
 * the HyperCore → EVM withdrawal takes hyperliquidChain + /exchange host from
 * the Hyperliquid venue definition (HL_USER_SIGNED).
 *
 * Nothing is sent anywhere: fetch is mocked. The signer is a throwaway random key.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { Wallet } from "ethers";
import { PerpError } from "../errors.js";
import {
  assertBridgeNetwork, executeBestBridge, executeCctpBridge, executeRelayBridge, executeDebridgeBridge,
  type BridgeQuote,
} from "../bridge-engine.js";
import { registerFundsCommands } from "../commands/funds.js";
import type { Network } from "../exchanges/venue-types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function expectNoRoute(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PerpError);
  expect((err as PerpError).structured.code).toBe("NO_BRIDGE_ROUTE");
}

const QUOTE: BridgeQuote = {
  provider: "debridge", srcChain: "arbitrum", dstChain: "solana", amountIn: 10, amountOut: 9.9,
  fee: 0.1, estimatedTime: 2, gasIncluded: true, raw: {},
};

describe("bridge engine refuses testnet", () => {
  it("assertBridgeNetwork: mainnet passes, testnet throws NO_BRIDGE_ROUTE with remediation", () => {
    expect(() => assertBridgeNetwork("mainnet")).not.toThrow();
    try {
      assertBridgeNetwork("testnet");
      expect.unreachable();
    } catch (e) {
      expect((e as PerpError).structured.code).toBe("NO_BRIDGE_ROUTE");
      expect((e as PerpError).structured.remediation).toContain("-n testnet");
    }
  });

  it("every execute entry point throws before any fetch on testnet", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const key = Wallet.createRandom().privateKey;
    await expectNoRoute(executeBestBridge("testnet", "arbitrum", "solana", 10, key, "0x1", "x"));
    await expectNoRoute(executeCctpBridge("testnet", "hyperliquid", "arbitrum", 10, key, "0x0000000000000000000000000000000000000001"));
    await expectNoRoute(executeCctpBridge("testnet", "arbitrum", "hyperliquid", 10, key, "0x0000000000000000000000000000000000000001"));
    await expectNoRoute(executeRelayBridge("testnet", QUOTE, key));
    await expectNoRoute(executeDebridgeBridge("testnet", QUOTE, key));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mainnet HyperCore → EVM signs hyperliquidChain from HL_USER_SIGNED and posts to the venue restUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "ok", response: { type: "default" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const key = Wallet.createRandom().privateKey;
    await executeCctpBridge("mainnet", "hyperliquid", "arbitrum", 10, key, "0x0000000000000000000000000000000000000001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.hyperliquid.xyz/exchange");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.action).toMatchObject({ type: "sendToEvmWithData", hyperliquidChain: "Mainnet" });
  });
});

describe("funds commands refuse mainnet-only routes on -n testnet", () => {
  function program(network: Network): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.option("-n, --network <network>", "Network", "mainnet");
    const noAdapter = async () => { throw new Error("adapter must not be built"); };
    registerFundsCommands(prog, noAdapter, () => true, () => network, noAdapter);
    return prog;
  }

  it.each([
    [["funds", "bridge", "send", "--from", "arbitrum", "--to", "solana", "--amount", "10"]],
    [["funds", "bridge", "exchange", "--from", "hyperliquid", "--to", "pacifica", "--amount", "10"]],
    [["funds", "rebalance", "execute", "--auto-bridge"]],
    [["funds", "deposit", "hyperliquid", "10"]],
    [["funds", "deposit", "lighter", "ethereum", "10"]],
    [["funds", "deposit", "lighter", "cctp", "arbitrum", "10"]],
  ])("%j → NO_BRIDGE_ROUTE, nothing fetched", async (args) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expectNoRoute(program("testnet").parseAsync(["node", "perp", "-n", "testnet", ...args]));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
