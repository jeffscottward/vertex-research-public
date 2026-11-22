# Bearish put-spread rule, SMA20 proxy (research definition)

Research only. A backtest of these definitions does not authorize a trade. Nothing here arms trading,
places orders or changes risk settings.

## Source

- Market consult of 2026-11-19, section 3 "Prepared bearish trade" (owner request; report on the rig at
  `~/Documents/reports/web/vertex-consult-short-platform/`).
- Design and method decisions: [design.md](../../vertex-rebuild/designs/bearish-put-spread/design.md)
  (decision record D1-D9, decided from the trading knowledge bases).
- Code: `services/research/strategies/qc_ports/bearish_put.py` (the definitions below; a test keeps them
  equal).

## Rule of the consult

Check near 15:45 New York, all four on one session:

1. QQQ traded at or above the dealer gamma flip level that day.
2. QQQ closes below the flip, at most 2% below it.
3. The day is not a heavy down-volume day (NYSE up-volume above 20%).
4. The re-struck spread costs 30% of its width or less.

Structure: long put near delta -0.40 to -0.45, short put near delta -0.25, monthly expiry 45 to 60 days
out. After entry, close when QQQ closes back above its 200-day average. Owner exit rule: a spread in
profit may run to expiry; a spread at a loss is closed 3 trading days before expiry.

## Rule as tested (SMA20 proxy)

Vertex has no history of the gamma flip level before 2026-11-16 (`flow_gex` kept 14 days until
2026-11-22). The definitions use a named price-level proxy: the 20-day SMA of the closes before the signal
bar. Results describe the SMA20 proxy rule, not a gamma-flip rule. The proxy study is worth doing before
flip data exists because it tests the part of the rule that price data can test (a failed rally back
below a nearby level, traded with this spread and these exits) and gives the baseline against which a
real-flip test will be judged.

| Rule part | Definition |
| --- | --- |
| 1. Traded at or above the level | `high >= sma(20)[1]` |
| 2. Closed below, at most 2% below | `close < sma(20)[1]` and `close >= 0.98 * sma(20)[1]` |
| 3. Not a heavy down-volume day | filter: series `NYSE_UPVOL_PCT` above 20 (window A only; the series starts 2022-11-10) |
| 4. Cost at most 30% of width | not tested: the model's cost per width stays between 25% and 29% at these deltas |
| Structure | `putDebitVertical`, dte target 52 (minimum 45), longDelta 0.425, widthSigma 0.6 (short leg near delta 0.23 to 0.25), maxLossPct 2 |
| Exit signal | `close crossesAbove sma(200)` |
| Owner exit | `exitDte` 3 (every spread closes 3 calendar days before expiry) or none (held to expiry); the event study applies the exact owner rule |
| Baseline | the same options block and exit, entry on every bar |

The engine trades a signal at the next session's close (no look-ahead); the consult enters on the signal
session.

## Backtest design (fixed 2026-11-22; amended after the first run, see Deviations)

- **Stored runs** (equity and drawdown; one spread at a time): QQQ, timeframe 1d, initial capital
  100,000, costBps 0, stop and target 0 (the options book has its own costs and exits). Window A:
  2022-11-10 to 2026-11-20 (`RULE_EXIT3`, `RULE_EXPIRY`, `BASELINE`). Window B: 2001-11-01 to 2026-11-20
  (`PROXY_EXIT3`, `BASELINE`).
- **Event study** (the edge test; `python -m strategies.qc_ports bearish-put-study ROWS.json`, module
  `strategies/qc_ports/bearish_put_study.py`): every signal bar priced as its own spread by the runner's
  book under the exact owner exit (closed at the exitDte-3 close when worth less than its entry price,
  else held to expiry); return on risk = P&L after fees / max loss per contract; baseline = the same spread
  opened on every bar of the window; block bootstrap of the difference in mean return on risk (blocks of
  60 sessions, 10,000 resamples, seed 20261122); out-of-sample from 2025-09-01 (window A) and 2019-01-01
  (window B); sensitivity with ATM IV ±4 vol points and skew slope ±0.1; Monte Carlo drawdown of the
  independent trades at 2% of equity at risk per trade.
- **Input rows:** `market_daily_points` (QQQ, SPY, VXN, IRX) and final `breadth90_days` rows, exported
  read-only from the live database in the shape `backtestRuns.engine.claim` gives; the report records
  their SHA-256.

## Pass/fail rule (fixed 2026-11-22)

Pass only when all hold in window B: at least 30 independent signals (taken one at a time); mean return
on risk of the rule minus the baseline above 0 with the bootstrap 95% interval above 0; the out-of-sample
difference above 0; a pass under all four sensitivity cases. Fewer than 30 independent signals: "not
proven". Otherwise "no edge shown". Window A is descriptive. Win rate is reported, not a criterion.

## Deviations

- The first draft of the rule used blocks of 20 sessions and counted every signal. A fresh-context reviewer
  who had not seen any result showed that both make the test too lenient, and the rule above replaced it.
  The first study run (2026-11-22, 11:03 New York) under the first draft gave "no edge shown" for both
  windows; that run is recorded in the job report.
- The engine and the study enter one session after the signal; the consult enters on the signal session.
- `exitDte` counts calendar days; the owner rule counts trading days.
- Code review (2026-11-22): a signal whose spread expires after the last bar is left out (counted as
  truncated), decided by expiry and not by the exit, so the kept sample does not depend on the outcome.
  The study's `verdict` field applies the all-four-sensitivity-cases condition since the follow-up change.

## Results (event study, 2026-11-22, code at 2d3fc6bd)

| Window | Signals | Independent | Rule minus baseline (points of max loss) | 95% interval | Out of sample | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| A, breadth, 2022-11-10 to 2026-11-20 | 59 | 17 | +8.7 | -19.5 to +41.9 | -22.4 | not proven |
| B, no breadth, 2001-11-01 to 2026-11-20 | 481 | 131 | -1.1 | -11.0 to +8.9 | +2.0 | no edge shown |

Every sensitivity case (ATM IV ±4 points, skew ±0.1) gives the same verdicts. A QQQ put debit spread lost
on average in both windows, with or without the rule (window B mean return on risk: rule -27.2%,
baseline -26.0%). The minimum of 30 independent signals follows the DeltaTrend answer; the macro answer
and the master rule `fabio-valentini:wisdom:7` ask for about 100. Window B has 131, so the verdict is the
same under either minimum. Full output, input digest and the knowledge-base answers: job report on the
rig (`~/Documents/reports/web/vertex-bearish-put-spread-backtest/`).

## Forward test (registered 2026-11-22)

`flow_gex` keeps 730 days since the web deploy of `81a4dcaa` (2026-11-22, 18:57 UTC), so the QuantData gamma flip of every session is stored from
2026-11-16 on. Evaluate the same definitions with conditions 1 and 2 on that flip (the flip of the last
`flow_gex` row at or before 15:45 New York) instead of the SMA20 proxy, with the pass/fail rule above, when
30 independent signals exist or on 2027-11-22, whichever is later. Do not pool it with the OpenBB flip
(`openbb_option_iv_daily.gamma_flip`), which uses another definition.

## Definitions

### RULE_EXIT3

Runs: window A (2022-11-10 to 2026-11-20).

```json
{
  "name": "Bearish put spread, SMA20 proxy, breadth, exitDte 3",
  "version": 1,
  "entry": {
    "all": [
      {
        "left": {
          "type": "price",
          "field": "high"
        },
        "op": ">=",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 20,
          "source": "close",
          "offset": 1
        }
      },
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "<",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 20,
          "source": "close",
          "offset": 1
        }
      },
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": ">=",
        "right": {
          "type": "math",
          "op": "mul",
          "left": {
            "type": "indicator",
            "name": "sma",
            "length": 20,
            "source": "close",
            "offset": 1
          },
          "right": {
            "type": "const",
            "value": 0.98
          }
        }
      }
    ]
  },
  "options": {
    "structure": "putDebitVertical",
    "dte": {
      "target": 52,
      "min": 45
    },
    "longDelta": 0.425,
    "widthSigma": 0.6,
    "maxLossPct": 2,
    "exitDte": 3
  },
  "exit": {
    "any": [
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "crossesAbove",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 200,
          "source": "close"
        }
      }
    ]
  },
  "filters": [
    {
      "type": "series",
      "series": "NYSE_UPVOL_PCT",
      "condition": {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": ">",
        "right": {
          "type": "const",
          "value": 20
        }
      }
    }
  ]
}
```

### RULE_EXPIRY

Runs: window A.

```json
{
  "name": "Bearish put spread, SMA20 proxy, breadth, to expiry",
  "version": 1,
  "entry": {
    "all": [
      {
        "left": {
          "type": "price",
          "field": "high"
        },
        "op": ">=",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 20,
          "source": "close",
          "offset": 1
        }
      },
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "<",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 20,
          "source": "close",
          "offset": 1
        }
      },
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": ">=",
        "right": {
          "type": "math",
          "op": "mul",
          "left": {
            "type": "indicator",
            "name": "sma",
            "length": 20,
            "source": "close",
            "offset": 1
          },
          "right": {
            "type": "const",
            "value": 0.98
          }
        }
      }
    ]
  },
  "options": {
    "structure": "putDebitVertical",
    "dte": {
      "target": 52,
      "min": 45
    },
    "longDelta": 0.425,
    "widthSigma": 0.6,
    "maxLossPct": 2
  },
  "exit": {
    "any": [
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "crossesAbove",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 200,
          "source": "close"
        }
      }
    ]
  },
  "filters": [
    {
      "type": "series",
      "series": "NYSE_UPVOL_PCT",
      "condition": {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": ">",
        "right": {
          "type": "const",
          "value": 20
        }
      }
    }
  ]
}
```

### PROXY_EXIT3

Runs: window B (2001-11-01 to 2026-11-20).

```json
{
  "name": "Bearish put spread, SMA20 proxy, no breadth, exitDte 3",
  "version": 1,
  "entry": {
    "all": [
      {
        "left": {
          "type": "price",
          "field": "high"
        },
        "op": ">=",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 20,
          "source": "close",
          "offset": 1
        }
      },
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "<",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 20,
          "source": "close",
          "offset": 1
        }
      },
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": ">=",
        "right": {
          "type": "math",
          "op": "mul",
          "left": {
            "type": "indicator",
            "name": "sma",
            "length": 20,
            "source": "close",
            "offset": 1
          },
          "right": {
            "type": "const",
            "value": 0.98
          }
        }
      }
    ]
  },
  "options": {
    "structure": "putDebitVertical",
    "dte": {
      "target": 52,
      "min": 45
    },
    "longDelta": 0.425,
    "widthSigma": 0.6,
    "maxLossPct": 2,
    "exitDte": 3
  },
  "exit": {
    "any": [
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "crossesAbove",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 200,
          "source": "close"
        }
      }
    ]
  }
}
```

### BASELINE

Runs: windows A and B.

```json
{
  "name": "Bearish put spread baseline, every bar, exitDte 3",
  "version": 1,
  "entry": {
    "all": [
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": ">",
        "right": {
          "type": "const",
          "value": 0
        }
      }
    ]
  },
  "options": {
    "structure": "putDebitVertical",
    "dte": {
      "target": 52,
      "min": 45
    },
    "longDelta": 0.425,
    "widthSigma": 0.6,
    "maxLossPct": 2,
    "exitDte": 3
  },
  "exit": {
    "any": [
      {
        "left": {
          "type": "price",
          "field": "close"
        },
        "op": "crossesAbove",
        "right": {
          "type": "indicator",
          "name": "sma",
          "length": 200,
          "source": "close"
        }
      }
    ]
  }
}
```
