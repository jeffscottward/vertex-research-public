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

Vertex has no history of the gamma flip level (`flow_gex` keeps 14 days). The definitions use a named
price-level proxy: the 20-day SMA of the closes before the signal bar. Results describe the proxy rule,
not a gamma-flip rule.

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

## Runs

QQQ, timeframe 1d, initial capital 100,000, costBps 0, stop and target 0 (the options book has its own
costs and exits). Window A: 2022-11-10 to 2026-11-20. Window B: 2001-11-01 to 2026-11-20.

## Forward test (registered 2026-11-22)

The rule with the real gamma flip becomes testable when a daily QQQ flip history exists
(`openbb_option_iv_daily.gamma_flip`, card vertex-gamma-flip-sources). Evaluate the same definitions with
condition 1 and 2 on that flip instead of the SMA20 proxy, with the decision rule D5 of the design, when 30
signals exist or on 2027-11-22, whichever is later.

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
