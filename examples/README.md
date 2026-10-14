# perp-cli/ws examples

Runnable examples for the `perp-cli/ws` library (0.15.0, @experimental). They double as smoke tests in
the release gate (`node scripts/ws-gate/release-gate.mjs`).

| Example | Runtime | Shows |
|---|---|---|
| [ws-funding-compare-browser](ws-funding-compare-browser) | browser (static page) | funding comparator `kind: "next"`, per-venue connection state, bbo of the selected pair |
| [ws-next-smoke](ws-next-smoke) | Next 13.5 (webpack, `transpilePackages`) | the same page built against an installed `perp-cli` |
| [ws-node-stream](ws-node-stream) | Node 20+ (`perp-cli/ws/node`) | market + bbo for one symbol, optional user stream via the CLI credential provider |

The examples import `perp-cli/ws` (they run against this repository's `dist/ws`). The same code is
published standalone as **`@hypurrquant/perp-ws`** (zero dependencies, recommended for apps): replace
`perp-cli/ws` by `@hypurrquant/perp-ws` and `perp-cli/ws/node` by `@hypurrquant/perp-ws/node` (Node also
needs `npm install ws`). The release gate builds the Next example against both packages.

Build first: `pnpm build`. Guide for building your own dashboard:
[`skills/perp-cli/references/ws-library.md`](../skills/perp-cli/references/ws-library.md).
