"use client";

// Quant-method sections of the backtest detail: significance, multiple testing,
// volatility clustering and the pairs research lens. All values are research display only.

import type { BacktestGetOutput } from "@darkfactory/api";

import {
  cell,
  DASH,
  Empty,
  headCell,
  num,
  numCell,
  pct,
  SectionTitle,
  Stat,
  StatGrid,
} from "./backtest-analytics-panels.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@darkfactory/ui";

type Analytics = BacktestGetOutput["backtest"]["analytics"];

// p-values below 0.001 show as "<0.001".
export const formatPValue = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return DASH;
  return value < 0.001 ? "<0.001" : value.toFixed(3);
};

const pTone = (value: number): string =>
  value < 0.05 ? "text-success-foreground" : "";

const TestRow = ({
  label,
  estimate,
  lower,
  upper,
  statistic,
  pValue,
}: {
  readonly label: string;
  readonly estimate: string;
  readonly lower: string;
  readonly upper: string;
  readonly statistic: string;
  readonly pValue: number;
}) => (
  <TableRow className="border-border border-b" data-test-row={label}>
    <TableHead className={cn("h-auto whitespace-normal", headCell)} scope="row">
      {label}
    </TableHead>
    <TableCell className={cn("whitespace-normal", numCell)}>
      {estimate}
    </TableCell>
    <TableCell className={cn("whitespace-normal", numCell)}>
      {lower} to {upper}
    </TableCell>
    <TableCell className={cn("whitespace-normal", numCell)}>
      {statistic}
    </TableCell>
    <TableCell className={`whitespace-normal ${numCell} ${pTone(pValue)}`}>
      {formatPValue(pValue)}
    </TableCell>
  </TableRow>
);

export const SignificancePanel = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  const { tTest, stationaryBootstrap } = analytics.significance;
  return (
    <section
      aria-labelledby="backtest-significance-heading"
      className="space-y-2"
    >
      <SectionTitle
        help="H0: the true mean return (or Sharpe ratio) is zero or below. p-values are one-sided. The stationary bootstrap (Politis and Romano 1994) resamples blocks of random geometric length, so it keeps short-range dependence. Its p-value comes from the centred bootstrap distribution."
        id="backtest-significance-heading"
      >
        Significance of returns
      </SectionTitle>
      {tTest === null && stationaryBootstrap === null ? (
        <Empty>Needs at least three equity returns with some variation.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <Table
            containerClassName="overflow-visible"
            className="w-full text-xs"
            data-significance
          >
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground">
                <TableHead
                  className={cn("text-muted-foreground", headCell)}
                  scope="col"
                >
                  Test
                </TableHead>
                <TableHead
                  className={`text-muted-foreground ${headCell} text-right`}
                  scope="col"
                >
                  Estimate
                </TableHead>
                <TableHead
                  className={`text-muted-foreground ${headCell} text-right`}
                  scope="col"
                >
                  95% interval
                </TableHead>
                <TableHead
                  className={`text-muted-foreground ${headCell} text-right`}
                  scope="col"
                >
                  Statistic
                </TableHead>
                <TableHead
                  className={`text-muted-foreground ${headCell} text-right`}
                  scope="col"
                >
                  p-value
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tTest === null ? null : (
                <TestRow
                  estimate={pct(tTest.mean, 3)}
                  label="t-test, mean return per period"
                  lower={pct(tTest.ciLower, 3)}
                  pValue={tTest.pValue}
                  statistic={`t = ${num(tTest.t)} (df ${tTest.df})`}
                  upper={pct(tTest.ciUpper, 3)}
                />
              )}
              {stationaryBootstrap === null ? null : (
                <>
                  <TestRow
                    estimate={pct(stationaryBootstrap.mean.estimate, 3)}
                    label="Stationary bootstrap, mean return per period"
                    lower={pct(stationaryBootstrap.mean.ciLower, 3)}
                    pValue={stationaryBootstrap.mean.pValue}
                    statistic={`mean block ${stationaryBootstrap.expectedBlockLength}`}
                    upper={pct(stationaryBootstrap.mean.ciUpper, 3)}
                  />
                  {stationaryBootstrap.sharpe === null ? null : (
                    <TestRow
                      estimate={num(stationaryBootstrap.sharpe.estimate)}
                      label="Stationary bootstrap, Sharpe (ann.)"
                      lower={num(stationaryBootstrap.sharpe.ciLower)}
                      pValue={stationaryBootstrap.sharpe.pValue}
                      statistic={`${stationaryBootstrap.resamples} resamples`}
                      upper={num(stationaryBootstrap.sharpe.ciUpper)}
                    />
                  )}
                </>
              )}
            </TableBody>
          </Table>
          {tTest === null ? null : (
            <p className={`${cell} text-muted-foreground text-xs`}>
              Two-sided t-test p-value: {formatPValue(tTest.pValueTwoSided)}.
            </p>
          )}
        </div>
      )}
    </section>
  );
};

export const MultipleTestingPanel = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  const result = analytics.multipleTesting;
  if (result === null)
    return (
      <Empty>
        Multiple-testing results need the trial ledger, which this view did not
        load.
      </Empty>
    );
  const { ledger, deflatedSharpe: dsr, benjaminiHochberg: bh } = result;
  const scope =
    ledger.scope === "strategy"
      ? "results recorded for this strategy"
      : "results recorded for this ledger task (no strategy link)";
  return (
    <section
      aria-labelledby="backtest-multiple-testing-heading"
      className="space-y-2"
      data-multiple-testing={ledger.scope}
    >
      <SectionTitle
        help={`Trials are all ${scope}: ${ledger.trials}. The Sharpe variance and the Benjamini-Hochberg set use the newest ${ledger.sampled} (including this one); ${ledger.usableTrials} have usable returns. One trial means no deflation: the deflated Sharpe then equals the probabilistic Sharpe against zero.`}
        id="backtest-multiple-testing-heading"
      >
        Multiple testing
      </SectionTitle>
      <StatGrid
        label="Multiple-testing statistics"
        columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Stat label="Trials" value={String(ledger.trials)} />
        <Stat
          help="Bailey and Lopez de Prado (2014): probability that the true Sharpe ratio exceeds the expected maximum Sharpe of the same number of unskilled trials."
          label="Deflated Sharpe"
          value={dsr === null ? DASH : pct(dsr.probability, 1)}
        />
        <Stat
          help="Expected maximum Sharpe ratio per period of the trials if none had skill."
          label="Expected max Sharpe"
          value={dsr === null ? DASH : num(dsr.expectedMaxSharpe, 4)}
        />
        <Stat
          label="Sharpe per period"
          value={dsr === null ? DASH : num(dsr.sharpe, 4)}
        />
        <Stat
          help={`Benjamini-Hochberg false discovery rate across the ${bh?.tested ?? 0} usable trials. A q-value at or below ${bh?.alpha ?? 0.05} is a discovery.`}
          label="Benjamini-Hochberg q"
          value={formatPValue(bh?.qValue)}
        />
        <Stat
          label="Discoveries (5% FDR)"
          value={bh === null ? DASH : `${bh.discoveries} of ${bh.tested}`}
        />
      </StatGrid>
      {result.deflatedSharpeReason === null ? null : (
        <Empty>Deflated Sharpe: {result.deflatedSharpeReason}</Empty>
      )}
      {result.benjaminiHochbergReason === null ? null : (
        <Empty>Benjamini-Hochberg: {result.benjaminiHochbergReason}</Empty>
      )}
    </section>
  );
};

export const VolatilityPanel = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  const { ljungBoxSquared: lb, garch, garchReason } = analytics.volatility;
  return (
    <section
      aria-labelledby="backtest-volatility-heading"
      className="space-y-2"
      data-volatility
    >
      <SectionTitle
        help="Ljung-Box tests for autocorrelation in squared returns (H0: none). A small p-value means volatility clusters. GARCH(1,1) is a Gaussian maximum-likelihood fit with variance targeting. The forecasts are research display only and are not a sizing input."
        id="backtest-volatility-heading"
      >
        Volatility clustering
      </SectionTitle>
      <StatGrid
        label="Volatility clustering statistics"
        columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Stat
          help={
            lb === null
              ? "Needs at least 20 returns with variation."
              : `Q over ${lb.lags} lags, ${lb.n} squared returns.`
          }
          label="Ljung-Box Q (squared)"
          value={lb === null ? DASH : num(lb.q)}
        />
        <Stat label="Ljung-Box p" value={formatPValue(lb?.pValue)} />
        <Stat
          label="GARCH α"
          value={garch === null ? DASH : num(garch.alpha, 4)}
        />
        <Stat
          label="GARCH β"
          value={garch === null ? DASH : num(garch.beta, 4)}
        />
        <Stat
          help="α + β. Values near 1 mean volatility shocks fade slowly."
          label="Persistence"
          value={garch === null ? DASH : num(garch.persistence, 4)}
        />
        <Stat
          help="Periods until a volatility shock has decayed by half."
          label="Shock half-life"
          value={
            garch === null ? DASH : `${num(garch.halfLifePeriods, 1)} periods`
          }
        />
        <Stat
          help="Annualized with the observed periods per year."
          label="Long-run vol (ann.)"
          value={garch === null ? DASH : pct(garch.longRunVolAnnual)}
        />
        <Stat
          help="Annualized with the observed periods per year."
          label="Next-period vol (ann.)"
          value={garch === null ? DASH : pct(garch.nextPeriodVolAnnual)}
        />
        <Stat
          help="Average forecast variance over the horizon, annualized."
          label={`${garch?.horizonPeriods ?? 21}-period vol (ann.)`}
          value={garch === null ? DASH : pct(garch.horizonVolAnnual)}
        />
      </StatGrid>
      {garchReason === null ? null : <Empty>GARCH: {garchReason}</Empty>}
      {garch === null || garch.converged ? null : (
        <Empty>
          GARCH: the optimizer did not converge from every starting point. Treat
          the parameters with care.
        </Empty>
      )}
      <Empty>
        Research display only. The volatility forecast is available for options
        sizing studies; it does not size any order.
      </Empty>
    </section>
  );
};

type Metrics = BacktestGetOutput["backtest"]["metrics"];

const metricNumber = (metrics: Metrics, key: string): number | null => {
  const value = metrics[key];
  return typeof value === "number" ? value : null;
};

// Pairs research lens (services/research/strategies/pairs.py). Its diagnostics arrive as
// agent-reported `pair.*` metrics; the panel renders only when they exist.
export const PairsLensPanel = ({ metrics }: { readonly metrics: Metrics }) => {
  const keys = Object.keys(metrics).filter((key) => key.startsWith("pair."));
  if (keys.length === 0) return null;
  const value = (key: string) => metricNumber(metrics, key);
  const pValue = value("pair.adf_p");
  const legs = metrics["pair.legs"];
  return (
    <section
      aria-labelledby="backtest-pairs-heading"
      className="space-y-2"
      data-pairs-lens
    >
      <SectionTitle
        help="Engle-Granger test on the formation window: OLS hedge ratio, then an ADF test (no constant, AIC lag choice) on the spread with MacKinnon p-values. H0: no cointegration. Half-life comes from an AR(1) fit of the spread. Trading uses z-scores after the formation window with next-bar fills and costs. Agent-reported research output."
        id="backtest-pairs-heading"
      >
        Pairs lens{typeof legs === "string" ? `: ${legs}` : ""}
      </SectionTitle>
      <StatGrid
        label="Pairs lens diagnostics"
        columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Stat label="Hedge ratio" value={num(value("pair.hedge_ratio"), 4)} />
        <Stat
          help={`5% critical value: ${num(value("pair.crit_5pct"), 3)}.`}
          label="ADF t (spread)"
          value={num(value("pair.adf_t"), 3)}
        />
        <Stat label="Engle-Granger p" value={formatPValue(pValue)} />
        <Stat
          label="Half-life"
          value={
            value("pair.half_life_bars") === null
              ? "no reversion"
              : `${num(value("pair.half_life_bars"), 1)} bars`
          }
        />
        <Stat
          label="Entry / exit / stop z"
          value={`${num(value("pair.entry_z"))} / ${num(value("pair.exit_z"))} / ${num(value("pair.stop_z"))}`}
        />
        <Stat
          help="Basis points of traded notional per leg, per fill."
          label="Costs (bps)"
          value={num(value("pair.cost_bps"))}
        />
        <Stat
          label="Formation bars"
          value={num(value("pair.formation_bars"), 0)}
        />
        <Stat label="Z lookback" value={num(value("pair.lookback"), 0)} />
        <Stat label="Round trips" value={num(value("pair.round_trips"), 0)} />
      </StatGrid>
      <Empty>
        {pValue === null
          ? "No Engle-Granger p-value reported."
          : pValue < 0.05
            ? "Cointegrated at the 5% level in the formation window."
            : "Not cointegrated at the 5% level in the formation window: treat the spread backtest as unsupported."}{" "}
        Research only.
      </Empty>
    </section>
  );
};
