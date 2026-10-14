# @hypurrquant/perp-ws

Live **market, funding and account WebSocket streams** for perp DEXes — **hyperliquid** (native + HIP-3),
**pacifica**, **lighter**, **lighter-rh**, **aster** and **arcus** — in the browser or Node, with a
cross-venue funding comparator. **No dependencies.**

This is the standalone build of [`perp-cli/ws`](https://github.com/hypurrquant/perp-cli): the same
source, the same API, released in lockstep with perp-cli. Use this package in apps and dashboards; use
`perp-cli/ws` only if perp-cli is already installed.

> **@experimental** in 0.15.x (breaking changes only in a minor bump; events carry `schema: 1`),
> **@stable** from 0.16.0.

## Install

```sh
npm install @hypurrquant/perp-ws        # browser / bundler / Node ≥ 22 with the global WebSocket
npm install @hypurrquant/perp-ws ws     # Node 20+ via the /node entry
```

| Entry | Runtime | Transport |
|---|---|---|
| `@hypurrquant/perp-ws` | browser (any bundler, Next.js, Vite, static page), Node ≥ 22 | native `WebSocket` + `fetch` |
| `@hypurrquant/perp-ws/node` | Node 20+ | [`ws`](https://www.npmjs.com/package/ws) — an **optional peer dependency** |

The `/node` entry loads `ws` lazily: importing it never fails, and creating a stream without `ws`
installed throws `INVALID_PARAMS` with the install command. It uses `ws` even on Node ≥ 22 for a 16 MiB
inbound message cap (`createNodeTransport({ maxPayload })`) and protocol ping/pong.

ESM only, ES2020, `sideEffects: false`, no top-level await, no global touched at module load (SSR-safe).
Next.js 13.5+: `transpilePackages: ["@hypurrquant/perp-ws"]`.

## Example

```ts
import { createFundingComparator, createVenueStream, hyperliquid, lighter, pacifica, toApr } from "@hypurrquant/perp-ws";

const streams = [hyperliquid, pacifica, lighter].map((c) => createVenueStream(c));
const cmp = createFundingComparator({ streams, kind: "next", minVenues: 2 });
cmp.subscribe((rows) => {
  for (const row of rows) {
    console.log(row.canonical, row.legs.map((l) => [l.venue, toApr(l.rate, l.funding.rateIntervalHours)]));
  }
});
```

Unknown values are `null`, never `0`. Rates are raw per the venue's interval; annualize with `toApr`.

## Documentation

The full guide (streams, event fields and nullability, comparator, user channels with a
`CredentialProvider`, errors, limits, capability matrix):
[`skills/perp-cli/references/ws-library.md`](https://github.com/hypurrquant/perp-cli/blob/main/skills/perp-cli/references/ws-library.md).

## License

MIT
