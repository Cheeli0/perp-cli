# ws-node-stream

`perp-cli/ws/node` from a Node script: market state + bbo for one symbol, and optionally your own
account (account / positions / orders / fills). Read-only.

```sh
pnpm build                                                        # dist/ws + dist/ws-cli
node examples/ws-node-stream/stream.mjs                           # hyperliquid BTC, 20 s
node examples/ws-node-stream/stream.mjs lighter ETH --seconds 30
node examples/ws-node-stream/stream.mjs arcus BTC-USD --user      # + your account stream
```

- Venues: `hyperliquid`, `pacifica`, `lighter`, `lighter-rh`, `aster`, `arcus` (symbols as listed by
  `stream.markets()`, e.g. `BTCUSDT` on Aster, `BTC-USD` on Arcus, `xyz:TSLA` with `hip3Dexes`).
- `perp-cli/ws/node` supplies the `ws` transport (Node 20 has no global `WebSocket`); the API is the
  same as `perp-cli/ws`.
- `--user` uses the CLI's credential provider (`dist/ws-cli/credentials.js`): the address / account id
  comes from the active OWS wallet and registered agents, the Lighter orders token from the agent
  keystore (a keystore with a passphrase is refused, never prompted). It is not part of the published
  `perp-cli/ws` API; in your own app pass a `CredentialProvider`.
- Exit code 0 when at least one market update arrived (the release gate uses it as a smoke test).

Inside the repository `perp-cli/ws/node` resolves to this package itself (Node package self-reference
through `exports`).
