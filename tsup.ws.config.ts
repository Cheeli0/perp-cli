import { defineConfig, type Options } from "tsup";

/**
 * perp-cli/ws build (plan ws-0.14.4 §4.7): single-file ES2020 ESM + a self-contained d.ts per entry
 * in dist/ws (one build per entry, so neither JS nor d.ts is split into shared chunks).
 * `ws` stays external (Node entry only). The CLI's `tsc` build excludes src/ws/**.
 */
const common: Options = {
  outDir: "dist/ws",
  format: ["esm"],
  target: "es2020",
  platform: "neutral",
  dts: { compilerOptions: { lib: ["ES2020", "DOM"] } },
  splitting: false,
  treeshake: true,
  sourcemap: false,
  clean: false,
  external: ["ws", "node:module"],
  removeNodeProtocol: false,
  tsconfig: "tsconfig.ws.json",
};

export default defineConfig([
  { ...common, entry: { index: "src/ws/index.ts" } },
  { ...common, entry: { node: "src/ws/node.ts" } },
]);
