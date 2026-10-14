const path = require("path");

/** @type {import("next").NextConfig} */
module.exports = {
  // perp-cli/ws is ESM / ES2020: let Next transpile it like app code.
  transpilePackages: ["perp-cli"],
  // The page imports ../ws-funding-compare-browser/app.js (outside this project).
  experimental: { externalDir: true },
  webpack(config) {
    // Resolve "perp-cli/ws" for that external file from this project's node_modules.
    config.resolve.modules = [...(config.resolve.modules ?? ["node_modules"]), path.resolve(__dirname, "node_modules")];
    return config;
  },
};
