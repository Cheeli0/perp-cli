/**
 * createPacifica agent wiring (L2):
 *  - --no-agent never attaches the agent signer
 *  - an IMPORTED agent is refused when the loaded master Solana address differs from the record
 *
 * No network; OWS signer is a fake; HOME isolated (helpers/isolate-home.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { AgentMeta } from "../../settings.js";

const created: string[] = [];
vi.mock("../../signer/ows-solana.js", () => ({
  OwsSolanaSigner: {
    create: (name: string) => {
      created.push(name);
      const kp = Keypair.generate();
      return { getPublicKeyBase58: () => kp.publicKey.toBase58(), signMessage: async () => new Uint8Array(64) };
    },
  },
}));

await import("../../exchanges/venues/index.js");
const { createPacifica } = await import("../../exchanges/venues/create-helpers.js");

const MASTER = Keypair.fromSeed(Uint8Array.from(Buffer.from("55".repeat(32), "hex")));
const OTHER = Keypair.fromSeed(Uint8Array.from(Buffer.from("66".repeat(32), "hex")));

function importedAgent(master: string): AgentMeta {
  return {
    agentName: "web-pac", masterWalletName: "", owsApiKeyId: "", owsPolicyId: "", expiresAt: "", approvedAt: "2026-10-02T00:00:00.000Z",
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false }, asterApprovalNonce: "", status: "active",
    network: "mainnet", source: "imported", agentWalletName: "agent-pac-import-web-pac",
    agentEvmAddress: "0x0000000000000000000000000000000000000000", userEvmAddress: "0x0000000000000000000000000000000000000000",
    agentSolanaAddress: Keypair.generate().publicKey.toBase58(), userSolanaAddress: master,
  } as AgentMeta;
}

function ctx(pk: Keypair | null, agent: AgentMeta, noAgent: boolean) {
  return {
    network: "mainnet" as const,
    credentials: { pk: pk === null ? null : JSON.stringify(Array.from(pk.secretKey)), owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent },
    noAgent, hlDex: null, readOnly: false, noBuilder: false,
  };
}

beforeEach(() => { created.length = 0; });

describe("createPacifica agent wiring", () => {
  it("--no-agent: the agent signer is not attached (no agent OWS wallet opened)", async () => {
    const a = await createPacifica(ctx(MASTER, importedAgent(OTHER.publicKey.toBase58()), true)) as unknown as { activeSignerTier: string; publicKey: string };
    expect(created).not.toContain("agent-pac-import-web-pac");
    expect(a.activeSignerTier).toBe("pk");
    expect(a.publicKey).toBe(MASTER.publicKey.toBase58());
  });

  it("imported agent + a different loaded master → INVALID_PARAMS (never mixes two accounts)", async () => {
    const err = await createPacifica(ctx(MASTER, importedAgent(OTHER.publicKey.toBase58()), false)).catch(e => e);
    expect(err.structured.code).toBe("INVALID_PARAMS");
    expect(err.structured.message).toMatch(/imported for master/);
    expect(err.structured.remediation).toMatch(/--no-agent/);
  });

  it("imported agent + the matching master (or no master) → agent signs for the recorded account", async () => {
    const a = await createPacifica(ctx(MASTER, importedAgent(MASTER.publicKey.toBase58()), false)) as unknown as { activeSignerTier: string; publicKey: string };
    expect(a.activeSignerTier).toBe("agent");
    expect(a.publicKey).toBe(MASTER.publicKey.toBase58());
    const b = await createPacifica(ctx(null, importedAgent(OTHER.publicKey.toBase58()), false)) as unknown as { activeSignerTier: string; publicKey: string };
    expect(b.activeSignerTier).toBe("agent");
    expect(b.publicKey).toBe(OTHER.publicKey.toBase58());
  });
});
