/**
 * Aster master-signed ops (EIP-712 Domain A, chainId 56: ApproveAgent / DelAgent /
 * ApproveBuilder) must be unreachable on testnet. Structural guard: Domain A and its builders
 * are referenced only by src/commands/agent.ts, and every function there that builds one
 * calls assertAsterDomainAMainnet(network) first (refuses testnet — testnet approve goes
 * through registerAndApproveAgent instead; behavior covered in commands/agent-network.test.ts). Aster withdraw is CAPABILITY_UNSUPPORTED.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { assertAgentApproveSupported } from "../commands/agent.js";

const SRC = resolve(__dirname, "..");
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}
const DOMAIN_A_USES = /ASTER_DOMAIN_A|buildApproveAgentTypedData|buildDelAgentTypedData|buildApproveBuilderTypedData|buildDelBuilderTypedData/;

describe("Aster Domain A (chainId 56) is never reachable on testnet", () => {
  it("only agent.ts and builder.ts use Domain A / its builders", () => {
    const users = tsFiles(SRC).filter((f) => !f.endsWith("aster-typed-data.ts") && DOMAIN_A_USES.test(readFileSync(f, "utf-8")));
    expect(users.map((f) => relative(SRC, f)).sort()).toEqual(["commands/agent.ts", "commands/builder.ts"]);
  });

  it("builder.ts signs Aster Domain A for mainnet only, and its plan refuses testnet first", async () => {
    const src = readFileSync(join(SRC, "commands", "builder.ts"), "utf-8");
    // The only Aster host / chain it signs for is mainnet.
    expect(src).toContain('networkConfig(getVenue("aster"), "mainnet")');
    expect(src).not.toMatch(/networkConfig\(getVenue\("aster"\), (?!"mainnet")/);
    expect(src).not.toContain('"Testnet"');
    // Every approve / revoke goes through builderApprovalPlan, which rejects aster on testnet.
    const { builderApprovalPlan } = await import("../commands/builder.js");
    expect(() => builderApprovalPlan("aster", "testnet", "main")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }) }));
  });

  it("every agent.ts function that builds a Domain A payload asserts testnet support first", () => {
    const src = readFileSync(join(SRC, "commands", "agent.ts"), "utf-8");
    const fns = src.split(/\n(?=(?:export )?(?:async )?function )/);
    const builders = fns.filter((f) => /build(ApproveAgent|DelAgent|ApproveBuilder)TypedData\(/.test(f));
    expect(builders.length).toBeGreaterThanOrEqual(2);
    for (const f of builders) {
      const assertAt = f.search(/assertAsterDomainAMainnet\(/);
      const buildAt = f.search(/build(ApproveAgent|DelAgent|ApproveBuilder)TypedData\(/);
      expect(assertAt, f.slice(0, 80)).toBeGreaterThanOrEqual(0);
      expect(assertAt).toBeLessThan(buildAt);
    }
  });

  it("assertAgentApproveSupported: aster testnet allows approve (registerAndApproveAgent), refuses revoke/rotate; mainnet allows all", () => {
    expect(() => assertAgentApproveSupported("aster", "testnet", "approve")).not.toThrow();
    expect(() => assertAgentApproveSupported("aster", "testnet", "revoke")).toThrow();
    expect(() => assertAgentApproveSupported("aster", "testnet", "rotate")).toThrow();
    for (const op of ["approve", "revoke", "rotate"] as const) expect(() => assertAgentApproveSupported("aster", "mainnet", op)).not.toThrow();
  });
});
