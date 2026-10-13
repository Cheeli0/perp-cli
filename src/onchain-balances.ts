/**
 * On-chain wallet balances (`perp wallet balance`): the gas token plus the USD stablecoins
 * (USDC / USDT; USDG on Robinhood Chain) on every chain perp-cli moves funds on.
 *
 * Token pins come from the registries the fund-movement code already uses (RELAY_CHAINS,
 * ONDO_DEPOSIT_CHAINS); the two not in them are Tether's Ethereum USDT and Solana USDT
 * (tether.to/en/supported-protocols). A read that fails is reported per token
 * (balance null + error) — never shown as 0.
 */
import { HYPERLIQUID_API_URL } from "./api/public/urls.js";
import { ONDO_DEPOSIT_CHAINS } from "./exchanges/venues/ondo.js";
import { RELAY_CHAINS } from "./relay-swap.js";

export interface OnchainBalance {
  /** Chain id in perp-cli terms (arbitrum, ethereum, base, bsc, robinhood, solana, …). */
  chain: string;
  token: string;
  kind: "stable" | "native";
  /** Decimal string; null = the read failed (see `error`). */
  balance: string | null;
  /** Stablecoins at $1; native tokens at the Hyperliquid mid; null when unknown. */
  usdValue: number | null;
  /** Why the balance read failed (balance null). */
  error: string | null;
  /** Why a native token's usdValue is null although its balance was read. */
  priceError: string | null;
}

interface TokenPin { symbol: string; address: string; decimals: number }
interface EvmChainPin { label: string; chainId: number; rpcUrl: string; native: string; tokens: TokenPin[] }

const relayToken = (chain: string, symbol: string): TokenPin => {
  const a = RELAY_CHAINS[chain]?.assets[symbol];
  if (a === undefined) throw new Error(`RELAY_CHAINS has no ${symbol} on ${chain}`);
  return { symbol, address: a.address, decimals: a.decimals };
};
const relayRpc = (chain: string): string => {
  const url = RELAY_CHAINS[chain]?.rpcUrl;
  if (url === null || url === undefined) throw new Error(`RELAY_CHAINS has no RPC for ${chain}`);
  return url;
};

/** Mainnet EVM chains, in display order. */
export function mainnetEvmChains(): Record<string, EvmChainPin> {
  return {
    arbitrum: {
      label: "Arbitrum", chainId: 42161, rpcUrl: relayRpc("arbitrum"), native: "ETH",
      tokens: [relayToken("arbitrum", "USDC"), relayToken("arbitrum", "USDT")],
    },
    ethereum: {
      label: "Ethereum", chainId: 1, rpcUrl: ONDO_DEPOSIT_CHAINS.ethereum.rpcUrl, native: "ETH",
      tokens: [
        { symbol: "USDC", address: ONDO_DEPOSIT_CHAINS.ethereum.usdc, decimals: 6 },
        { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
      ],
    },
    base: {
      label: "Base", chainId: 8453, rpcUrl: relayRpc("base"), native: "ETH",
      tokens: [relayToken("base", "USDC")],
    },
    bsc: {
      label: "BNB Chain", chainId: 56, rpcUrl: relayRpc("bsc"), native: "BNB",
      tokens: [relayToken("bsc", "USDT"), relayToken("bsc", "USDC")],
    },
    robinhood: {
      label: "Robinhood Chain", chainId: 4663, rpcUrl: relayRpc("robinhood"), native: "ETH",
      tokens: [relayToken("robinhood", "USDG")],
    },
  };
}

const TESTNET_EVM_CHAINS: Record<string, EvmChainPin> = {
  "arbitrum-sepolia": {
    label: "Arbitrum Sepolia", chainId: 421614, rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc", native: "ETH",
    tokens: [{ symbol: "USDC", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6 }],
  },
};

/** Built on use (not at import) so a registry change can only break `wallet balance`, never startup. */
function solanaPins(testnet: boolean): { rpcUrl: string; tokens: TokenPin[] } {
  return testnet
    ? { rpcUrl: "https://api.devnet.solana.com", tokens: [{ symbol: "USDP", address: "USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM", decimals: 6 }] }
    : {
      rpcUrl: "https://api.mainnet-beta.solana.com",
      tokens: [
        { symbol: "USDC", address: relayToken("solana", "USDC").address, decimals: 6 },
        { symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
      ],
    };
}

/** Per-request timeout of every read here: a stuck public RPC becomes a per-row error, not a hang. */
export const ONCHAIN_READ_TIMEOUT_MS = 10_000;
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ONCHAIN_READ_TIMEOUT_MS) });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

interface Prices { px: Map<string, number>; error: string | null }

/**
 * USD mids of the native gas tokens from Hyperliquid allMids. A failed / missing price leaves the
 * native row's usdValue null and names the reason in `priceError`; balances are unaffected.
 */
async function nativePrices(): Promise<Prices> {
  const px = new Map<string, number>();
  try {
    const res = await timedFetch(HYPERLIQUID_API_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }),
    });
    if (!res.ok) return { px, error: `Hyperliquid allMids HTTP ${res.status}` };
    const mids = await res.json() as Record<string, unknown>;
    for (const sym of ["ETH", "BNB", "SOL"]) {
      const v = Number(mids[sym]);
      if (typeof mids[sym] === "string" && Number.isFinite(v) && v > 0) px.set(sym, v);
    }
    return { px, error: null };
  } catch (e) {
    return { px, error: `Hyperliquid allMids: ${errText(e)}` };
  }
}

function row(chain: string, token: string, kind: "stable" | "native", balance: string | null, prices: Prices, error: string | null): OnchainBalance {
  let usdValue: number | null = null;
  let priceError: string | null = null;
  if (balance !== null) {
    if (kind === "stable") usdValue = Number(balance);
    else if (prices.px.has(token)) usdValue = Number(balance) * prices.px.get(token)!;
    else priceError = prices.error ?? `no Hyperliquid mid for ${token}`;
  }
  return { chain, token, kind, balance, usdValue, error, priceError };
}

type Ethers = typeof import("ethers")["ethers"];

async function evmChainBalances(ethers: Ethers, chain: string, pin: EvmChainPin, address: string, prices: Prices): Promise<OnchainBalance[]> {
  const req = new ethers.FetchRequest(pin.rpcUrl);
  req.timeout = ONCHAIN_READ_TIMEOUT_MS;
  // batchMaxCount 1: one plain JSON-RPC call per read (not every public RPC accepts batches).
  const provider = new ethers.JsonRpcProvider(req, pin.chainId, { staticNetwork: true, batchMaxCount: 1 });
  const native = provider.getBalance(address)
    .then(b => row(chain, pin.native, "native", ethers.formatEther(b), prices, null))
    .catch(e => row(chain, pin.native, "native", null, prices, errText(e)));
  const tokens = pin.tokens.map(t => {
    const c = new ethers.Contract(t.address, ["function balanceOf(address) view returns (uint256)"], provider);
    return (c.balanceOf(address) as Promise<bigint>)
      .then(b => row(chain, t.symbol, "stable", ethers.formatUnits(b, t.decimals), prices, null))
      .catch(e => row(chain, t.symbol, "stable", null, prices, errText(e)));
  });
  return Promise.all([native, ...tokens]);
}

/** Gas token + stablecoins on every EVM chain (mainnet), or Arbitrum Sepolia (testnet). `only` limits the chains. */
export async function evmOnchainBalances(address: string, testnet: boolean, only?: readonly string[]): Promise<OnchainBalance[]> {
  const chains = testnet ? TESTNET_EVM_CHAINS : mainnetEvmChains();
  const selected = Object.entries(chains).filter(([id]) => only === undefined || only.includes(id));
  const [{ ethers }, prices] = await Promise.all([import("ethers"), nativePrices()]);
  return (await Promise.all(selected.map(([id, pin]) => evmChainBalances(ethers, id, pin, address, prices)))).flat();
}

/** SOL + USDC / USDT (mainnet) or USDP (devnet) of a Solana address. */
export async function solanaOnchainBalances(address: string, testnet: boolean): Promise<OnchainBalance[]> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const cfg = solanaPins(testnet);
  const chain = testnet ? "solana-devnet" : "solana";
  const connection = new Connection(cfg.rpcUrl, { fetch: timedFetch as never });
  const owner = new PublicKey(address);
  const prices = await nativePrices();
  const sol = connection.getBalance(owner)
    .then(l => row(chain, "SOL", "native", (l / 1e9).toFixed(9).replace(/\.?0+$/, ""), prices, null))
    .catch(e => row(chain, "SOL", "native", null, prices, errText(e)));
  const tokens = cfg.tokens.map(t =>
    connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(t.address) })
      .then(res => {
        let raw = 0n;
        for (const { account } of res.value) {
          const amount = (account.data as { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } }).parsed?.info?.tokenAmount?.amount;
          if (typeof amount !== "string") throw new Error(`token account without a raw amount for ${t.symbol}`);
          raw += BigInt(amount);
        }
        const s = raw.toString().padStart(t.decimals + 1, "0");
        const dec = `${s.slice(0, -t.decimals)}.${s.slice(-t.decimals)}`.replace(/\.?0+$/, "");
        return row(chain, t.symbol, "stable", dec, prices, null);
      })
      .catch(e => row(chain, t.symbol, "stable", null, prices, errText(e))));
  return Promise.all([sol, ...tokens]);
}

/** Sum of the stablecoin balances that were read (failed reads are excluded and listed in `errors`). */
export function stableTotal(rows: readonly OnchainBalance[]): { usd: number; errors: string[] } {
  let usd = 0;
  const errors: string[] = [];
  for (const r of rows) {
    if (r.error !== null) errors.push(`${r.chain} ${r.token}: ${r.error}`);
    else if (r.kind === "stable") usd += Number(r.balance);
  }
  return { usd, errors };
}
