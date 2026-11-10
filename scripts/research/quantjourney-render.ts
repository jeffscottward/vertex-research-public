// Markdown rendering of the QuantJourney inventory and re-run results (see quantjourney.ts).
import { timeMs } from "../../packages/api/src/quant-arrays.ts";
import {
  type LibraryDoc,
  primarySummary,
  type ResultsDoc,
  type SeriesSummary,
  type StrategyResult,
} from "./quantjourney.ts";

const DASH = "—";

export const pct = (fraction: number | null | undefined): string =>
  fraction === null || fraction === undefined
    ? DASH
    : `${(fraction * 100).toFixed(1)}%`;

export const num = (value: number | null | undefined, digits = 2): string =>
  value === null || value === undefined ? DASH : value.toFixed(digits);

const publishedPct = (value: number | null | undefined): string =>
  value === null || value === undefined ? DASH : `${value.toFixed(1)}%`;

const cell = (text: string): string => text.replaceAll("|", "\\|");

const row = (cells: readonly string[]): string => `|${cells.join("|")}|`;

const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string =>
  [
    row(header),
    row(header.map(() => "---")),
    ...rows.map((cells) => row(cells)),
  ].join("\n");

const triple = (s: SeriesSummary | null | undefined): string =>
  s === null || s === undefined
    ? DASH
    : `${pct(s.cagr)} / ${num(s.sharpe)} / ${pct(s.maxDrawdown)}`;

export const verdict = (result: StrategyResult | undefined): string => {
  if (result === undefined) return "pending";
  if (result.status === "no-data") return "not run: no data";
  if (result.status === "error") return "fail: no usable run";
  if (result.gate === null) return "fail: Vertex-cost run failed";
  return result.gate.pass ? "pass" : "fail";
};

const inventoryRows = (library: LibraryDoc): string[][] =>
  library.strategies.map((s) => [
    s.id,
    cell(s.name),
    s.category,
    s.granularity,
    cell(s.assetClass),
    cell(s.universe.join(", ")),
    `${s.period.start} to ${s.period.end}`,
    cell(s.rebalance ?? s.orderType ?? DASH),
    s.published === null
      ? "no portfolio metrics (workflow)"
      : `${publishedPct(s.published.totalReturnPct)} / ${publishedPct(s.published.cagrPct)} / ${num(s.published.sharpe)} / ${publishedPct(s.published.maxDrawdownPct)}`,
    `[dashboard](${s.dashboard}), [GitHub](${s.github})`,
  ]);

const rulesRows = (library: LibraryDoc): string[][] =>
  library.strategies.map((s) => [
    s.id,
    cell(s.rules),
    cell(s.costs),
    s.dsl === null ? "no (adapter)" : "yes",
    s.rerun.status === "run" ? "yes" : "no: intraday data",
  ]);

const comparisonRows = (library: LibraryDoc, results: ResultsDoc): string[][] =>
  library.strategies.map((s) => {
    const r = results.strategies.find((x) => x.id === s.id);
    const p = s.published;
    const a = r?.adapter;
    return [
      s.id,
      p === null
        ? DASH
        : `${publishedPct(p.totalReturnPct)} / ${num(p.sharpe)} / ${publishedPct(p.maxDrawdownPct)}`,
      a === null || a === undefined
        ? DASH
        : `${pct(a.qj.totalReturn)} / ${num(a.qj.sharpe)} / ${pct(a.qj.maxDrawdown)}`,
      triple(r?.adapterVertexCost?.summary),
      triple(r?.dsl),
      r === undefined || r.flags.length === 0 ? DASH : r.flags.join(", "),
    ];
  });

const gateRows = (results: ResultsDoc): string[][] =>
  results.strategies.map((r) => [
    r.id,
    r.primary === null ? DASH : r.primary === "dsl" ? "Vertex DSL" : "adapter",
    triple(r.primary === "dsl" ? r.dsl : r.adapterVertexCost?.summary),
    triple(r.benchmark),
    r.gate === null ? DASH : r.gate.beatsBenchmarkBothHalves ? "yes" : "no",
    num(r.gate?.deflatedSharpeProbability, 3),
    num(r.gate?.qValue, 3),
    verdict(r),
  ]);

const resultsSummary = (library: LibraryDoc, results: ResultsDoc): string => {
  const run = results.strategies.filter((r) => r.status === "run");
  const flagged = results.strategies.filter((r) => r.flags.length > 0);
  const passed = run.filter((r) => r.gate?.pass === true);
  // Ranked only among daily trials with a positive Vertex Sharpe: a short intraday sample or a
  // losing trial can score a middling probability without being a candidate.
  const ranked = results.strategies
    .flatMap((r) => {
      const entry = library.strategies.find((s) => s.id === r.id);
      const probability = r.gate?.deflatedSharpeProbability ?? null;
      const summary = primarySummary(r);
      return entry?.granularity !== "1d" ||
        probability === null ||
        summary === null ||
        (summary.sharpe ?? 0) <= 0
        ? []
        : [{ id: r.id, name: entry.name, probability, summary }];
    })
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);
  const years = (s: SeriesSummary): string =>
    ((timeMs(s.end) - timeMs(s.start)) / (365.25 * 86_400_000)).toFixed(1);
  // Trials whose re-run series are identical (the same rule twice, or one underlying run).
  const groups = new Map<string, string[]>();
  for (const r of results.strategies) {
    const s = primarySummary(r);
    if (s === null) continue;
    const key = `${s.totalReturn}|${s.sharpe}|${s.maxDrawdown}|${s.periods}`;
    groups.set(key, [...(groups.get(key) ?? []), r.id]);
  }
  const duplicates = [...groups.values()].filter((ids) => ids.length > 1);
  return [
    `- Entries: ${library.count}. Re-run: ${run.length}. Not re-run: ${results.strategies.length - run.length} (intraday windows Yahoo no longer serves, or adapter errors).`,
    `- Reproduction (QuantJourney engine on Vertex data versus the published dashboards): ${flagged.length} of ${run.length} re-runs have at least one flag.`,
    `- Gates (${results.trials} trials, Vertex cost ${results.vertexCostBps} bp per side): ${passed.length} pass. Nothing is promoted to paper.`,
    ...(results.engine === undefined
      ? []
      : [
          `- Vertex re-run engine: \`${results.engine}\`${results.engineParity ? ` (each job also run on \`${results.engineParity.against}\`: ${results.engineParity.pass} of ${results.engineParity.jobs} within ${results.engineParity.equityRelTolerance} unit-equity difference, largest ${results.engineParity.maxEquityRel.toExponential(1)})` : ""}.`,
        ]),
    `- Highest deflated Sharpe probability among daily re-runs with a positive Sharpe: ${ranked.map((r) => `${r.id} ${cell(r.name)} (${num(r.probability, 3)}; Sharpe ${num(r.summary.sharpe)}; ${years(r.summary)} years)`).join("; ")}.`,
    ...(duplicates.length === 0
      ? []
      : [
          `- Identical re-run series: ${duplicates.map((ids) => ids.join(" = ")).join("; ")}. Each still counts as one of the ${results.trials} trials, which makes the deflation stricter.`,
        ]),
  ].join("\n");
};

const sourceSection = (library: LibraryDoc): string => {
  const src = library.source;
  return [
    "## Source",
    "",
    `- Code: [${src.repository.replace("https://github.com/", "")}](${src.repository}) at commit \`${src.commit}\`, ${src.license}. Pinned clone on the rig: \`~/Github/tools/quantjourney-bt\`.`,
    `- Strategies, backtests and dashboards: QuantJourney (<${src.dashboards}>). Published metrics in this file come from each dashboard as listed on <${src.site}> (page data snapshot ${src.fetched}, \`${src.siteSnapshot}\`, SHA-256 \`${src.siteSnapshotSha256}\`). They are labelled "QuantJourney published".`,
    `- ${src.framing}`,
    "- Many published Sharpe ratios are low or negative. These are engine examples, not claimed edges.",
    "- Assets kept outside the repository (licence and size): 45 result previews (PNG), 5 agent skill prompts and the quants.md snapshot. File list with SHA-256: `research/backtests/quantjourney/assets-manifest.json`.",
  ].join("\n");
};

const METHOD = [
  "## How the re-run works",
  "",
  "Three columns are compared for each strategy:",
  "",
  "1. **QuantJourney published**: the dashboard numbers (QuantJourney data and engine).",
  "2. **QuantJourney engine on Vertex data**: the unchanged strategy file from the pinned clone, run by `research/backtests/quantjourney/qj_adapter.py` with dividend-adjusted Yahoo bars that Vertex fetched (`fetch_data.py`). The adapter replaces only the data download; adjusted bars are what QuantJourney's data behaves like (with split-only bars the order examples miss the dividends). The strategy keeps its own costs. Differences from column 1 come from the data or the period. Flags: total return off by more than 10 points or 25%, maximum drawdown off by more than 5 points, or Sharpe off by more than 0.15 (QuantJourney's own Sharpe, which subtracts a risk-free rate).",
  "3. **Vertex re-run**: Vertex statistics (risk-free rate 0) with Vertex costs of 10 bp per side. Strategies that fit the Vertex DSL (long only, one instrument, SMA/RSI rules with percent stop and target) run on the Vertex signal engine (`runStrategyDefinition`): one sleeve per instrument with equal starting capital, signals at the close and fills at the next open. All others run on the adapter with a fixed 10 bp cost per traded notional (weights) or 10 bp slippage (orders).",
  "",
  "Gates (existing Vertex rules): CAGR and Sharpe above the declared benchmark in both halves of the period (as in the 151 Strategies 4.1 re-run), a deflated Sharpe probability of at least 0.95 and a Benjamini-Hochberg q-value of at most 0.05 (`packages/api/src/quant-multiple-testing.ts`, with all 50 strategies counted as trials). A pass would allow further research only; nothing is promoted to paper automatically.",
].join("\n");

const LIMITS = [
  "## Limits",
  "",
  "- Yahoo data, not QuantJourney's provider data. Yahoo futures (`=F`) are front-month continuous series with unadjusted rolls; the futures examples (O20, W25) rank high on these series, so treat their figures as unreliable until rolls are handled.",
  "- The DSL sleeves are not rebalanced and do not cap position size, so exposure differs from the QuantJourney portfolios; compare Sharpe and drawdown shape, not the total return.",
  "- FX and futures examples are price-return proxies (no swaps, margin or roll costs), as the source states.",
  "- Today's ETFs only (survivorship); one parameter set per strategy; the walk-forward examples are rated on their underlying strategy run.",
  "- A completed backtest does not authorize a trade.",
].join("\n");

const REGENERATE = [
  "## Regenerate",
  "",
  "```sh",
  "uv run --no-project --python 3.12 --with yfinance==0.2.66 python research/backtests/quantjourney/fetch_data.py --out ~/Documents/reports/vertex-quantsmd/data",
  "cd /tmp && uv run --project ~/Github/tools/quantjourney-bt --frozen --extra wf python <repo>/research/backtests/quantjourney/qj_adapter.py --clone ~/Github/tools/quantjourney-bt --data ~/Documents/reports/vertex-quantsmd/data --out ~/Documents/reports/vertex-quantsmd/runs",
  "# the same command again with --cost-bps 10 for the Vertex cost case",
  "# NautilusTrader by default: --python (or VERTEX_NAUTILUS_PYTHON) is a venv with services/research/requirements-nautilus-linux-py312.lock; --engine typescript keeps the TypeScript engine",
  "bun run research:quantjourney -- --rerun --data ~/Documents/reports/vertex-quantsmd/data --runs ~/Documents/reports/vertex-quantsmd/runs --python ~/.local/share/vertex/nautilus-venv/bin/python",
  "bunx --bun --no-install biome format --write research/backtests/quantjourney/results.json",
  "```",
  "",
  "`bun run research:quantjourney -- --check` (run by `scripts/research/quantjourney.test.ts`) fails when this file is out of date.",
].join("\n");

export const renderDoc = (
  library: LibraryDoc,
  results: ResultsDoc | null
): string => {
  const parts = [
    "# QuantJourney strategy library (quants.md): inventory and Vertex re-run",
    "",
    "Research only. No strategy in this file creates, routes or simulates broker orders. Generated by `bun run research:quantjourney` from `research/backtests/quantjourney/library.json` and `results.json`; do not edit by hand.",
    "",
    sourceSection(library),
    "",
    "## Summary",
    "",
    results === null ? "- Re-run: pending." : resultsSummary(library, results),
    "",
    METHOD,
    "",
    "## Inventory",
    "",
    "Published = QuantJourney published total return / CAGR / Sharpe / maximum drawdown.",
    "",
    table(
      [
        "ID",
        "Name",
        "Category",
        "Bars",
        "Asset class",
        "Universe",
        "Period",
        "Rebalance or order type",
        "Published",
        "Links",
      ],
      inventoryRows(library)
    ),
    "",
    "## Rules and mapping",
    "",
    "Rules are Vertex summaries of each strategy file; read the file before you rely on a detail.",
    "",
    table(
      ["ID", "Rules", "Costs in the source", "Vertex DSL", "Re-run"],
      rulesRows(library)
    ),
  ];
  if (results !== null) {
    parts.push(
      "",
      "## QuantJourney published versus Vertex re-run",
      "",
      `Data: ${results.data.source}; manifest SHA-256 \`${results.data.manifestSha256}\`; generated ${results.generated}. Published and engine columns: total return / Sharpe (QuantJourney definition) / maximum drawdown. Vertex columns: CAGR / Sharpe (risk-free 0) / maximum drawdown.`,
      "",
      table(
        [
          "ID",
          "QuantJourney published",
          "QuantJourney engine on Vertex data",
          "Adapter, Vertex cost",
          "Vertex DSL",
          "Flags",
        ],
        comparisonRows(library, results)
      ),
      "",
      "## Multiple testing and gates",
      "",
      table(
        [
          "ID",
          "Vertex re-run",
          "CAGR / Sharpe / max DD",
          "Benchmark",
          "Beats benchmark both halves",
          "Deflated Sharpe probability",
          "BH q-value",
          "Verdict",
        ],
        gateRows(results)
      )
    );
  }
  parts.push("", LIMITS, "", REGENERATE, "");
  return parts.join("\n");
};
