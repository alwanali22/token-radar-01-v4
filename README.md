# Token Radar 01 — radar-5 (v4)

Ranks pre-token protocols by model-implied value using a size-fitted multiple
with one infra intercept.

## Model

`implied_value_usd = round(TVL * 10^(intercept + slope * log10(TVL) + infra * [infra]))`

The three coefficients are fitted at run time from the snapshot's own 128
live tokens (n=128, intercept 3.31, slope -0.53, infra +0.47, t = 2.3). The
fitted multiple is clamped to [0.02, 0.80]. [infra] is 1 for chains,
exchanges, bridges, prediction markets, CeDeFi and governance-incentives
protocols — categories where TVL is not the product, so TVL understates the
footprint — and 0 otherwise. Live infra tokens trade at a 2.94x premium at
the same TVL.

Five-fold backtest median error is 0.46 in log10 (2.9x) for the infra model,
against 0.55 (3.6x) for a single size curve and 0.73 (5.4x) for a flat
median multiple. Growth and age were tested as regressors and rejected
(fitted growth -1.6, t = -1.6; fitted age -0.17, t = -0.5; adding either
hurts out-of-sample error). No pre-token discount is applied: the snapshot
holds no pair from which one could be fitted.

The board holds 197 rows: the 40 watchlist protocols plus 157 early ones.
145 pre-token protocols are excluded as wrapped, bridged, staked or
exchange products of tokens that already trade, including Cross Chain
Bridge (Circle Gateway bridges USDC, a token that already trades).

## Farm plans

Each row carries 6 farm steps in a shape written for its category family
(lending, dexes, risk curators, RWA, CDP, prediction markets, chains and
more), each step naming a concrete cost and time. Steps use only snapshot
fields plus how that category works in general — no invented token names,
minimums, URLs, yields or points programs.

## Run

`mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`

Writes `board.json`, `data.js`, `dashboard/` and `screenshots/` to the
output dir plus `dossier.json` (built with `buildDossier` from
`vendor/makefun-board.ts`).

## Verify

The page refits the model live from the 128 live tokens and recomputes
every row's implied value; the line above the table reports the agreement
(197/197). The model panel fits the model and runs the backtest live, so
the numbers in the research note are the page's own output.
