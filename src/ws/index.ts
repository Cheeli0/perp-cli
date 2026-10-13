/**
 * perp-cli/ws — browser-safe composable WebSocket library (plan ws-0.14.4).
 * ESM, ES2020, no side effects, no top-level await, no globals touched at module load.
 *
 * @experimental 0.14.x: breaking changes only in a minor bump; events carry `schema: 1`.
 */

export type * from "./types.js";
export { VENUE_IDS } from "./ids.js";
export { WsError, isPerpError, WS_ERROR_CODES } from "./errors.js";
export type { WsErrorCode, WsStructuredError } from "./errors.js";
export { createVenueStream } from "./stream.js";
export { defaultCanonicalize, USD_LIKE_QUOTES } from "./canonical.js";
export { createFundingComparator, toHourly, toApr } from "./funding.js";
export type { ComparatorKind, ComparatorListenerError, FundingComparator, FundingComparatorOptions, FundingLeg, FundingRow } from "./funding.js";
export { hyperliquid } from "./codecs/hyperliquid.js";
export { pacifica } from "./codecs/pacifica.js";
export { lighter, lighterRh } from "./codecs/lighter.js";
export { aster } from "./codecs/aster.js";
export { arcus } from "./codecs/arcus.js";
