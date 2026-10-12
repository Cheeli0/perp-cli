/**
 * Typed test views of adapter internals.
 *
 * Tests build adapters with `Object.create(X.prototype)` and stub private / readonly members.
 * Each view names exactly the members tests touch, typed through indexed access on the class
 * (`X["_member"]` works on private members), so a renamed or removed member — or a changed
 * member type — breaks the typecheck instead of silently stubbing a dead property.
 */
import type { LighterAdapter } from "../../exchanges/lighter.js";
import type { LighterSpotAdapter } from "../../exchanges/lighter-spot.js";
import type { PacificaAdapter } from "../../exchanges/pacifica.js";
import type { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import type { OndoAdapter } from "../../exchanges/ondo/adapter.js";

/** `T`'s public surface with the internals `I` laid over it (writable, real types). */
export type WithInternals<T, I> = Omit<T, keyof I & keyof T> & I;

/**
 * Stub of an HTTP client: any subset of the real methods with their real parameters; the resolved
 * value is whatever fixture the test serves (partial rows, or a generic decoder's `T`).
 */
export type ClientStub<C> = {
  [K in keyof C]?: C[K] extends (...args: infer A) => Promise<unknown> ? (...args: A) => Promise<unknown> : C[K];
};

export interface LighterInternals {
  name: LighterAdapter["name"];
  venueId: LighterAdapter["venueId"];
  _network: LighterAdapter["_network"];
  _testnet: LighterAdapter["_testnet"];
  _apiKeyIndex: LighterAdapter["_apiKeyIndex"];
  _accountIndex: LighterAdapter["_accountIndex"];
  _address: LighterAdapter["_address"];
  _readOnly: LighterAdapter["_readOnly"];
  _marketMap: LighterAdapter["_marketMap"];
  _marketDecimals: LighterAdapter["_marketDecimals"];
  /** Stubbed with only the signing methods a test exercises. */
  _signer: Partial<LighterAdapter["_signer"]>;
  ensureSigner: LighterAdapter["ensureSigner"];
  ensureMarketMap: LighterAdapter["ensureMarketMap"];
  getNextNonce: LighterAdapter["getNextNonce"];
  getReferencePrice: LighterAdapter["getReferencePrice"];
  toTicks: LighterAdapter["toTicks"];
  signOrder: LighterAdapter["signOrder"];
  sendTx: LighterAdapter["sendTx"];
  restGet: LighterAdapter["restGet"];
  restGetAuth: LighterAdapter["restGetAuth"];
  fetchAccount: LighterAdapter["fetchAccount"];
}
export type LighterTestAdapter = WithInternals<LighterAdapter, LighterInternals>;

export interface LighterSpotInternals {
  _initialized: LighterSpotAdapter["_initialized"];
  _spotMarketMap: LighterSpotAdapter["_spotMarketMap"];
  _spotBaseMap: LighterSpotAdapter["_spotBaseMap"];
  _spotDecimals: LighterSpotAdapter["_spotDecimals"];
  _spotMinSize: LighterSpotAdapter["_spotMinSize"];
  _restGet: LighterSpotAdapter["_restGet"];
  _restGetAuth: LighterSpotAdapter["_restGetAuth"];
  _getNextNonce: LighterSpotAdapter["_getNextNonce"];
  _placeOrder: LighterSpotAdapter["_placeOrder"];
  _sendTx: LighterSpotAdapter["_sendTx"];
  _prepareMarketOrder: LighterSpotAdapter["_prepareMarketOrder"];
}
export type LighterSpotTestAdapter = WithInternals<LighterSpotAdapter, LighterSpotInternals>;

export interface PacificaInternals {
  /** Stubbed with only the client methods a test exercises. */
  client: ClientStub<PacificaAdapter["client"]>;
  account: PacificaAdapter["account"];
  signMessage: PacificaAdapter["signMessage"];
  ensureSigner: PacificaAdapter["ensureSigner"];
  _hasRealKey: PacificaAdapter["_hasRealKey"];
  builderCode: PacificaAdapter["builderCode"];
  withOrderOutcome: PacificaAdapter["withOrderOutcome"];
}
export type PacificaTestAdapter = WithInternals<PacificaAdapter, PacificaInternals>;

export interface HyperliquidInternals {
  _address: HyperliquidAdapter["_address"];
  _dex: HyperliquidAdapter["_dex"];
  _assetMap: HyperliquidAdapter["_assetMap"];
  ensureSigner: HyperliquidAdapter["ensureSigner"];
  ensureAddress: HyperliquidAdapter["ensureAddress"];
  _invalidateAccountCache: HyperliquidAdapter["_invalidateAccountCache"];
  _infoPost: HyperliquidAdapter["_infoPost"];
  _signAndSendAction: HyperliquidAdapter["_signAndSendAction"];
  _hlRoundPrice: HyperliquidAdapter["_hlRoundPrice"];
}
export type HyperliquidTestAdapter = WithInternals<HyperliquidAdapter, HyperliquidInternals>;

export interface OndoInternals {
  venue: OndoAdapter["venue"];
  network: OndoAdapter["network"];
  caps: OndoAdapter["caps"];
  /** Stubbed with only the client methods a test exercises. */
  client: ClientStub<OndoAdapter["client"]>;
}
export type OndoTestAdapter = WithInternals<OndoAdapter, OndoInternals>;
