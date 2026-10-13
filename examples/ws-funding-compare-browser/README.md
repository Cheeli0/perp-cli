# ws-funding-compare-browser

A static page that compares live funding across hyperliquid, pacifica, lighter, lighter-rh, aster and
arcus with `perp-cli/ws` in the browser (native `WebSocket`, no framework, no build step):

- connection state per venue (`stream.onState`);
- the funding comparator with `kind: "next"` (accruing where the venue publishes it, else predicted),
  ranked by the per-hour spread (`toHourly`, annualized only for display with `toApr`);
- click a row → `bbo` of the two extreme legs.

Run from the repository root:

```sh
pnpm build                               # builds dist/ws
npx -y http-server -p 8080 .             # any static server rooted at the repo
open http://localhost:8080/examples/ws-funding-compare-browser/
```

`app.js` imports `perp-cli/ws`; the page maps that specifier to `../../dist/ws/index.js` with an import
map. In an app with a bundler, install `perp-cli` and import `perp-cli/ws` — the
[`ws-next-smoke`](../ws-next-smoke) example builds this same `app.js` with Next 13.5.

Public data only (no keys). The page opens one WebSocket per venue.
