import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  MarketRegimeOutputSchema,
  REGIME_CREDIT_STALE_SECONDS,
  REGIME_DAILY_STALE_SECONDS,
  REGIME_GAMMA_PUSH_STALE_SECONDS,
  REGIME_INDEX_SYMBOLS,
  REGIME_RESEARCH_ONLY_NOTE,
} from "./contracts/market-regime.ts";
import { AGENT_API_KEY_PROCEDURE_PATHS } from "./server/handler.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";

describe("marketRegime contract", () => {
  it("registers GET /market-regime on appContract and in the agent read-key allowlists", () => {
    // oRPC keeps route metadata on the internal `~orpc` property and exports no public reader.
    const procedure: unknown = appContract.marketRegime.get;
    expect(
      typeof procedure === "object" &&
        procedure !== null &&
        "~orpc" in procedure
    ).toBe(true);
    const withMeta = procedure as Readonly<{
      "~orpc": Readonly<{
        route?: Readonly<{
          method?: string;
          operationId?: string;
          path?: string;
        }>;
      }>;
    }>;
    expect(withMeta["~orpc"].route).toMatchObject({
      method: "GET",
      operationId: "marketRegime.get",
      path: "/market-regime",
    });
    expect(AGENT_API_KEY_READ_PROCEDURES.has("marketRegime.get")).toBe(true);
    expect(AGENT_API_KEY_PROCEDURE_PATHS).toContain("marketRegime.get");
  });

  it("enforces strict 4-ETF output shape and rejects unknown keys or missing ETFs", () => {
    const basePillar = {
      ageSeconds: 120,
      asOf: "2026-11-20",
      detail: "OK",
      scope: "etf" as const,
      source: "market_daily_series",
      stale: false,
      staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
    };
    const makeRow = (symbol: (typeof REGIME_INDEX_SYMBOLS)[number]) => ({
      breadth90: {
        ...basePillar,
        armedOn: null,
        latestAdvPct: 55,
        latestDate: "2026-11-20",
        latestFinal: true,
        latestKind: "NEUTRAL" as const,
        latestUpPct: 52,
        scope: "market_wide" as const,
        sessionsLeft: null,
        signalState: "IDLE" as const,
        source: "breadth90",
        state: "idle" as const,
        strict: false,
      },
      credit: {
        ...basePillar,
        hyOas: 3.1,
        hyOasBps: 310,
        hyOasChange20dBps: -5,
        hyOasPct1y: 25,
        igOas: 0.9,
        scope: "market_wide" as const,
        source: "openbb_macro:HY_OAS",
        staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
        state: "calm" as const,
      },
      dealerGamma: {
        ...basePillar,
        callWall: symbol === "SPY" || symbol === "QQQ" ? 605 : null,
        flip: symbol === "SPY" || symbol === "QQQ" ? 590 : null,
        netGex: symbol === "SPY" || symbol === "QQQ" ? 1_000_000 : null,
        oiSession: symbol === "SPY" || symbol === "QQQ" ? "2026-11-20" : null,
        putWall: symbol === "SPY" || symbol === "QQQ" ? 580 : null,
        source:
          symbol === "SPY" || symbol === "QQQ" ? "market_context_gex" : "none",
        spot: symbol === "SPY" || symbol === "QQQ" ? 598 : null,
        spotVsFlip:
          symbol === "SPY" || symbol === "QQQ" ? ("above" as const) : null,
        staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
        state:
          symbol === "SPY" || symbol === "QQQ"
            ? ("positive" as const)
            : ("not_covered" as const),
        upstreamRegime:
          symbol === "SPY" || symbol === "QQQ" ? "dampened" : null,
      },
      hasStaleInputs: false,
      missingCount: 0,
      mixedDrivers: [],
      staleCount: 0,
      summary: "risk_on" as const,
      symbol,
      trend: {
        ...basePillar,
        close: 500,
        pctVsSma50: 2.1,
        pctVsSma200: 8.5,
        sessions: 252,
        sma50: 489.72,
        sma50AboveSma200: true,
        sma200: 460.83,
        state: "uptrend" as const,
      },
      volatility: {
        ...basePillar,
        atmIv30d: 0.16,
        etfVolIndex: 15.2,
        etfVolIndexId:
          symbol === "QQQ"
            ? ("VXN" as const)
            : symbol === "SPY"
              ? ("VIX" as const)
              : symbol === "IWM"
                ? ("RVX" as const)
                : ("VXD" as const),
        ivPercentile: 30,
        scope: "market_wide" as const,
        source: "openbb_vol_context",
        state: "calm" as const,
        termStructure: "contango" as const,
        vix: 15.2,
        vix3mVix6m: 0.95,
        vix9dVix: 0.91,
        vixVix3m: 0.88,
      },
    });

    const valid = {
      etfs: REGIME_INDEX_SYMBOLS.map(makeRow),
      generatedAt: "2026-11-22T18:00:00.000Z",
      overall: {
        missingPillarCount: 0,
        staleEtfs: [],
        stalePillarCount: 0,
        summary: "risk_on" as const,
      },
      researchOnlyNote: REGIME_RESEARCH_ONLY_NOTE,
    };

    expect(MarketRegimeOutputSchema.parse(valid).etfs).toHaveLength(4);
    expect(() =>
      MarketRegimeOutputSchema.parse({ ...valid, extraField: true })
    ).toThrow();
    expect(() =>
      MarketRegimeOutputSchema.parse({ ...valid, etfs: valid.etfs.slice(0, 3) })
    ).toThrow();
  });
});
