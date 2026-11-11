// What: source labels for data written by the research fetch scripts (research/backtests/*/fetch_data.py).
// Why: since card vertex-yahoo-terms-decision (owner 2026-11-10) those scripts read IBKR history first and let
// Yahoo (then Cboe, Treasury) fill gaps; each merged file records its per-source date spans
// (services/research/ibkr_history.py Merged.summary(): {rows: {<source>: {rows, first, last}}, ...}) in a
// manifest or SOURCES.json. These helpers turn that record into a label. Data written before the change has
// no record and was Yahoo (or Cboe) only: callers pass that old label as the fallback.
import { z } from "zod";

const SpanSchema = z.object({ first: z.string(), last: z.string() });
const SummarySchema = z.object({ rows: z.record(z.string(), SpanSchema) });

export type SourceSpans = Readonly<
  Record<string, Readonly<{ first: string; last: string }>>
>;

/** The per-source spans of one merge summary, or undefined when it is absent, malformed or empty. */
export const sourceSpans = (summary: unknown): SourceSpans | undefined => {
  const parsed = SummarySchema.safeParse(summary);
  if (!parsed.success || Object.keys(parsed.data.rows).length === 0)
    return undefined;
  return parsed.data.rows;
};

/** "ibkr 2001-01-02..2026-11-06, yahoo 1993-01-29..2000-12-29" (record order), or `fallback`. */
export const describeSpans = (
  spans: SourceSpans | undefined,
  fallback: string
): string =>
  spans === undefined
    ? fallback
    : Object.entries(spans)
        .map(([name, span]) => `${name} ${span.first}..${span.last}`)
        .join(", ");

const SPAN_LABEL =
  /(?:^|, )([a-z]+) \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}(?=, |$)/g;

/** The source names of a describeSpans label (empty for any other text, such as an old fallback label). */
export const spanNames = (label: string): string[] =>
  [...label.matchAll(SPAN_LABEL)].map((match) => match[1] as string);

/** Files per source over many merge summaries ("ibkr 33 files, yahoo 34 files"); undefined when none has spans. */
export const countSources = (
  summaries: readonly unknown[]
): string | undefined => {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    for (const name of Object.keys(sourceSpans(summary) ?? {})) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  return [...counts]
    .map(([name, count]) => `${name} ${count} file${count === 1 ? "" : "s"}`)
    .join(", ");
};

const ManifestSchema = z.object({
  files: z.record(z.string(), z.object({ sources: z.unknown().optional() })),
});

/** countSources over the `files.<name>.sources` records of a fetch manifest (JSON text); undefined without any. */
export const manifestSourceCounts = (text: string): string | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return countSources(
    Object.values(parsed.data.files).map((file) => file.sources)
  );
};
