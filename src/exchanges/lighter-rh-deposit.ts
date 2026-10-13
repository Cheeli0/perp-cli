/**
 * Lighter RH deposit on Robinhood Chain (apidocs.rh.lighter.xyz
 * "Deposits, Transfers, and Withdrawals" + apidocs.lighter.xyz/docs/lighter-rh):
 *
 *   ERC-20 approve(ZkLighterContract, amount) → deposit(_to, _assetIndex, _routeType, _amount)
 *
 * Contract, chain id and token are PINNED in the venue definition (networks.<net>.depositPins,
 * verified against the official docs) and cross-checked against the live venue API — any
 * disagreement is EXCHANGE_ERROR before anything is signed (a compromised/misconfigured API
 * cannot redirect the approve or the deposit):
 *   - contract  — GET /api/v1/layer1BasicInfo  contract_addresses[name=ZkLighterContract] == pins.contract
 *   - L1 chain  — GET /api/v1/layer1BasicInfo  l1_providers[0].chainId == pins.chainId == RPC eth_chainId
 *   - token     — GET /api/v1/assetDetails?asset_id=<collateralAssetIndex>  l1_address == pins.token,
 *                 symbol must equal the venue collateral (USDG); l1_decimals read live
 *   - RPC       — venue definition networks.<net>.rpcUrl
 * Minimum 1 USDG per deposit (docs). Only USDG may be routed to perps (route 0).
 *
 * Testnet: the RH testnet L1 (chainId 123456) has no documented RPC → CAPABILITY_UNSUPPORTED.
 * Transactions are signed by the master wallet through a transaction signer (the digest is
 * derived from the unsigned tx inside the signer — no raw-digest API).
 */

import { Interface, JsonRpcProvider, Network as EthersNetwork, Transaction, parseUnits } from "ethers";
import { sendMasterTx } from "../evm-master-tx.js";
import { PerpError } from "../errors.js";
import { unsupported } from "./trading-v2.js";
import type { Network } from "./venue-types.js";
import { LIGHTER_RH_NETWORKS } from "./venues/lighter-family.js";

/** Docs: "There is a minimum of 1 USDG, and equivalent for other ERC20s, per deposit." */
export const LIGHTER_RH_MIN_DEPOSIT = 1;

const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const zkLighter = new Interface([
  "function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount) payable",
]);

export interface LighterRhDepositPlan {
  network: Network;
  rpcUrl: string;
  chainId: number;
  contract: string;
  asset: string;
  assetIndex: number;
  token: string;
  decimals: number;
  amount: string;
  amountRaw: bigint;
  routeType: 0 | 1;
  depositor: string;
  tokenBalance: bigint;
  allowance: bigint;
  needsApprove: boolean;
}

export interface LighterRhDepositResult {
  approveTxHash: string | null;
  depositTxHash: string;
}

/** Signs an unsigned tx (hashing internally) and returns the 65-byte 0x signature. */
export type TxSigner = (tx: Transaction) => Promise<string>;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new PerpError("EXCHANGE_ERROR", `GET ${url} HTTP ${res.status}`, { exchange: "lighter-rh", body: text.slice(0, 300) });
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `GET ${url}: invalid JSON`, { exchange: "lighter-rh", body: text.slice(0, 300) });
  }
}

function venueError(msg: string): PerpError {
  return new PerpError("EXCHANGE_ERROR", `lighter-rh: ${msg}`, { exchange: "lighter-rh" });
}

function provider(rpcUrl: string, chainId: number): JsonRpcProvider {
  const net = EthersNetwork.from(chainId);
  return new JsonRpcProvider(rpcUrl, net, { staticNetwork: net });
}

/** Deposit is offered on mainnet only; testnet → uniform CAPABILITY_UNSUPPORTED. */
export function requireLighterRhDepositNetwork(net: Network): void {
  if (net === "testnet") {
    throw unsupported("Lighter RH", "deposit",
      "the RH testnet L1 (chainId 123456) has no documented RPC; testnet collateral comes from the faucet",
      "Use the faucet in the Lighter RH testnet app");
  }
}

/**
 * Read-only: resolve contract / token / chain from the venue API and the depositor's
 * balance + allowance from the RPC. Throws before anything is signed.
 */
export async function planLighterRhDeposit(p: {
  network: Network; amount: string; depositor: string; routeType: 0 | 1;
}): Promise<LighterRhDepositPlan> {
  requireLighterRhDepositNetwork(p.network);
  const cfg = LIGHTER_RH_NETWORKS[p.network];
  if (cfg.rpcUrl === null) throw new Error(`lighter-rh ${p.network} venue definition is missing rpcUrl`);
  const assetIndex = cfg.collateralAssetIndex;
  const asset = cfg.collateral[0];
  if (assetIndex === null || asset === undefined) throw new Error(`lighter-rh ${p.network} venue definition has no collateral asset`);
  const pins = cfg.depositPins;
  if (pins === null) {
    throw new PerpError("NOT_IMPLEMENTED", `Lighter RH ${p.network} deposit has no pinned contract/token addresses`, {
      remediation: "Deposit from the Lighter RH web app; the CLI only deposits to officially verified, pinned addresses",
    });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.depositor)) {
    throw new PerpError("NO_SIGNER_AVAILABLE", "Lighter RH deposit needs the master wallet address", {
      remediation: "Run with the master wallet: perp -e lighter-rh --ows <wallet> funds deposit lighter-rh <amount>",
    });
  }
  if (!/^\d+(\.\d+)?$/.test(p.amount) || !(Number(p.amount) > 0)) {
    throw new PerpError("INVALID_PARAMS", `Deposit amount must be a positive decimal (got "${p.amount}")`);
  }
  if (Number(p.amount) < LIGHTER_RH_MIN_DEPOSIT) {
    throw new PerpError("SIZE_TOO_SMALL", `Lighter RH minimum deposit is ${LIGHTER_RH_MIN_DEPOSIT} ${asset} (got ${p.amount})`);
  }
  const base = `${cfg.restUrl}/api/v1`;
  const [l1, details] = await Promise.all([
    getJson(`${base}/layer1BasicInfo`),
    getJson(`${base}/assetDetails?asset_id=${assetIndex}`),
  ]);

  const contracts = l1.contract_addresses;
  if (!Array.isArray(contracts)) throw venueError("layer1BasicInfo: missing contract_addresses");
  const zk = (contracts as Array<{ name?: unknown; address?: unknown }>).find(c => c.name === "ZkLighterContract");
  if (zk === undefined || typeof zk.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(zk.address)) {
    throw venueError("layer1BasicInfo: no ZkLighterContract address");
  }
  const providers = l1.l1_providers;
  const l1ChainId = Array.isArray(providers) ? (providers[0] as { chainId?: unknown } | undefined)?.chainId : undefined;
  if (typeof l1ChainId !== "number" || !Number.isInteger(l1ChainId)) throw venueError("layer1BasicInfo: missing l1_providers[0].chainId");

  const list = details.asset_details;
  if (!Array.isArray(list)) throw venueError("assetDetails: missing asset_details");
  const a = (list as Array<Record<string, unknown>>).find(x => x.asset_id === assetIndex);
  if (a === undefined) throw venueError(`assetDetails: asset ${assetIndex} not listed`);
  if (a.symbol !== asset) throw venueError(`assetDetails: asset ${assetIndex} is ${String(a.symbol)}, expected ${asset}`);
  if (typeof a.l1_address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a.l1_address)) throw venueError(`assetDetails: ${asset} has no l1_address`);
  if (typeof a.l1_decimals !== "number" || !Number.isInteger(a.l1_decimals)) throw venueError(`assetDetails: ${asset} has no l1_decimals`);

  const same = (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase();
  if (!same(zk.address, pins.contract)) {
    throw venueError(`layer1BasicInfo ZkLighterContract ${zk.address} != pinned ${pins.contract} — refusing to approve/deposit (verify at ${pins.sources[0]})`);
  }
  if (l1ChainId !== pins.chainId) {
    throw venueError(`layer1BasicInfo chainId ${l1ChainId} != pinned ${pins.chainId} — refusing to deposit`);
  }
  if (!same(a.l1_address, pins.token)) {
    throw venueError(`assetDetails ${asset} l1_address ${a.l1_address} != pinned ${pins.token} — refusing to approve/deposit`);
  }

  const rpc = provider(cfg.rpcUrl, l1ChainId);
  const rpcChain = BigInt(await rpc.send("eth_chainId", []));
  if (rpcChain !== BigInt(l1ChainId)) {
    throw venueError(`RPC ${cfg.rpcUrl} serves chainId ${rpcChain}, venue L1 is ${l1ChainId}`);
  }
  let amountRaw: bigint;
  try {
    amountRaw = parseUnits(p.amount, a.l1_decimals);
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", `Lighter RH deposit amount "${p.amount}" is not a decimal ${asset} amount with at most ${a.l1_decimals} decimals: ${e instanceof Error ? e.message : String(e)}`, {
      exchange: "lighter-rh", remediation: `Pass a plain decimal amount with at most ${a.l1_decimals} decimals, e.g. 10 or 10.5`,
    });
  }
  if (amountRaw <= 0n) {
    throw new PerpError("INVALID_PARAMS", `Lighter RH deposit amount must be positive (got "${p.amount}")`, { exchange: "lighter-rh" });
  }
  const [balRaw, allowRaw] = await Promise.all([
    rpc.call({ to: a.l1_address, data: erc20.encodeFunctionData("balanceOf", [p.depositor]) }),
    rpc.call({ to: a.l1_address, data: erc20.encodeFunctionData("allowance", [p.depositor, zk.address]) }),
  ]);
  const tokenBalance = erc20.decodeFunctionResult("balanceOf", balRaw)[0] as bigint;
  const allowance = erc20.decodeFunctionResult("allowance", allowRaw)[0] as bigint;
  if (tokenBalance < amountRaw) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Wallet ${p.depositor} holds ${tokenBalance} raw ${asset} on Robinhood Chain; deposit needs ${amountRaw}`, {
      exchange: "lighter-rh", remediation: `Fund ${p.depositor} with ${asset} on Robinhood Chain (chainId ${l1ChainId}) first`,
    });
  }
  return {
    network: p.network, rpcUrl: cfg.rpcUrl, chainId: pins.chainId, contract: pins.contract,
    asset, assetIndex, token: pins.token, decimals: a.l1_decimals,
    amount: p.amount, amountRaw, routeType: p.routeType, depositor: p.depositor,
    tokenBalance, allowance, needsApprove: allowance < amountRaw,
  };
}

/**
 * Simulate, sign, broadcast one tx and wait for a successful receipt (shared master-tx path:
 * once broadcast, a lost response / receipt timeout is ORDER_PENDING carrying the tx hash).
 */
async function sendTx(rpc: JsonRpcProvider, plan: LighterRhDepositPlan, to: string, data: string, label: string, sign: TxSigner): Promise<string> {
  const { txHash } = await sendMasterTx(rpc, {
    venue: "lighter-rh", chainLabel: "Robinhood Chain", chainId: plan.chainId, from: plan.depositor, to, data, value: 0n, label,
  }, sign);
  return txHash;
}

/** Sends approve (only when the allowance is short — exact amount, not unlimited) then deposit. */
export async function executeLighterRhDeposit(plan: LighterRhDepositPlan, sign: TxSigner): Promise<LighterRhDepositResult> {
  const rpc = provider(plan.rpcUrl, plan.chainId);
  let approveTxHash: string | null = null;
  if (plan.needsApprove) {
    approveTxHash = await sendTx(rpc, plan, plan.token, erc20.encodeFunctionData("approve", [plan.contract, plan.amountRaw]), `${plan.asset} approve`, sign);
  }
  const data = zkLighter.encodeFunctionData("deposit", [plan.depositor, plan.assetIndex, plan.routeType, plan.amountRaw]);
  const depositTxHash = await sendTx(rpc, plan, plan.contract, data, "Lighter RH deposit", sign);
  return { approveTxHash, depositTxHash };
}
