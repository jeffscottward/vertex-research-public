// Pure strategy-library view helpers: labels, section grouping, preset form values and text export.
import type {
  StrategyParamOutput,
  StrategyPresetOutput,
  StrategySortValue,
  StrategyStatusValue,
  StrategySummaryOutput,
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

// Badges beside a strategy name. "Externally pre-validated" records a third party's claim; it is
// shown exactly when the strategy carries an external claim and never means validated by Vertex.
const HIGH_PRIORITY_LABEL = "High priority";
const EXTERNALLY_PRE_VALIDATED_LABEL = "Externally pre-validated";
export const EXTERNAL_CLAIM_HEADING =
  "External claim (not validated by Vertex)";
export const EXTERNAL_CLAIM_NOTICE =
  "This is the source's claim. Vertex shows its own test result on the Backtests tab. A strategy counts as validated by Vertex only after the Vertex replication and gates pass.";

export type StrategyBadgeKey = "high-priority" | "externally-pre-validated";
export type StrategyBadge = Readonly<{
  key: StrategyBadgeKey;
  label: string;
  hint: string;
  // Read by screen readers after the label; null when the label says it all.
  srText: string | null;
}>;
const EXTERNAL_CLAIM_SR_TEXT = " (source claim, not validated by Vertex)";
export const strategyBadges = (
  strategy: Pick<StrategySummaryOutput, "priority" | "externalValidation">
): StrategyBadge[] => {
  return [
    ...(strategy.priority === "high"
      ? [
          {
            hint: "Listed first in every sort.",
            key: "high-priority" as const,
            label: HIGH_PRIORITY_LABEL,
            srText: null,
          },
        ]
      : []),
    ...(strategy.externalValidation === null
      ? []
      : [
          {
            hint: "A third party published a backtest of this strategy. This is the source's claim, not a Vertex validation.",
            key: "externally-pre-validated" as const,
            label: EXTERNALLY_PRE_VALIDATED_LABEL,
            srText: EXTERNAL_CLAIM_SR_TEXT,
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

// Groups keep the server order inside each section; sections sort by name with Unsorted last.
export const groupBySection = (
  rows: readonly StrategySummaryOutput[]
): SectionGroup[] => {
  const groups = new Map<string, StrategySummaryOutput[]>();
  for (const row of rows) {
    const key = row.section ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
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
