// What: display rows for a qc-port backtest study (researchStudies.get, kind "qc-port") on the
// strategy library detail of a QuantConnect idea port. Pure mapping; the document is validated by
// the API (QcPortStudySchema). Research only: a study verdict grants no trading authority.
import type { QcPortStudy } from "@darkfactory/api";

import { formatRatio, formatSignedPercent } from "./strategy-library-model.ts";
import type { JournalPoint } from "./trade-journal-model.ts";

/** Strategy library entries with this tag have a backtest study stored under their slug. */
export const QC_IDEA_TAG = "quantconnect-idea";

export type QcPortRunRow = Readonly<{
  key: string;
  name: string;
  symbols: string;
  cagr: string;
  sharpe: string;
  deflatedSharpe: string;
  maxDrawdown: string;
  worstMonth: string;
  trades: string;
  winRate: string;
  exposure: string;
  skipped: string;
}>;

export type QcPortGateRow = Readonly<{
  key: string;
  gate: string;
  host: string;
  sharpe: string;
  maxDrawdown: string;
  trades: string;
}>;

export type QcPortStudyViewModel = Readonly<{
  title: string;
  verdict: QcPortStudy["verdict"];
  ran: string;
  spec: string;
  notes: string;
  /** The stored pass rule, in words. */
  criteria: string;
  /** Code revision, engine, data hash and run id of the study. */
  provenance: string;
  runs: readonly QcPortRunRow[];
  gates: readonly QcPortGateRow[];
  /** Return since the first month (0 = starting equity), oldest first, for lineGeometry. */
  equity: readonly JournalPoint[];
  equitySummary: string;
}>;

// The runner prints drawdowns as negative fractions; show the loss as a negative percent either way.
const drawdown = (value: number): string =>
  formatSignedPercent(value === 0 ? 0 : -Math.abs(value));

const count = (value: number): string => value.toLocaleString("en-US");

const change = (before: string, after: string): string =>
  `${before} → ${after}`;

export const toQcPortStudyViewModel = (
  study: QcPortStudy
): QcPortStudyViewModel => {
  const first = study.equity[0];
  const equity = study.equity.map((point) => ({
    time: point.t,
    // Non-empty here, and the schema keeps every value positive.
    value: point.v / (first as (typeof study.equity)[number]).v - 1,
  }));
  const last = equity.at(-1);
  return {
    criteria: [
      `Sharpe above ${formatRatio(study.criteria.minSharpe)}`,
      `deflated Sharpe above ${formatRatio(study.criteria.minDeflatedSharpe)}`,
      `max drawdown below ${formatSignedPercent(study.criteria.maxDrawdown)}`,
      ...(study.criteria.beatBaseline ? ["Sharpe above the baseline run"] : []),
    ].join(", "),
    equity,
    equitySummary:
      last === undefined || first === undefined
        ? "No monthly equity stored."
        : `Monthly equity ${first.t} to ${last.time}: ${formatSignedPercent(last.value)} since the first month.`,
    gates: (study.gates ?? []).map((gate) => ({
      gate: gate.gate,
      host: gate.host,
      key: `${gate.gate}:${gate.host}`,
      maxDrawdown: change(
        drawdown(gate.before.maxDrawdown),
        drawdown(gate.after.maxDrawdown)
      ),
      sharpe: change(
        formatRatio(gate.before.sharpe),
        formatRatio(gate.after.sharpe)
      ),
      trades: change(count(gate.before.trades), count(gate.after.trades)),
    })),
    notes: study.notes,
    provenance: `Code ${study.provenance.codeRevision.slice(0, 12)} · ${study.provenance.engine} · data sha256 ${study.provenance.dataSha256.slice(0, 12)} · run ${study.provenance.runId}`,
    ran: study.ran,
    runs: study.runs.map((run, index) => ({
      cagr: formatSignedPercent(run.cagr),
      deflatedSharpe: formatRatio(run.deflatedSharpe),
      exposure: formatSignedPercent(run.exposure),
      key: `${index}:${run.name}`,
      maxDrawdown: drawdown(run.maxDrawdown),
      name: run.name,
      sharpe: formatRatio(run.sharpe),
      skipped: count(run.skipped),
      symbols: run.symbols.join(", "),
      trades: count(run.trades),
      winRate: formatSignedPercent(run.winRate),
      worstMonth:
        run.worstMonth === null
          ? "—"
          : `${run.worstMonth.month} ${formatSignedPercent(run.worstMonth.ret)}`,
    })),
    spec: study.spec,
    title: study.title,
    verdict: study.verdict,
  };
};
