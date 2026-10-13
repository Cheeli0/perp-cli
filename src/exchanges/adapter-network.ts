/**
 * The network an adapter instance was created for. Legacy adapters keep it in private fields of
 * different shapes, so the creator registers it here (cli-program createVenueAdapter, MCP
 * getAdapter); TradingV2 adapters also expose `network` themselves. Unknown → null (callers that
 * need it refuse; never a guessed network).
 */
import type { ExchangeAdapter } from "./interface.js";
import type { Network } from "./venue-types.js";

const networks = new WeakMap<object, Network>();

export function registerAdapterNetwork(adapter: ExchangeAdapter, network: Network): void {
  networks.set(adapter, network);
}

export function adapterNetworkOf(adapter: ExchangeAdapter): Network | null {
  const own = (adapter as { network?: unknown }).network;
  if (own === "mainnet" || own === "testnet") return own;
  return networks.get(adapter) ?? null;
}
