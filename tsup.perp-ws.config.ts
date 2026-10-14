import type { Options } from "tsup";
import ws from "./tsup.ws.config.js";

/**
 * @hypurrquant/perp-ws build: exactly the perp-cli/ws build (same entries, options and sources in
 * src/ws/**), emitted into packages/perp-ws/dist instead of dist/ws.
 */
export default (ws as Options[]).map((c) => ({ ...c, outDir: "packages/perp-ws/dist" }));
