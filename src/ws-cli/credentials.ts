/**
 * CredentialProvider for perp-cli/ws backed by the CLI's existing stores (plan ws-0.14.4 §5.1).
 * Node only (not part of perp-cli/ws). Identifiers come from the active OWS wallet and the registered
 * venue agents in ~/.perp/settings.json; the Lighter auth token is created in memory by the same path
 * the CLI uses (agent keystore → WASM signer). Never reads argv or env, never prompts: a keystore that
 * needs a passphrase → PASSPHRASE_REQUIRED (the stream reports WS_AUTH_FAILED). Keys never leave this
 * module; only the short-lived token is handed to the stream.
 */

import { PerpError } from "../errors.js";
import { loadSettings } from "../settings.js";
import { loadOws } from "../signer/ows-loader.js";
import { getAgentForNetwork, getVenueAgentForNetwork } from "../agent-wallet/store.js";

// Structural copies of the perp-cli/ws types this module returns. src/ws is built by tsup only; a
// type import from it would make the CLI `tsc` build emit src/ws files into dist/ws.
type Network = "mainnet" | "testnet";
type UserRef =
  | { venue: "hyperliquid"; address: `0x${string}` }
  | { venue: "pacifica"; account: string }
  | { venue: "lighter" | "lighter-rh"; accountIndex: number }
  | { venue: "arcus"; address: `0x${string}`; subaccount: number | null };
export interface CliCredentialProvider {
  /** Non-fatal notes about the resolved identity (e.g. Arcus all-subaccounts agent → subaccount 0). */
  readonly warnings: string[];
  user(): Promise<UserRef>;
  authToken?(req: { purpose: string; maxTtlSec: number }): Promise<{ token: string; expiresAt: number }>;
}

export type CliWsVenue = "hyperliquid" | "pacifica" | "lighter" | "lighter-rh" | "arcus";

function activeOwsAddresses(): { evm: string; solana: string } {
  const name = loadSettings().owsActiveWallet;
  if (!name) {
    throw new PerpError("NO_SIGNER_AVAILABLE", "No active OWS wallet", { remediation: "Run: perp wallet use <name>" });
  }
  const w = loadOws().getWallet(name);
  const evm = w.accounts.find(a => a.chainId.startsWith("eip155:"))?.address;
  const solana = w.accounts.find(a => a.chainId.startsWith("solana:"))?.address;
  if (evm === undefined || solana === undefined) {
    throw new PerpError("NO_SIGNER_AVAILABLE", `OWS wallet "${name}" has no EVM or Solana account`, { remediation: "Run: perp wallet show" });
  }
  return { evm, solana };
}

function lighterAgent(venue: "lighter" | "lighter-rh", network: Network): LighterAgentMeta {
  const meta = getAgentForNetwork(venue, network);
  if (!meta || typeof meta.accountIndex !== "number" || typeof meta.apiKeyIndex !== "number") {
    throw new PerpError("AGENT_NOT_REGISTERED", `No ${venue} agent registered on ${network}`, { remediation: `Run: perp -e ${venue} wallet agent approve` });
  }
  return meta as LighterAgentMeta;
}

type LighterAgentMeta = NonNullable<ReturnType<typeof getAgentForNetwork>> & { accountIndex: number; apiKeyIndex: number };

/** Mints Lighter auth tokens; holds the agent key inside its WASM signer for the provider's lifetime. */
export interface LighterTokenSigner { createAuthToken(deadlineSec: number): Promise<string> }

/** Injectable for tests; the defaults are the CLI's own stores and signer. */
export interface CliCredentialDeps {
  owsAddresses(): { evm: string; solana: string };
  lighterAgent(venue: "lighter" | "lighter-rh", network: Network): LighterAgentMeta;
  arcusAgent(network: Network): { ownerAddress: `0x${string}`; accountIndex: number } | null;
  /** Decrypt the agent key with the empty passphrase (never prompts). */
  loadLighterKey(venue: "lighter" | "lighter-rh", network: Network, meta: LighterAgentMeta): Promise<string>;
  makeLighterSigner(venue: "lighter" | "lighter-rh", network: Network, meta: LighterAgentMeta, key: string): Promise<LighterTokenSigner>;
}

const DEFAULT_DEPS: CliCredentialDeps = {
  owsAddresses: activeOwsAddresses,
  lighterAgent,
  arcusAgent: (network) => getVenueAgentForNetwork("arcus", network),
  async loadLighterKey(venue, network, meta) {
    const { loadLighterFamilyKey } = await import("../agent-wallet/lighter-keystore.js");
    return loadLighterFamilyKey(venue, network, meta.accountIndex, meta.apiKeyIndex, "");
  },
  async makeLighterSigner(venue, network, meta, key) {
    const { LighterAdapter } = await import("../exchanges/lighter.js");
    const adapter = LighterAdapter.forVenue(venue, "", network === "testnet");
    adapter.setAgentSigner(meta, key);
    if (meta.userEvmAddress) adapter.setAddress(meta.userEvmAddress);
    await adapter.init();
    return { createAuthToken: async (deadlineSec) => (await adapter.signer.createAuthToken(deadlineSec)).authToken };
  },
};

/**
 * Keystore decrypt failures with the empty passphrase mean "this keystore has a passphrase" →
 * PASSPHRASE_REQUIRED. Every other keystore error keeps its code with a generic message (no path,
 * no crypto detail, no key material).
 */
function keystoreError(venue: string, e: unknown): PerpError {
  const code = e instanceof PerpError ? e.structured.code : "UNKNOWN";
  const msg = e instanceof Error ? e.message : "";
  if (code === "SIGNATURE_FAILED" && /LIGHTER_KEYSTORE_DECRYPT_FAILED: (?!corrupt JSON|unsupported)|Keystore decrypt failed/.test(msg)) {
    return new PerpError("PASSPHRASE_REQUIRED", `${venue} agent keystore needs a passphrase (not prompted for a stream)`, {
      remediation: "Use a keystore without a passphrase for streaming, or pass your own CredentialProvider.authToken",
    });
  }
  const remediation = e instanceof PerpError ? e.structured.remediation : undefined;
  return new PerpError(code, `${venue} agent keystore could not be read (${code})`, remediation === undefined ? undefined : { remediation });
}

export function createCliCredentialProvider(venue: CliWsVenue, network: Network, deps: Partial<CliCredentialDeps> = {}): CliCredentialProvider {
  const d: CliCredentialDeps = { ...DEFAULT_DEPS, ...deps };
  const warnings: string[] = [];
  let signer: Promise<LighterTokenSigner> | null = null;
  const provider: CliCredentialProvider = {
    warnings,
    async user(): Promise<UserRef> {
      switch (venue) {
        case "hyperliquid":
          return { venue, address: d.owsAddresses().evm as `0x${string}` };
        case "pacifica":
          return { venue, account: d.owsAddresses().solana };
        case "lighter":
        case "lighter-rh":
          return { venue, accountIndex: d.lighterAgent(venue, network).accountIndex };
        case "arcus": {
          const a = d.arcusAgent(network);
          if (a === null) throw new PerpError("AGENT_NOT_REGISTERED", `No arcus agent registered on ${network}`, { remediation: "Run: perp -e arcus wallet agent approve" });
          if (a.accountIndex === 255) {
            // 255 = an API key for ALL subaccounts; a stream follows one account → the venue default (0).
            const w = "arcus agent covers all subaccounts (255): streaming subaccount 0 (the venue default); pass your own CredentialProvider.user() for another subaccount";
            if (!warnings.includes(w)) warnings.push(w);
            return { venue, address: a.ownerAddress, subaccount: null };
          }
          return { venue, address: a.ownerAddress, subaccount: a.accountIndex };
        }
      }
    },
  };
  if (venue === "lighter" || venue === "lighter-rh") {
    // One signer per provider: the agent key is decrypted once and lives only inside the WASM signer
    // until the provider is dropped. A failed creation is not cached (the next call retries).
    const getSigner = (): Promise<LighterTokenSigner> => {
      if (signer === null) {
        signer = (async () => {
          const meta = d.lighterAgent(venue, network);
          let key: string;
          try {
            key = await d.loadLighterKey(venue, network, meta);
          } catch (e) {
            throw keystoreError(venue, e);
          }
          return d.makeLighterSigner(venue, network, meta, key);
        })();
        signer.catch(() => { signer = null; });
      }
      return signer;
    };
    provider.authToken = async ({ maxTtlSec }) => {
      const s = await getSigner();
      const deadlineSec = Math.floor(Date.now() / 1000) + maxTtlSec;
      const token = await s.createAuthToken(deadlineSec);
      return { token, expiresAt: deadlineSec * 1000 };
    };
  }
  return provider;
}
