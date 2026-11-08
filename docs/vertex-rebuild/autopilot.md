# Autopilot

Updated: 2026-10-30. Research and paper hand-off only. Nothing in this feature creates, routes, arms or submits broker orders, and nothing requests live trading.

## Purpose

An Autopilot campaign breeds strategy definitions (see [strategy-definitions.md](strategy-definitions.md)) for one stored bar series without a person in the loop. It generates candidates from fixed building blocks, breeds the fittest (crossover and mutation), scores every candidate on the in-sample bars only, and sends the best candidates of each generation through a fixed verification gate. A candidate that passes the gate and its parameter-neighbourhood check is **Verified**. An operator can send a verified candidate to the existing paper deployment-request flow. The owner approves that request; Quant VPS operators arm it separately.

Autopilot uses the existing engine: every candidate is a strategy DSL definition that runs on `runSignalBacktest` through `runStrategyDefinition`. There is no second backtest engine.

## Parts

| Part | File |
| --- | --- |
| Genome, building blocks, crossover, mutation, parameter neighbours (pure) | `packages/api/src/autopilot-genome.ts` |
| One generation: tournament selection, crossover, mutation, immigrants (pure) | `packages/api/src/autopilot-breeding.ts` |
| In-sample fitness and the fixed gate (pure) | `packages/api/src/autopilot-gate.ts` |
| Nautilus paper config, library strategy, live-readiness checks (pure) | `packages/api/src/autopilot-handoff.ts` |
| oRPC contract `autopilot.campaigns.*`, `autopilot.candidates.*` | `packages/api/src/contracts/autopilot.ts` |
| Runner (one time slice of one campaign) | `packages/api/src/server/autopilot-runner.ts` |
| Procedures | `packages/api/src/server/autopilot.ts` |
| Tables `autopilot_campaigns`, `autopilot_candidates` | migration `0034_autopilot`, guarded rollback `packages/db/rollback/0034_autopilot.down.sql` |
| Repository (guarded lifecycle, trial ledger) | `packages/db/src/server/autopilot.ts` |
| Scheduler client and user units | `scripts/autopilot/tick.ts`, `bun run vertex:autopilot:tick`, `infra/autopilot/vertex-autopilot.{service,timer}` |
| Page `/autopilot` (Backtest lab) | `apps/web/src/app/(portal)/autopilot/`, `apps/web/src/components/portal/autopilot-workspace.tsx`, `autopilot-model.ts` |

## Building blocks

A genome has 1 to 3 entry genes (all must hold), 0 to 2 exit genes (any one exits), an optional stop and an optional target. Each gene is one block with parameters on a grid.

| Block | Role | Condition | Parameters |
| --- | --- | --- | --- |
| `trendSma`, `trendEma` | entry | close above SMA / EMA | length 20 to 250, step 10 |
| `emaCross` | entry | EMA crosses above SMA | fast 5 to 60 (step 5), slow 20 to 250 (step 10), fast < slow |
| `maStack` | entry | EMA above SMA | as `emaCross` |
| `rsiDip` | entry | RSI below level | length 2 to 21, level 5 to 45 (step 5) |
| `rsiMomentum` | entry | RSI above level | length 5 to 30, level 50 to 75 (step 5) |
| `breakout` | entry | close above the prior high | length 10 to 120, step 5 |
| `dip` | entry | close below the prior low | length 5 to 60, step 5 |
| `volExpansion` | entry | short ATR above long ATR | fast 3 to 20, slow 20 to 100 (step 5) |
| `exitBelowSma`, `exitBelowEma`, `exitAboveSma`, `exitLow`, `exitRsiHigh` | exit | close below SMA, close crosses below EMA, close above SMA, close below prior low, RSI above level | see the code |
| `stopPct`, `stopAtr` | stop | percent stop, ATR stop | 1 to 15% (step 0.5); ATR 5 to 30 times 1 to 6 |
| `targetPct`, `targetAtr` | target | percent target, ATR target | 2 to 40%; ATR 5 to 30 times 1 to 10 |

Sizing is all-in, long only, as in every DSL definition. Two genomes with the same genes in another order are the same candidate; a campaign stores each genome once.

## Campaign filters

`campaigns.create` takes optional entry filters that join every candidate definition. Autopilot loads sector rotation points and daily series (support `{series}` of `serverStrategyRefusal`): `ivRank`, `vixTermStructure`, `volRegime` and `series` filters are accepted. Each tick loads the series the filters read, resolved for the campaign symbol, from the series store (`packages/api/src/server/strategy-series.ts`), and every in-sample, gate, neighbour and engine-comparison run reads them; the Nautilus repeat loads the same series at claim. A missing series fails the campaign on its tick (`Tick failed: Series data is not available for <id>`). Options blocks are refused, and `calendarWindow` filters on an intraday timeframe too. The paper hand-off refuses definitions with series filters (`sendToPaper` returns `VALIDATION_ERROR`, the tearsheet shows no paper config). See [strategy-definitions.md](strategy-definitions.md#where-definitions-run).

## Breeding and fitness

- Generation 0 is random. Each later generation breeds `populationSize` new genomes from the `populationSize` fittest bred candidates of the campaign: tournament selection (3 entrants), crossover (70%, then mutation 35%), otherwise mutation, and 10% random immigrants. Refine neighbours are never parents: they exist only because their parent passed out-of-sample checks.
- **Fitness** is the annualized Sharpe ratio on the first 60% of the bars only, scaled down when the candidate has fewer than 15 in-sample trades. Breeding never sees the out-of-sample bars.
- Budgets: `maxCandidates` (trials per campaign), `maxCpuMinutes` (time spent in ticks), `tickSeconds` (work per tick call) and `gatePerGeneration`. A campaign completes when a budget is used up or breeding finds no new genomes.

## Verification gate (`autopilot-gate-v1`)

The gate runs the definition once over all bars (the engine is causal) and judges the last 40% of the bars. All checks must pass.

| Check | Rule |
| --- | --- |
| Out-of-sample Sharpe | annualized Sharpe ratio on the out-of-sample bars >= 0.5 |
| Forward folds | the out-of-sample period split into 3 consecutive folds; each fold has a positive net return (3 of 3). The parameters are fixed; nothing is re-optimized per fold |
| Monte Carlo | 1,000 bootstrap paths of the out-of-sample trade returns: P(profit) >= 0.8 and 5th-percentile drawdown >= -35% |
| Deflated Sharpe ratio | probability >= 0.95 for the in-sample Sharpe ratio, deflated for **every trial on the series** (all candidates of all campaigns on that symbol and timeframe, including neighbours) |
| Benjamini-Hochberg | q-value <= 0.05 over the same trials; trials outside the sampled 500 (and trials without return spread, such as genomes that never trade) count as p = 1 |
| Minimum trades | >= 30 trades in total and >= 8 out of sample |
| Costs | campaign cost >= 1 bps per side, and the out-of-sample Sharpe stays above 0 at 2x the cost |
| Parameter neighbourhood | refine step, only after every check above passed: each parameter moved about 10% down and up (at least one grid step), at most 12 neighbours. At least 75% of the neighbours must keep >= 50% of the candidate's out-of-sample Sharpe and stay above 0 |

The neighbours are stored as candidates (trials). The gate then runs again with the larger trial ledger, so the refine step cannot lower the multiple-testing bar. The deflated Sharpe ratio and Benjamini-Hochberg use `multipleTesting` from `packages/api/src/quant-multiple-testing.ts` with the ledger scope `autopilot`.

A verified candidate is a research result on past bars. It does not authorize a trade.

## Lifecycle

Campaign status is guarded in the repository with conditional updates: `running` <-> `stopped`, `running` -> `completed` (budget used up) or `failed` (invalid configuration, missing, too few or bad bars). `completed` and `failed` are final. A tick saves its progress only when the campaign is still running at the version it read, so a stop during a tick wins.

Candidate status: `evaluated` (in-sample only) -> `rejected` or `verified`.

## Hand-off to paper

`autopilot.candidates.sendToPaper` needs an operator session (API keys are refused) and a verified candidate without a paper request. It first checks what the paper request would refuse (the limits: `maxOrderSize` may not exceed `maxPosition`; the symbol and timeframe formats), so a refused hand-off writes nothing. A campaign on a futures symbol (`=F`, for example `ES=F`) is refused; for a Core 7 future the message names its ETF twin: futures are research signals only, and paper or live trades use options on the twin (owner rule 2026-11-03). Then it:

1. saves the definition as revision 1 of `autopilot-<candidate id>` in the strategy builder's saved definitions;
2. creates a library strategy (slug `autopilot-<candidate id>`, section "Autopilot", status `paper`, kind `external`) whose fixed parameters pin the definition id, its SHA-256, the candidate id and the Nautilus hand-off format;
3. creates a PAPER deployment request in the existing flow and submits it (status `requested`). The request carries the usual lock: `executionAuthorized: false`, `brokerSubmissionAllowed: false`, not dispatched.

The candidate page shows the Nautilus paper config (`vertex-nautilus-dsl-strategy-v1`): the definition, its SHA-256, the instrument and `armed: false`. The Quant VPS Nautilus adapter that runs DSL definitions is not deployed yet; until it is, the config is hand-off input only.

**Request live** shows the live-readiness checks: the gate, a paper record, the owner's options-only master rule (long-only DSL strategies hold the underlying, which that rule blocks for new live positions) and the owner's approval with password. Live is never allowed from Autopilot.

## Access

| Caller | Allowed |
| --- | --- |
| Operator session | every procedure |
| Operator agent API key, write access | `autopilot.campaigns.tick` only (the scheduler) |
| Read keys, other keys | nothing |

Other `autopilot.*` procedures are outside the agent-key scope list (`AGENT_API_KEY_PROCEDURE_ROOTS` plus the single path `AGENT_API_KEY_PROCEDURE_PATHS` in `packages/api/src/server/handler.ts`).

## Scheduler

Install the user timer (every minute) on the research host that runs the Vertex web app. A tick works for each running campaign's slice and never runs in a trading tick loop.

```sh
install -m 0600 /dev/null ~/.config/vertex/autopilot.env   # then add VERTEX_ORIGIN and VERTEX_AGENT_API_KEY (operator write key)
cp infra/autopilot/vertex-autopilot.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vertex-autopilot.timer
```

The page's **Run one tick now** button runs one slice with the operator session.

## Page

`/autopilot` (sidebar: Backtest lab):

1. **New campaign**: name, stored series, population, maximum candidates, CPU budget, tick slice, gated per generation, cost and an optional seed.
2. **Campaigns**: status, generation, candidates and verified counts. Select one to see its budget use, the trials on the series, the leaderboard (best in-sample fitness) and the gated candidates. A running campaign refreshes every 5 seconds.
3. **Candidate tearsheet**: equity curve with the out-of-sample split, in-sample and out-of-sample metrics, the gate checklist, parents and children, the definition JSON, the Nautilus paper config, **Run full backtest** (a backtest run of the definition), **Send to paper** and **Request live**.

## Tests

- Genome, breeding and gate: `packages/api/src/autopilot-genome.test.ts`, `autopilot-breeding.test.ts`, `autopilot-gate.test.ts` (a robust candidate passes as the only trial and fails the deflated Sharpe ratio as one of 1,000,000 trials).
- Procedures, runner, hand-off and key scope: `packages/api/src/autopilot.test.ts`, `packages/api/src/agent-api-keys.test.ts`.
- Broker isolation (import graph): `packages/api/src/autopilot-isolation.test.ts`.
- Repository: `packages/db/src/server/autopilot.test.ts`; real Postgres: `tests/integration/database/autopilot.test.ts`.
- Page: `apps/web/src/components/portal/autopilot-workspace.test.tsx`; browser flow: `tests/e2e/autopilot.spec.ts`.

## Limits

- One series per campaign, at least 500 bars (the longest block indicator, 250 bars, must fit into the in-sample part). Long only, all-in sizing, next-open fills, flat cost per side (the engine model of the instant backtest).
- Bad stored data (for example bar times that do not increase) marks the campaign `failed` with the reason. Any other tick error (for example a short database outage) records a note and the tick time; the next tick retries. One broken campaign never blocks the others. When a stop or a second tick saves first, the tick reports the stored status and its CPU time is not added.
- Forward folds use fixed parameters; they are not a re-optimizing walk-forward.
- The deflated Sharpe ratio uses a sample of the newest 500 other trials to estimate the variance of Sharpe ratios across trials; the trial count itself is exact.
- The out-of-sample window is reused: every gated candidate of every campaign on a series is judged on the same last 40% of the bars. The deflated Sharpe ratio corrects for in-sample selection only. A second ledger of gate attempts (a deflated out-of-sample Sharpe) is not built yet.
- Behaviour clones: genes that never bind (for example a long trend filter under a stricter one) give genomes with identical trades. They are distinct genomes, so each is a trial and may be gated again. A behaviour fingerprint is not built yet; the trial count stays conservative.
- The campaign lifecycle is guarded with conditional updates in the repository (the existing Vertex pattern of deployment requests and the paper runner), not with an XState machine in `packages/state`.
- On a short or trending series many random strategies have high in-sample Sharpe ratios. Their spread raises the expected maximum Sharpe ratio, so the deflated Sharpe check rejects most of them. Zero verified candidates is an expected and honest result.
