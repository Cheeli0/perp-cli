/**
 * Venue ids and networks for perp-cli/ws. A local copy (src/ws imports only src/ws/**), kept in
 * line with src/exchanges/venue-types.ts by a parity test. Ids are stable.
 */

export type VenueId =
  | "pacifica" | "hyperliquid" | "lighter" | "aster"
  | "lighter-rh" | "ondo" | "arcus" | "qfex";

export const VENUE_IDS: readonly VenueId[] = [
  "pacifica", "hyperliquid", "lighter", "aster",
  "lighter-rh", "ondo", "arcus", "qfex",
];

export type Network = "mainnet" | "testnet";
