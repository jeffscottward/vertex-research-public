// Pure strategy-library view helpers: labels, section grouping, preset form values and text export.
import {
  studyKindsForTags,
  type StrategyBacktestStudy,
  type StrategyParamOutput,
  type StrategyPresetOutput,
  type StrategySortValue,
  type StrategyStatusValue,
  type StrategySummaryOutput,
  type StrategyVertexStudy,
} from "@darkfactory/api";

export const STRATEGY_TABS = ["overview", "parameters", "backtests"] as const;
export type StrategyTab = (typeof STRATEGY_TABS)[number];
export const STRATEGY_TAB_LABELS: Readonly<Record<StrategyTab, string>> =
  Object.freeze({
    overview: "Overview",
    parameters: "Parameters",
    backtests: "Backtests",
  });
export const isStrategyTab = (value: unknown): value is StrategyTab => {
  return (
    typeof value === "string" &&
    (STRATEGY_TABS as readonly string[]).includes(value)
  );
};

export const STRATEGY_STATUS_LABELS: Readonly<
  Record<StrategyStatusValue, string>
> = Object.freeze({
  idea: "Idea",
  researching: "Researching",
  backtested: "Backtested",
  paper: "Paper trading",
  live_candidate: "Live candidate",
  retired: "Retired",
});

export const STRATEGY_KIND_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    python: "Python",
    native: "Native",
    external: "External",
  });

export const STRATEGY_SORT_LABELS: Readonly<Record<StrategySortValue, string>> =
  Object.freeze({
    updated: "Recently updated",
    name: "Name",
    sharpe: "Sharpe (latest backtest)",
    return: "Return (latest backtest)",
  });

/** Labels of the strategy-backtest study verdicts (the Backtests tab and the library badge). */
export const VERDICT_LABELS: Readonly<
  Record<StrategyBacktestStudy["verdict"], string>
> = {
  edge: "Edge",
  "needs-more-data": "Needs more data",
  "no-edge": "No edge",
};

/** Library tag that records "Vertex tested this strategy and it failed". */
export const FAILED_TAG = "failed";

// Badges beside a strategy name. "Externally pre-validated" records a third party's claim; it is
// shown exactly when the strategy carries an external claim and never means validated by Vertex.
// The Vertex badge shows Vertex's own result: the study verdict, else the failed tag, else a pointer
// to the Backtests tab when a study tag says a study exists. A verdict grants no trading authority.
const HIGH_PRIORITY_LABEL = "High priority";
const EXTERNALLY_PRE_VALIDATED_LABEL = "Externally pre-validated";
export const EXTERNAL_CLAIM_HEADING =
  "External claim (not validated by Vertex)";
export const EXTERNAL_CLAIM_NOTICE =
  "This is the source's claim. Vertex shows its own test result on the Backtests tab. A strategy counts as validated by Vertex only after the Vertex replication and gates pass.";

export type StrategyBadgeKey =
  | "high-priority"
  | "vertex-result"
  | "externally-pre-validated";
export type StrategyBadge = Readonly<{
  key: StrategyBadgeKey;
  label: string;
  hint: string;
  // Read by screen readers after the label; null when the label says it all.
  srText: string | null;
  variant: "default" | "outline";
  dataAttributes: Readonly<Record<string, string>>;
}>;
const EXTERNAL_CLAIM_SR_TEXT = " (source claim, not validated by Vertex)";
const STUDY_HINT =
  "Vertex's own backtest study of this strategy. A research result: it gives no trading authority. Details on the Backtests tab.";
const STUDY_SR_TEXT = " (Vertex research result, not a trading signal)";
const CONFLICT_NOTE = " Also tagged failed.";

const vertexResultBadge = (
  label: string,
  hint: string,
  srText: string,
  result: string,
  source: "study" | "tag"
): StrategyBadge => ({
  dataAttributes: {
    "data-strategy-vertex-result": result,
    "data-strategy-vertex-result-source": source,
  },
  hint,
  key: "vertex-result",
  label,
  srText,
  variant: "outline",
});

const studyBadge = (
  study: StrategyVertexStudy,
  tagged: boolean
): StrategyBadge => {
  const label =
    study.kind === "qc-port"
      ? `Vertex backtest: ${study.verdict}`
      : `Vertex study: ${VERDICT_LABELS[study.verdict]}`;
  // A study is a stored, validated result; a tag is free text. The study wins, and a positive
  // verdict that disagrees with the failed tag says so.
  const conflict =
    tagged && (study.verdict === "edge" || study.verdict === "PASS")
      ? CONFLICT_NOTE
      : "";
  return vertexResultBadge(
    label,
    `${STUDY_HINT}${conflict}`,
    `${STUDY_SR_TEXT}${conflict}`,
    study.verdict,
    "study"
  );
};

/** The Vertex result badge, or null when the strategy has no study, no failed tag and no study tag. */
export const vertexResultBadgeFor = (
  strategy: Pick<StrategySummaryOutput, "tags"> &
    Partial<Pick<StrategySummaryOutput, "vertexStudy">>
): StrategyBadge | null => {
  const tagged = strategy.tags.includes(FAILED_TAG);
  // An older server sends no vertexStudy field; treat it as no verdict.
  const study = strategy.vertexStudy ?? null;
  if (study !== null) return studyBadge(study, tagged);
  if (tagged)
    return vertexResultBadge(
      "Tested, failed",
      "Tagged failed in the library: Vertex tested this strategy and it failed. No stored study is shown.",
      " (Vertex result from the failed tag)",
      FAILED_TAG,
      "tag"
    );
  if (studyKindsForTags(strategy.tags).size > 0)
    return vertexResultBadge(
      "Vertex study: see Backtests tab",
      "This strategy has a Vertex study. Its result could not be shown here; open the Backtests tab.",
      " (Vertex study result on the Backtests tab)",
      "see-backtests-tab",
      "tag"
    );
  return null;
};

export const strategyBadges = (
  strategy: Pick<
    StrategySummaryOutput,
    "priority" | "externalValidation" | "tags"
  > &
    Partial<Pick<StrategySummaryOutput, "vertexStudy">>
): StrategyBadge[] => {
  const vertexResult = vertexResultBadgeFor(strategy);
  return [
    ...(strategy.priority === "high"
      ? [
          {
            dataAttributes: { "data-strategy-priority": "high" },
            hint: "Listed first in every sort.",
            key: "high-priority" as const,
            label: HIGH_PRIORITY_LABEL,
            srText: null,
            variant: "default" as const,
          },
        ]
      : []),
    ...(vertexResult === null ? [] : [vertexResult]),
    ...(strategy.externalValidation === null
      ? []
      : [
          {
            dataAttributes: { "data-strategy-external-validation": "" },
            hint: "A third party published a backtest of this strategy. This is the source's claim, not a Vertex validation.",
            key: "externally-pre-validated" as const,
            label: EXTERNALLY_PRE_VALIDATED_LABEL,
            srText: EXTERNAL_CLAIM_SR_TEXT,
            variant: "outline" as const,
          },
        ]),
  ];
};

const UNSORTED_SECTION_LABEL = "Unsorted";

export type SectionGroup = Readonly<{
  key: string;
  label: string;
  rows: StrategySummaryOutput[];
}>;

const hasHighPriority = (rows: readonly StrategySummaryOutput[]): boolean =>
  rows.some((row) => row.priority === "high");

// Groups keep the server order inside each section. A section that holds a high-priority strategy
// comes first; then sections sort by name with Unsorted last.
export const groupBySection = (
  rows: readonly StrategySummaryOutput[]
): SectionGroup[] => {
  const groups = new Map<string, StrategySummaryOutput[]>();
  for (const row of rows) {
    const key = row.section ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([left, leftRows], [right, rightRows]) => {
      const byPriority =
        Number(hasHighPriority(rightRows)) - Number(hasHighPriority(leftRows));
      if (byPriority !== 0) return byPriority;
      if (left === "") return 1;
      if (right === "") return -1;
      return left.localeCompare(right, "en", { sensitivity: "base" });
    })
    .map(([key, groupRows]) => ({
      key: key === "" ? "unsorted" : key,
      label: key === "" ? UNSORTED_SECTION_LABEL : key,
      rows: groupRows,
    }));
};

// External https links named in a strategy description (for example a source dashboard and its
// code), in order and without duplicates. Trailing sentence punctuation is not part of a link.
export type StrategyLink = Readonly<{ url: string; label: string }>;
export const descriptionLinks = (
  description: string | null
): StrategyLink[] => {
  const urls = (description ?? "").match(/https:\/\/[^\s<>"'()]+/g) ?? [];
  const unique = [...new Set(urls.map((url) => url.replace(/[.,;:]+$/, "")))];
  return unique
    .filter((url) => URL.canParse(url))
    .map((url) => ({ label: new URL(url).host, url }));
};

export const parseTagsText = (text: string): string[] => {
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
};

export const formatParamValue = (
  value: number | boolean | string | undefined
): string => {
  return value === undefined ? "—" : String(value);
};

export const formatRatio = (value: number | null | undefined): string => {
  return value === null || value === undefined ? "—" : value.toFixed(2);
};

export const formatSignedPercent = (
  value: number | null | undefined
): string => {
  return value === null || value === undefined
    ? "—"
    : `${(value * 100).toFixed(2)}%`;
};

// Form state per parameter: numbers stay as typed text until saved; booleans are booleans.
export type PresetFormValues = Record<string, string | boolean>;

export const presetFormValues = (
  params: readonly StrategyParamOutput[],
  values: Readonly<Record<string, number | boolean | string>> = {}
): PresetFormValues => {
  return Object.fromEntries(
    params.map((param) => {
      const value = values[param.name] ?? param.default;
      return [param.name, typeof value === "boolean" ? value : String(value)];
    })
  );
};

// Converts form state to typed preset values; returns an error string for the first bad field.
export const presetValuesFromForm = (
  params: readonly StrategyParamOutput[],
  form: PresetFormValues
): Record<string, number | boolean | string> | string => {
  const result: Record<string, number | boolean | string> = {};
  for (const param of params) {
    const raw = form[param.name];
    if (param.type === "boolean") {
      result[param.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      return `${param.title} is required.`;
    }
    if (param.type === "choice") {
      result[param.name] = text;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) return `${param.title} must be a number.`;
    if (param.type === "integer" && !Number.isInteger(value))
      return `${param.title} must be a whole number.`;
    result[param.name] = value;
  }
  return result;
};

// Plain-text export: a header line, then name=value in schema order (unknown names last).
export const presetExportText = (
  strategySlug: string,
  preset: StrategyPresetOutput,
  params: readonly StrategyParamOutput[]
): string => {
  const known = params
    .map((param) => param.name)
    .filter((name) => Object.hasOwn(preset.values, name));
  const extra = Object.keys(preset.values)
    .filter((name) => !known.includes(name))
    .sort();
  const lines = [...known, ...extra].map(
    (name) => `${name}=${String(preset.values[name])}`
  );
  return [`# ${strategySlug} preset ${preset.name}`, ...lines].join("\n");
};

export const formatPresetValues = (
  values: Readonly<Record<string, number | boolean | string>>
): string => {
  const entries = Object.entries(values);
  return entries.length === 0
    ? "—"
    : entries.map(([name, value]) => `${name}=${String(value)}`).join(" · ");
};

// Parses the schema editor text; returns an error string when it is not a JSON array.
export const parseParamsJson = (text: string): unknown[] | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() === "" ? "[]" : text);
  } catch (error) {
    return `Invalid JSON: ${(error as Error).message}`;
  }
  if (!Array.isArray(parsed)) return "Params schema must be a JSON array.";
  return parsed;
};
