# ws-next-smoke

Builds the [browser funding-compare example](../ws-funding-compare-browser) with **Next 13.5 (webpack)**
and `transpilePackages: ["perp-cli"]` against an installed `perp-cli` — the setup a static Next.js
consumer uses. It is a required step of the 0.14.4 release gate (`node scripts/ws-gate/release-gate.mjs`
packs the tarball, installs it here in a temp copy and runs `next build`).

Manual run against a packed tarball:

```sh
pnpm build && pnpm pack                       # → perp-cli-<version>.tgz
cp -R examples /tmp/ws-examples && cd /tmp/ws-examples/ws-next-smoke
npm install && npm install /path/to/perp-cli-<version>.tgz
npx next build && npx next start              # http://localhost:3000
```

`pages/index.js` imports `startFundingCompare` statically, so `next build` also proves the library can be
evaluated during server prerendering (it touches no global at module load) and calls it in `useEffect`.
