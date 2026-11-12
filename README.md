# Pppercolator

A perps terminal with two modes. Real mode routes orders to Hyperliquid from the user's own
wallet. Paper mode runs a perps market in the browser on the unmodified
[Percolator](https://github.com/aeyakovenko/percolator) risk engine by Anatoly Yakovenko, compiled
to WebAssembly and marked to live prices. Independent project, not affiliated with him.

**Beta. Not audited.** Real mode sends orders to Hyperliquid from the user's own wallet; this
project never holds funds. The paper mode uses the Percolator engine, whose own README says:
"Educational research project. Not production ready. Not audited. Do not use with real funds."
No real funds touch that engine here.

Live at https://pppercolator.fun. Launchpad at https://launchpad.pppercolator.fun. Docs at https://docs.pppercolator.fun.

## Layout

- `engine/` is Percolator at commit `37cb14ee1436eaf3b7d97e1901b0dc1bf38f5311`, byte for byte.
  CI runs its own test suite on every change. Apache-2.0, see `NOTICE`.
- `sim/` is a thin wrapper. It holds the accounts, feeds prices and moves paper tokens.
  Every risk decision (margin, liquidation, fees, loss handling) is made by the engine.
- `launchpad/` is the launchpad site: a retro desktop game with a Pump.fun launch flow (beta).
- `docs/` is the docs site.
- `site/` is the deployed terminal build with its icons and share card.
- `web/index.src.html` is the terminal page. `__WASM__` is replaced with the base64 of the build.
- `hl/` is the Hyperliquid client (wallet connect, trading-only agent key, market orders), bundled by CI
  into `dist/hl.js` from pinned dependencies. `__HLJS__` in the page is replaced with that bundle.
- `dist/sim.wasm` is built by CI from the two directories above.

## Status

Working: deposits, trades, the 10x margin check, margin calls, fees to insurance, and three
solvency checks that hold across a 600-slot soak test with the market staying active.

Market setup (wrapper policy, not engine rules): each trader faces a dedicated house account.
When the engine certifies a trader below maintenance margin, the house closes the position
at the oracle price as an ordinary trade. If the engine refuses that, its own liquidation
runs in the keeper crank. An earlier setup with one shared house account locked markets
after every engine liquidation, because the engine blocks new risk on a side it has scaled
down until that side drains.

Prices, candles and funding rates: live from Hyperliquid's public info API (main perps for
crypto, the XYZ market for stock perps), with a random simulation as fallback. Not done: funding rates are zero and nothing is on chain.

$PPP on Pump.fun (`Ho7iohoM6UN96yoxzBNzz9aXZpNW3AyUVuEmBdAQpump`) was launched by the Pppercolator team.
It is a memecoin, gives no claim on this project, and is not connected to the Percolator author.

## Run the tests

```bash
cd sim && cargo test
```

Terminal, wallet-session and launch-flow tests (Node.js 22+, wallet and exchange calls are mocked):

```bash
npm ci --prefix hl --ignore-scripts --no-audit --no-fund
node --test web/tests/*.test.cjs hl/tests/*.test.mjs launchpad/tests/*.test.cjs
```

Not affiliated with or endorsed by the Percolator author.
