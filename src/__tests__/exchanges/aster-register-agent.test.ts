/**
 * Aster testnet agent approval (POST /fapi/v3/registerAndApproveAgent) typed data,
 * and the persisted monotonic per-signer request nonce.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import os from "os";
import { TypedDataEncoder } from "ethers";

const TEST_HOME = resolve(os.tmpdir(), `perp-aster-nonce-test-${process.pid}`);
vi.stubEnv("HOME", TEST_HOME);

const { buildRegisterAndApproveAgentTypedData } = await import("../../exchanges/aster-typed-data.js");
const { nextAsterNonce } = await import("../../exchanges/aster-nonce.js");

afterAll(() => { if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true }); });

const BASE = {
  user: "0x1111111111111111111111111111111111111111" as const,
  nonceMicros: "1747000000000000",
  agentName: "perp-cli-aster-tn",
  agentAddress: "0x2222222222222222222222222222222222222222" as const,
  expiredMs: 1750000000000,
  signatureChainId: 56,
  canSpotTrade: false,
  canPerpTrade: true,
  canWithdraw: false,
  ipWhitelist: "",
};

describe("buildRegisterAndApproveAgentTypedData", () => {
  it("signs the documented literal param string as Message{msg} under chainId = signatureChainId", () => {
    const td = buildRegisterAndApproveAgentTypedData(BASE);
    expect(td.message.msg).toBe(
      "user=0x1111111111111111111111111111111111111111&nonce=1747000000000000&agentName=perp-cli-aster-tn" +
      "&agentAddress=0x2222222222222222222222222222222222222222&expired=1750000000000&signatureChainId=56" +
      "&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=",
    );
    expect(td.domain).toEqual({ name: "AsterSignTransaction", version: "1", chainId: 56, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(td.primaryType).toBe("Message");
    expect(td.params.map(([k]) => k)).toEqual(["user", "nonce", "agentName", "agentAddress", "expired", "signatureChainId", "canSpotTrade", "canPerpTrade", "canWithdraw", "ipWhitelist"]);
    // Hashable as EIP-712 (no AsterChain, no PascalCase struct fields).
    expect(TypedDataEncoder.hash(td.domain, { Message: [...td.types.Message] }, td.message)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps the space-delimited ipWhitelist raw in msg", () => {
    const td = buildRegisterAndApproveAgentTypedData({ ...BASE, canWithdraw: true, ipWhitelist: "1.2.3.4 10.0.0.0/24" });
    expect(td.message.msg.endsWith("&canWithdraw=true&ipWhitelist=1.2.3.4 10.0.0.0/24")).toBe(true);
  });

  it("requires ipWhitelist when canWithdraw", () => {
    expect(() => buildRegisterAndApproveAgentTypedData({ ...BASE, canWithdraw: true })).toThrow(/IP whitelist/);
  });

  it("rejects '&' / '=' inside values (the signed msg would be ambiguous)", () => {
    expect(() => buildRegisterAndApproveAgentTypedData({ ...BASE, agentName: "a&b" })).toThrow(/must not contain/);
  });
});

describe("nextAsterNonce", () => {
  it("is strictly increasing per signer within the same microsecond and across a clock step back", () => {
    const a = BigInt(nextAsterNonce("0xAbC", 1_000));
    const b = BigInt(nextAsterNonce("0xabc", 1_000));
    const c = BigInt(nextAsterNonce("0xABC", 500));
    expect(a).toBe(1_000_000n);
    expect(b).toBe(a + 1n);
    expect(c).toBe(b + 1n);
    // Another signer has its own sequence.
    expect(nextAsterNonce("0xdef", 1_000)).toBe("1000000");
    // Wall clock ahead of the persisted value wins.
    expect(nextAsterNonce("0xabc", 2_000)).toBe("2000000");
  });

  it("throws on a corrupt state file instead of resetting", () => {
    mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
    writeFileSync(resolve(TEST_HOME, ".perp", "aster-nonces.json"), "{not json");
    expect(() => nextAsterNonce("0xabc", 1)).toThrow(/corrupt/);
    rmSync(resolve(TEST_HOME, ".perp", "aster-nonces.json"));
  });
});
