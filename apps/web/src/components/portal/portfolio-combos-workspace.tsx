"use client";

import {
  type ApiClient,
  BACKTEST_COMBO_SLOTS_MAX,
  type BacktestCombo,
  type BacktestComboInput,
  type BacktestRunSummary,
  createApiClient,
} from "@darkfactory/api";
import {
  backtestUniverse,
  DEFAULT_BACKTEST_UNIVERSE_ID,
} from "@darkfactory/shared/universes";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  cacheKey,
  createResultCache,
  currentSearch,
  readListParam,
  useDebouncedValue,
  writeQuery,
} from "./backtest-lab-query.ts";
import { describeMarketDataFailure } from "./market-data-client.ts";

// Portfolio combos: pick finished backtest runs, give each a weight of one shared deposit and read
// the combined equity, drawdown overlap, return correlation and a robust/degrading verdict per slot.
// Each slot is pinned to its run's strategy revision. Research only; no order path.
// The page opens with a default set of runs already combined. The chosen runs live in the URL
// (`?runs=id,id`). Changes re-combine after a short pause; repeat requests come from a cache.

export interface PortfolioCombosGateway {
  readonly combine: (input: BacktestComboInput) => Promise<BacktestCombo>;
  readonly list: () => Promise<readonly BacktestRunSummary[]>;
}

export const createPortfolioCombosGateway = (
  client: ApiClient
): PortfolioCombosGateway => ({
  combine: (input) => client.backtestRuns.combine(input),
  list: async () => (await client.backtestRuns.list({ limit: 100 })).runs,
});

/** Builds the API client on each call, so server rendering never reads `window`. */
export const createBrowserPortfolioCombosGateway =
  (): PortfolioCombosGateway => {
    const current = () =>
      createPortfolioCombosGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
    return {
      combine: (input) => current().combine(input),
      list: () => current().list(),
    };
  };

const CHART_WIDTH = 960;
const CHART_HEIGHT = 240;

const money = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});
const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
const ratio = (value: number | null): string =>
  value === null ? "n/a" : value.toFixed(2);

const ruleLabel = (rule: BacktestRunSummary["spec"]["rule"]): string => {
  if (rule.kind === "smaCross") return `SMA ${rule.fast}/${rule.slow}`;
  if (rule.kind === "breakout")
    return `Breakout ${rule.entryLookback}/${rule.exitLookback}`;
  if (rule.kind === "academy") return `Academy ${rule.structure}`;
  return `Definition ${rule.definition.name}`;
};

export const describeRun = (run: BacktestRunSummary): string => {
  const rule = ruleLabel(run.spec.rule);
  const name =
    run.strategySnapshot === null ? "" : `${run.strategySnapshot.name} `;
  return `${name}${run.spec.symbol} ${run.spec.timeframe} ${rule} ${run.spec.from}..${run.spec.to}`;
};

/** SVG path of the combined equity, scaled to the chart box. */
export const equityPath = (
  points: BacktestCombo["points"],
  width: number,
  height: number
): string => {
  if (points.length === 0) return "";
  const first = (points[0] as BacktestCombo["points"][number]).t;
  const span = Math.max(1, (points.at(-1)?.t as number) - first);
  const values = points.map((point) => point.equity);
  const low = Math.min(...values);
  const range = Math.max(1e-9, Math.max(...values) - low);
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${(((point.t - first) / span) * width).toFixed(1)},${(height - ((point.equity - low) / range) * height).toFixed(1)}`
    )
    .join(" ");
};

/** How many runs the page combines when no runs are chosen. */
const DEFAULT_COMBO_SIZE = 4;
/** Fewest runs a combination takes (the combine contract needs one slot). */
const MIN_COMBO_RUNS = 1;
/** Pause after the last change before the page combines again. */
export const COMBO_DEBOUNCE_MS = 350;
const DEPOSIT_MAX = 1_000_000_000;
const WEIGHT_TOLERANCE = 1e-9;

const CORE7_MEMBERS = backtestUniverse(DEFAULT_BACKTEST_UNIVERSE_ID).members;
const CORE7_FUTURES = new Set(CORE7_MEMBERS.map((member) => member.symbol));
const CORE7_TWINS = new Set(CORE7_MEMBERS.map((member) => member.twin));

/** 0 for a Core 7 future, 1 for its ETF twin, 2 for any other symbol. */
export const symbolRank = (symbol: string): number => {
  if (CORE7_FUTURES.has(symbol)) return 0;
  return CORE7_TWINS.has(symbol) ? 1 : 2;
};

/**
 * The default runs: the newest finished runs (`runs` is newest first), Core 7 futures first,
 * then their ETF twins, then any symbol. Each symbol gets one run before a symbol repeats.
 */
export const defaultComboRunIds = (
  runs: readonly BacktestRunSummary[],
  size: number = DEFAULT_COMBO_SIZE
): string[] => {
  const ranked = [0, 1, 2].flatMap((rank) =>
    runs.filter((run) => symbolRank(run.spec.symbol) === rank)
  );
  const seen = new Set<string>();
  const firsts = ranked.filter((run) => {
    if (seen.has(run.spec.symbol)) return false;
    seen.add(run.spec.symbol);
    return true;
  });
  return [...firsts, ...ranked.filter((run) => !firsts.includes(run))]
    .slice(0, size)
    .map((run) => run.id);
};

/** Known run ids from `?runs=`; the default runs when fewer than the minimum remain. */
export const parseComboRuns = (
  search: string,
  runs: readonly BacktestRunSummary[]
): string[] => {
  const known = new Set(runs.map((run) => run.id));
  const ids = readListParam(search, "runs", BACKTEST_COMBO_SLOTS_MAX).filter(
    (id) => known.has(id)
  );
  return ids.length >= MIN_COMBO_RUNS ? ids : defaultComboRunIds(runs);
};

/** An equal share of the deposit for each run, rounded down to the 0.05 weight step. */
export const equalWeights = (
  ids: readonly string[]
): Record<string, number> => {
  const weight = Math.floor(20 / Math.max(1, ids.length)) / 20;
  return Object.fromEntries(ids.map((id) => [id, weight]));
};

/** The combine request for the weighted runs, in list order. */
export const comboRequest = (
  runs: readonly BacktestRunSummary[],
  weights: Readonly<Record<string, number>>,
  deposit: number
): BacktestComboInput => ({
  deposit,
  slots: runs
    .filter((run) => weights[run.id] !== undefined)
    .map((run) => ({
      expectedRevision: run.strategyRevision,
      runId: run.id,
      weight: weights[run.id] as number,
    })),
});

/** Total weight of the request's slots. */
export const weightTotal = (input: BacktestComboInput): number =>
  input.slots.reduce((sum, slot) => sum + slot.weight, 0);

/** A plain reason the server would refuse the slots (too many runs or a weight outside 0..1), or null. */
export const slotLimitMessage = (input: BacktestComboInput): string | null => {
  if (input.slots.length > BACKTEST_COMBO_SLOTS_MAX)
    return `Pick at most ${BACKTEST_COMBO_SLOTS_MAX} runs.`;
  return input.slots.every((slot) => slot.weight >= 0 && slot.weight <= 1)
    ? null
    : "Each weight must be between 0 and 1.";
};

/** True when the request has 1 to 10 slots, weights in 0..1 adding to at most 100% and a valid deposit. */
export const canCombine = (input: BacktestComboInput): boolean =>
  input.slots.length > 0 &&
  slotLimitMessage(input) === null &&
  input.deposit >= 1 &&
  input.deposit <= DEPOSIT_MAX &&
  weightTotal(input) <= 1 + WEIGHT_TOLERANCE;

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      runs: readonly BacktestRunSummary[];
      /** The default run ids in list order, joined with commas. */
      defaultRuns: string;
    }>;

const NO_RUNS: readonly BacktestRunSummary[] = [];
const CACHE_LIMIT = 20;

const ComboReport = ({ combo }: Readonly<{ combo: BacktestCombo }>) => (
  <section aria-label="Combined portfolio" className="grid gap-4">
    <h2 className="font-semibold text-lg">Combined portfolio</h2>
    <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
      {[
        ["Deposit", money.format(combo.deposit)],
        ["Final equity", money.format(combo.finalEquity)],
        ["Net profit", money.format(combo.netProfit)],
        ["Cash (unallocated)", money.format(combo.cash)],
        ["CAGR", percent(combo.stats.cagr)],
        ["Sharpe", ratio(combo.stats.sharpe)],
        ["Max drawdown", percent(combo.stats.maxDrawdownPct)],
        ["Joint drawdown share", percent(combo.jointDrawdownShare)],
      ].map(([label, value]) => (
        <div className="rounded-md border p-3" key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
    <svg
      aria-label="Combined equity curve"
      className="h-auto w-full rounded-md border bg-background"
      role="img"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
    >
      <path
        d={equityPath(combo.points, CHART_WIDTH, CHART_HEIGHT)}
        fill="none"
        stroke="var(--vx-gold)"
        strokeWidth={1.5}
      />
    </svg>
    <p className="text-sm">
      Diversification:{" "}
      <strong>
        {combo.diversification.diversified ? "diversified" : "not diversified"}
      </strong>{" "}
      (combined max drawdown{" "}
      {percent(combo.diversification.combinedDrawdownPct)} against weighted slot
      max drawdown {percent(combo.diversification.weightedSlotDrawdownPct)},
      volatility ratio {ratio(combo.diversification.ratio)})
    </p>
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <TableCaption className="mt-0 caption-top text-left font-medium text-foreground">
          Slots
        </TableCaption>
        <TableHeader>
          <TableRow className="text-left">
            <TableHead scope="col">#</TableHead>
            <TableHead scope="col">Slot</TableHead>
            <TableHead scope="col">Weight</TableHead>
            <TableHead scope="col">P&amp;L</TableHead>
            <TableHead scope="col">Full Sharpe</TableHead>
            <TableHead scope="col">Recent Sharpe</TableHead>
            <TableHead scope="col">Full max DD</TableHead>
            <TableHead scope="col">Recent max DD</TableHead>
            <TableHead scope="col">Verdict</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {combo.slots.map((slot, index) => (
            <TableRow key={slot.runId}>
              <TableCell className="whitespace-normal">{index + 1}</TableCell>
              <TableCell className="whitespace-normal">
                {slot.label}
                <span className="block text-muted-foreground text-xs">
                  Revision{" "}
                  {slot.strategyRevision === null
                    ? "none (no linked strategy)"
                    : slot.strategyRevision.slice(0, 12)}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal">
                {percent(slot.weight)}
              </TableCell>
              <TableCell className="whitespace-normal tabular-nums">
                {money.format(slot.pnl)}
              </TableCell>
              <TableCell className="whitespace-normal">
                {ratio(slot.full.sharpe)}
              </TableCell>
              <TableCell className="whitespace-normal">
                {ratio(slot.recent.sharpe)}
              </TableCell>
              <TableCell className="whitespace-normal">
                {percent(slot.full.maxDrawdownPct)}
              </TableCell>
              <TableCell className="whitespace-normal">
                {percent(slot.recent.maxDrawdownPct)}
              </TableCell>
              <TableCell className="whitespace-normal">
                {slot.verdict}
                <span className="block text-muted-foreground text-xs">
                  {slot.verdictReason}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <div className="overflow-x-auto">
      <Table className="w-auto text-sm">
        <TableCaption className="mt-0 caption-top text-left font-medium text-foreground">
          Return correlation / drawdown overlap
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Slot</TableHead>
            {combo.slots.map((slot, index) => (
              <TableHead key={slot.runId} scope="col">
                {index + 1}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {combo.slots.map((slot, row) => (
            <TableRow key={slot.runId}>
              <TableHead className="whitespace-normal" scope="row">
                {row + 1}
              </TableHead>
              {combo.slots.map((other, column) => (
                <TableCell
                  className="whitespace-normal px-2 tabular-nums"
                  key={other.runId}
                >
                  {ratio(
                    (combo.correlation[row] as (number | null)[])[column] as
                      | number
                      | null
                  )}{" "}
                  /{" "}
                  {percent(
                    (combo.drawdownOverlap[row] as number[])[column] as number
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </section>
);

export const PortfolioCombosWorkspace = ({
  gateway,
}: Readonly<{ gateway?: PortfolioCombosGateway }>) => {
  // One result cache per gateway: picking an earlier mix again shows it without a new request.
  const { api, cache } = useMemo(
    () => ({
      api: gateway ?? createBrowserPortfolioCombosGateway(),
      cache: createResultCache<BacktestCombo>(CACHE_LIMIT),
    }),
    [gateway]
  );
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const [weights, setWeights] = useState<Readonly<Record<string, number>>>({});
  const [deposit, setDeposit] = useState(100_000);
  const [combo, setCombo] = useState<BacktestCombo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const depositId = useId();

  useEffect(() => {
    let active = true;
    api.list().then(
      (loaded) => {
        if (!active) return;
        const finished = loaded.filter((run) => run.status === "succeeded");
        const defaults = new Set(defaultComboRunIds(finished));
        setState({
          defaultRuns: finished
            .filter((run) => defaults.has(run.id))
            .map((run) => run.id)
            .join(","),
          runs: finished,
          type: "ready",
        });
        setWeights(equalWeights(parseComboRuns(currentSearch(), finished)));
      },
      (error: unknown) => {
        if (!active) return;
        setState(
          isOperatorAccessDenied(error)
            ? { type: "forbidden" }
            : {
                message: describeMarketDataFailure(error).message,
                type: "error",
              }
        );
      }
    );
    return () => {
      active = false;
    };
  }, [api]);

  const runs = state.type === "ready" ? state.runs : NO_RUNS;
  const request = useMemo(
    () => comboRequest(runs, weights, deposit),
    [runs, weights, deposit]
  );
  const settled = useDebouncedValue(request, COMBO_DEBOUNCE_MS);
  const selectedRuns = request.slots.map((slot) => slot.runId).join(",");
  const defaultRuns = state.type === "ready" ? state.defaultRuns : null;

  useEffect(() => {
    if (defaultRuns === null) return;
    writeQuery({ runs: selectedRuns }, { runs: defaultRuns });
  }, [defaultRuns, selectedRuns]);

  // Every request takes a new ticket; an answer whose ticket is no longer the latest (a newer
  // automatic or manual combine, a cache hit, or a closed page) is cached but never shown.
  const latest = useRef(0);
  const send = useCallback(
    (input: BacktestComboInput) => {
      latest.current += 1;
      const ticket = latest.current;
      setBusy(true);
      setFailure(null);
      api.combine(input).then(
        (result) => {
          cache.set(cacheKey(input), result);
          if (latest.current !== ticket) return;
          setCombo(result);
          setBusy(false);
        },
        (error: unknown) => {
          if (latest.current !== ticket) return;
          setCombo(null);
          setFailure(describeMarketDataFailure(error).message);
          setBusy(false);
        }
      );
    },
    [api, cache]
  );

  // Combines the settled choice automatically: stored results only, never a new backtest.
  useEffect(() => {
    const hit = canCombine(settled) ? cache.get(cacheKey(settled)) : null;
    if (hit === undefined) send(settled);
    else {
      latest.current += 1;
      setFailure(null);
      setBusy(false);
      setCombo(hit);
    }
    return () => {
      latest.current += 1;
    };
  }, [cache, send, settled]);

  if (state.type === "loading")
    return (
      <p className="text-sm" role="status">
        Loading finished runs
      </p>
    );
  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="instant-backtest" />;
  if (state.type === "error")
    return (
      <p className="text-destructive text-sm" role="alert">
        {state.message}
      </p>
    );

  const weightSum = weightTotal(request);
  const slotLimit = slotLimitMessage(request);
  return (
    <div className="grid gap-6">
      <section aria-label="Slots" className="grid gap-3">
        <h2 className="font-semibold text-lg">Slots</h2>
        <p className="text-muted-foreground text-sm">
          Research only. A combination is a screening result; it does not
          authorize a trade.
        </p>
        {runs.length === 0 ? (
          <p className="text-sm">
            No finished backtest runs. Run backtests on the Backtest runs page
            first.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              The page starts with the newest finished runs, Core 7 futures
              first. Tick runs or change weights to combine another mix.
            </p>
            <ul className="grid gap-2" data-click-private="">
              {runs.map((run) => {
                const label = describeRun(run);
                const weight = weights[run.id];
                return (
                  <li
                    className="flex flex-wrap items-center gap-3"
                    key={run.id}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        checked={weight !== undefined}
                        className="size-5"
                        onChange={(event) =>
                          setWeights((current) => {
                            const next = { ...current };
                            if (event.target.checked) next[run.id] = 0.25;
                            else delete next[run.id];
                            return next;
                          })
                        }
                        type="checkbox"
                      />
                      {label}
                    </label>
                    {weight === undefined ? null : (
                      <input
                        aria-label={`Weight for ${label}`}
                        className="min-h-11 w-24 rounded-md border bg-background px-3 text-sm"
                        max={1}
                        min={0}
                        onChange={(event) =>
                          setWeights((current) => ({
                            ...current,
                            [run.id]: Number(event.target.value),
                          }))
                        }
                        step={0.05}
                        type="number"
                        value={weight}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <label className="font-medium text-sm" htmlFor={depositId}>
              Shared deposit
            </label>
            <input
              className="min-h-11 rounded-md border bg-background px-3 text-sm"
              id={depositId}
              min={1}
              onChange={(event) => setDeposit(Number(event.target.value))}
              type="number"
              value={deposit}
            />
          </div>
          <button
            className="min-h-11 rounded-md border px-4 font-medium text-sm"
            disabled={busy || !canCombine(request)}
            onClick={() => send(request)}
            type="button"
          >
            Combine
          </button>
          <span className="text-sm">
            Weights total {percent(weightSum)}
            {weightSum > 1 + WEIGHT_TOLERANCE ? " (above 100%)" : ""}
          </span>
          {slotLimit === null ? null : (
            <span className="text-sm">{slotLimit}</span>
          )}
          {busy ? (
            <span className="text-sm" role="status">
              Combining runs
            </span>
          ) : null}
        </div>
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </section>
      {combo === null ? null : <ComboReport combo={combo} />}
    </div>
  );
};
