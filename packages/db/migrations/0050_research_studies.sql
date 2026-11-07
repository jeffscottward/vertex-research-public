CREATE TABLE "research_studies" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ran_on" date NOT NULL,
	"spec_ref" text NOT NULL,
	"summary" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_studies_fields_check" CHECK ("research_studies"."id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("research_studies"."id") <= 64 and length("research_studies"."spec_ref") between 1 and 300),
	CONSTRAINT "research_studies_summary_check" CHECK (jsonb_typeof("research_studies"."summary") = 'object' and octet_length("research_studies"."summary"::text) <= 262144 and "research_studies"."summary" ->> 'id' = "research_studies"."id" and "research_studies"."summary" ->> 'spec' = "research_studies"."spec_ref")
);
--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the research study repository uses
-- (reads for researchStudies.get, insert and update for `bun run vertex:research-studies:import`).
-- Studies are never deleted by the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "research_studies" TO "vertex_research";
  END IF;
END
$$;
--> statement-breakpoint
-- Seed: the ADX/RVOL filter study (docs/specs/research/adx-filter.md), run 2026-10-31 on public
-- daily and intraday prices. It was shipped as a JSON file in the web app until this migration.
-- ON CONFLICT DO NOTHING keeps a newer run that the import CLI already stored.
INSERT INTO "research_studies" ("id", "spec_ref", "ran_on", "summary")
VALUES (
  'adx-rvol-filters',
  'docs/specs/research/adx-filter.md',
  '2026-10-31',
  $study${
  "id": "adx-rvol-filters",
  "spec": "docs/specs/research/adx-filter.md",
  "ran": "2026-10-31",
  "daily": {
    "window": {
      "start": "2005-01-03",
      "end": "2026-10-30",
      "days": 5492,
      "secondHalfStart": "2015-11-30"
    },
    "universe": [
      "SPY",
      "QQQ",
      "IWM",
      "SOXX",
      "AAPL",
      "MSFT",
      "AMZN",
      "GOOGL",
      "JPM",
      "XOM",
      "JNJ",
      "PG",
      "WMT",
      "HD"
    ],
    "costBpsPerSide": 5,
    "trials": 13,
    "variants": [
      {
        "strategy": "sma_cross_20_50",
        "filter": "none",
        "sharpe": 0.7979,
        "sharpeHalves": [
          0.6791,
          0.9198
        ],
        "cagr": 0.0811,
        "maxDrawdown": 0.2231,
        "trades": 830,
        "tradesPerYear": 38.08,
        "deflatedProbability": 0.8507,
        "verdict": null
      },
      {
        "strategy": "sma_cross_20_50",
        "filter": "adx_above",
        "sharpe": 0.5486,
        "sharpeHalves": [
          0.3213,
          0.7735
        ],
        "cagr": 0.0263,
        "maxDrawdown": 0.1398,
        "trades": 309,
        "tradesPerYear": 14.18,
        "deflatedProbability": 0.4576,
        "verdict": "DROP (trade floor)"
      },
      {
        "strategy": "breakout_20",
        "filter": "none",
        "sharpe": 0.8512,
        "sharpeHalves": [
          0.6651,
          1.0444
        ],
        "cagr": 0.0668,
        "maxDrawdown": 0.1757,
        "trades": 1322,
        "tradesPerYear": 60.66,
        "deflatedProbability": 0.9017,
        "verdict": null
      },
      {
        "strategy": "breakout_20",
        "filter": "adx_above",
        "sharpe": 0.6597,
        "sharpeHalves": [
          0.4882,
          0.8305
        ],
        "cagr": 0.0406,
        "maxDrawdown": 0.1544,
        "trades": 952,
        "tradesPerYear": 43.68,
        "deflatedProbability": 0.6576,
        "verdict": "DROP (Sharpe not higher in both halves)"
      },
      {
        "strategy": "rsi2_dip",
        "filter": "none",
        "sharpe": 0.5944,
        "sharpeHalves": [
          0.5823,
          0.6061
        ],
        "cagr": 0.0262,
        "maxDrawdown": 0.0859,
        "trades": 2330,
        "tradesPerYear": 106.91,
        "deflatedProbability": 0.5421,
        "verdict": null
      },
      {
        "strategy": "rsi2_dip",
        "filter": "adx_below",
        "sharpe": 0.1953,
        "sharpeHalves": [
          0.0989,
          0.294
        ],
        "cagr": 0.0043,
        "maxDrawdown": 0.0716,
        "trades": 1038,
        "tradesPerYear": 47.63,
        "deflatedProbability": 0.0399,
        "verdict": "DROP (Sharpe not higher in both halves)"
      },
      {
        "strategy": "rsi2_dip",
        "filter": "adx_falling",
        "sharpe": 0.5185,
        "sharpeHalves": [
          0.5145,
          0.5231
        ],
        "cagr": 0.0182,
        "maxDrawdown": 0.0761,
        "trades": 1747,
        "tradesPerYear": 80.16,
        "deflatedProbability": 0.403,
        "verdict": "DROP (Sharpe not higher in both halves)"
      },
      {
        "strategy": "rsi14_dip",
        "filter": "none",
        "sharpe": 0.3152,
        "sharpeHalves": [
          0.4133,
          0.2777
        ],
        "cagr": 0.0057,
        "maxDrawdown": 0.0706,
        "trades": 119,
        "tradesPerYear": 5.46,
        "deflatedProbability": 0.1229,
        "verdict": null
      },
      {
        "strategy": "rsi14_dip",
        "filter": "adx_below",
        "sharpe": -0.0076,
        "sharpeHalves": [
          -0.1087,
          0.0614
        ],
        "cagr": -0.0001,
        "maxDrawdown": 0.0329,
        "trades": 22,
        "tradesPerYear": 1.01,
        "deflatedProbability": 0.0034,
        "verdict": "DROP (trade floor: the unfiltered strategy has fewer than 30 trades per year)"
      },
      {
        "strategy": "rsi14_dip",
        "filter": "adx_falling",
        "sharpe": 0.3467,
        "sharpeHalves": [
          0.3135,
          0.4071
        ],
        "cagr": 0.0023,
        "maxDrawdown": 0.0279,
        "trades": 20,
        "tradesPerYear": 0.92,
        "deflatedProbability": 0.1556,
        "verdict": "DROP (trade floor: the unfiltered strategy has fewer than 30 trades per year)"
      },
      {
        "strategy": "emt_daily",
        "filter": "none",
        "sharpe": -0.2573,
        "sharpeHalves": [
          0.0191,
          -0.5784
        ],
        "cagr": -0.0004,
        "maxDrawdown": 0.0142,
        "trades": 43,
        "tradesPerYear": 1.97,
        "deflatedProbability": 0.0001,
        "verdict": null
      },
      {
        "strategy": "emt_daily",
        "filter": "adx_below",
        "sharpe": 0.0839,
        "sharpeHalves": [
          0.1603,
          -0.0209
        ],
        "cagr": 0.0001,
        "maxDrawdown": 0.0028,
        "trades": 10,
        "tradesPerYear": 0.46,
        "deflatedProbability": 0.0092,
        "verdict": "DROP (trade floor: the unfiltered strategy has fewer than 30 trades per year)"
      },
      {
        "strategy": "emt_daily",
        "filter": "adx_falling",
        "sharpe": 0.0579,
        "sharpeHalves": [
          0.0257,
          0.1231
        ],
        "cagr": 0.0,
        "maxDrawdown": 0.0027,
        "trades": 9,
        "tradesPerYear": 0.41,
        "deflatedProbability": 0.006,
        "verdict": "DROP (trade floor: the unfiltered strategy has fewer than 30 trades per year)"
      }
    ]
  },
  "intraday": {
    "symbol": "SPY",
    "barMinutes": 5,
    "window": {
      "start": "2008-02-20",
      "end": "2021-05-06",
      "sessions": 3325,
      "secondHalfStart": "2014-09-30"
    },
    "costBpsPerSide": 1,
    "variants": [
      {
        "filter": "none",
        "sharpe": 0.0488,
        "sharpeHalves": [
          0.3066,
          -0.3063
        ],
        "cagr": -0.0034,
        "maxDrawdown": 0.5777,
        "trades": 3293,
        "tradesPerYear": 249.57
      },
      {
        "filter": "rvol_above_1",
        "sharpe": 0.1779,
        "sharpeHalves": [
          0.5803,
          -0.2888
        ],
        "cagr": 0.0133,
        "maxDrawdown": 0.3653,
        "trades": 1347,
        "tradesPerYear": 102.09
      }
    ],
    "verdict": "KEEP",
    "sensitivity": {
      "costBpsPerSide": 5,
      "verdict": "KEEP"
    },
    "spearman": {
      "firstHalf": 0.1063,
      "secondHalf": 0.1433
    }
  }
}$study$::jsonb
)
ON CONFLICT ("id") DO NOTHING;
