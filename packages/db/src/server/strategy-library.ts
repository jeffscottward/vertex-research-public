// Strategy library normalization: strategy fields, typed parameter schemas and preset values.
// Pure functions; the repository maps StrategyInputError to InvalidRepositoryInputError.
import {
  STRATEGY_KINDS,
  STRATEGY_PARAM_TYPES,
  STRATEGY_PRIORITIES,
  STRATEGY_STATUSES,
  type StrategyExternalValidation,
  type StrategyExternalValidationMetric,
  type StrategyKind,
  type StrategyParam,
  type StrategyParamType,
  type StrategyParamValue,
  type StrategyPresetValues,
  type StrategyPriority,
  type StrategyStatus,
} from "../schema/index.ts";
import { required as requirePresent } from "./required.ts";

export const STRATEGY_NAME_MAX_LENGTH = 200;
const STRATEGY_SLUG_MAX_LENGTH = 80;
export const STRATEGY_DESCRIPTION_MAX_LENGTH = 2000;
const STRATEGY_SOURCE_REF_MAX_LENGTH = 300;
export const STRATEGY_SECTION_MAX_LENGTH = 80;
export const STRATEGY_TAGS_MAX = 20;
const STRATEGY_TAG_MAX_LENGTH = 32;
export const STRATEGY_PARAMS_MAX = 60;
const STRATEGY_PARAM_TITLE_MAX_LENGTH = 120;
const STRATEGY_PARAM_OPTIONS_MAX = 50;
const STRATEGY_PARAM_OPTION_MAX_LENGTH = 100;
const STRATEGY_PRESET_NAME_MAX_LENGTH = 80;
export const STRATEGY_PRESETS_MAX = 50;
export const STRATEGY_SEARCH_MAX_LENGTH = 100;
const STRATEGY_EXTERNAL_SOURCE_URL_MAX_LENGTH = 300;
const STRATEGY_EXTERNAL_SOURCE_TITLE_MAX_LENGTH = 200;
const STRATEGY_EXTERNAL_SOURCE_AUTHOR_MAX_LENGTH = 120;
const STRATEGY_EXTERNAL_METHOD_MAX_LENGTH = 1000;
const STRATEGY_EXTERNAL_METRICS_MAX = 12;
const STRATEGY_EXTERNAL_METRIC_LABEL_MAX_LENGTH = 60;
const STRATEGY_EXTERNAL_METRIC_VALUE_MAX_LENGTH = 80;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXTERNAL_VALIDATION_KEYS = [
  "sourceUrl",
  "sourceTitle",
  "sourceAuthor",
  "publishedOn",
  "claimedMethod",
  "claimedMetrics",
] as const;
const EXTERNAL_METRIC_KEYS = ["label", "value"] as const;
const STRATEGY_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const STRATEGY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/;
const SOURCE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const PARAM_KEYS = [
  "name",
  "type",
  "title",
  "default",
  "min",
  "max",
  "step",
  "options",
] as const;

export class StrategyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyInputError";
  }
}

const fail: (message: string) => never = (message) => {
  throw new StrategyInputError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const includesValue = <T extends string>(
  values: readonly T[],
  value: unknown
): value is T => {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
};

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = (value as string).trim();
  if (trimmed === "") fail(`${field} must not be blank`);
  if (trimmed.length > max) fail(`${field} must not exceed ${max} characters`);
  if (CONTROL_CHARACTER_PATTERN.test(trimmed))
    fail(`${field} must not contain control characters`);
  return trimmed;
};

// undefined stays undefined (unchanged); null or blank clears.
const clearable = (
  value: unknown,
  field: string,
  max: number
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  if ((value as string).trim() === "") return null;
  return text(value, field, max);
};

export const normalizeStrategyName = (value: unknown): string => {
  return text(value, "name", STRATEGY_NAME_MAX_LENGTH);
};

export const normalizeStrategySlug = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !STRATEGY_SLUG_PATTERN.test(value) ||
    value.length > STRATEGY_SLUG_MAX_LENGTH
  ) {
    fail(
      `slug must be lowercase letters, digits and single hyphens (at most ${STRATEGY_SLUG_MAX_LENGTH} characters)`
    );
  }
  return value as string;
};

// "Jump model (v2)" -> "jump-model-v2". Non-ASCII letters are dropped.
export const slugifyStrategyName = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    // Each run of other characters is now one "-", so one "-" at most stands at either end;
    // single-character patterns keep the trim linear in the name length.
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, STRATEGY_SLUG_MAX_LENGTH)
    .replace(/-$/u, "");
  if (slug === "") fail("name must contain a letter or digit to derive a slug");
  return slug;
};

export const normalizeStrategyKind = (value: unknown): StrategyKind => {
  if (!includesValue(STRATEGY_KINDS, value))
    fail(`kind must be one of ${STRATEGY_KINDS.join(", ")}`);
  return value as StrategyKind;
};

export const normalizeStrategyStatus = (value: unknown): StrategyStatus => {
  if (!includesValue(STRATEGY_STATUSES, value))
    fail(`status must be one of ${STRATEGY_STATUSES.join(", ")}`);
  return value as StrategyStatus;
};

export const normalizeStrategyPriority = (value: unknown): StrategyPriority => {
  if (!includesValue(STRATEGY_PRIORITIES, value))
    fail(`priority must be one of ${STRATEGY_PRIORITIES.join(", ")}`);
  return value as StrategyPriority;
};

const strictRecord = (
  value: unknown,
  keys: readonly string[],
  field: string
): Record<string, unknown> => {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key))
      fail(`${field}.${key.slice(0, 40)} is not a recognized field`);
  }
  return record;
};

const httpsUrl = (value: unknown, field: string, max: number): string => {
  const url = text(value, field, max);
  if (!URL.canParse(url) || new URL(url).protocol !== "https:")
    fail(`${field} must be an https URL`);
  return url;
};

// 2026-02-30 parses in some runtimes and rolls over to March; the round trip refuses it.
const isCalendarDay = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

// A real calendar day written YYYY-MM-DD.
const isoDay = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    !ISO_DAY_PATTERN.test(value) ||
    !isCalendarDay(value)
  ) {
    fail(`${field} must be a calendar date written YYYY-MM-DD`);
  }
  return value as string;
};

const normalizeExternalMetrics = (
  value: unknown,
  field: string
): StrategyExternalValidationMetric[] => {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${field} must be a non-empty array`);
  const metrics = value as unknown[];
  if (metrics.length > STRATEGY_EXTERNAL_METRICS_MAX)
    fail(`${field} must not exceed ${STRATEGY_EXTERNAL_METRICS_MAX} entries`);
  return metrics.map((entry, index) => {
    const at = `${field}[${index}]`;
    const record = strictRecord(entry, EXTERNAL_METRIC_KEYS, at);
    return {
      label: text(
        record["label"],
        `${at}.label`,
        STRATEGY_EXTERNAL_METRIC_LABEL_MAX_LENGTH
      ),
      value: text(
        record["value"],
        `${at}.value`,
        STRATEGY_EXTERNAL_METRIC_VALUE_MAX_LENGTH
      ),
    };
  });
};

// A third party's claim about the strategy; never a Vertex validation. undefined stays undefined
// (unchanged); null means no external claim. Unknown keys are refused.
export const normalizeStrategyExternalValidation = (
  value: unknown
): StrategyExternalValidation | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const field = "externalValidation";
  const record = strictRecord(value, EXTERNAL_VALIDATION_KEYS, field);
  return {
    sourceUrl: httpsUrl(
      record["sourceUrl"],
      `${field}.sourceUrl`,
      STRATEGY_EXTERNAL_SOURCE_URL_MAX_LENGTH
    ),
    sourceTitle: text(
      record["sourceTitle"],
      `${field}.sourceTitle`,
      STRATEGY_EXTERNAL_SOURCE_TITLE_MAX_LENGTH
    ),
    sourceAuthor: text(
      record["sourceAuthor"],
      `${field}.sourceAuthor`,
      STRATEGY_EXTERNAL_SOURCE_AUTHOR_MAX_LENGTH
    ),
    publishedOn: isoDay(record["publishedOn"], `${field}.publishedOn`),
    claimedMethod: text(
      record["claimedMethod"],
      `${field}.claimedMethod`,
      STRATEGY_EXTERNAL_METHOD_MAX_LENGTH
    ),
    claimedMetrics: normalizeExternalMetrics(
      record["claimedMetrics"],
      `${field}.claimedMetrics`
    ),
  };
};

// A row read from storage: a priority or external claim that does not parse is an error.
export const parseStoredStrategyFields = (
  row: Readonly<{ priority?: unknown; externalValidation?: unknown }>
): Readonly<{
  priority: StrategyPriority;
  externalValidation: StrategyExternalValidation | null;
}> => {
  return {
    priority: normalizeStrategyPriority(row.priority),
    externalValidation:
      normalizeStrategyExternalValidation(row.externalValidation ?? null) ??
      null,
  };
};

export const normalizeStrategyDescription = (
  value: unknown
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") fail("description must be a string");
  const trimmed = (value as string).trim();
  if (trimmed === "") return null;
  if (trimmed.length > STRATEGY_DESCRIPTION_MAX_LENGTH)
    fail(
      `description must not exceed ${STRATEGY_DESCRIPTION_MAX_LENGTH} characters`
    );
  return trimmed;
};

export const normalizeStrategySection = (
  value: unknown
): string | null | undefined => {
  return clearable(value, "section", STRATEGY_SECTION_MAX_LENGTH);
};

export const normalizeStrategyFavorite = (value: unknown): boolean => {
  if (typeof value !== "boolean") fail("favorite must be true or false");
  return value as boolean;
};

// Repository-relative path with an optional @revision: services/research/strategies/hmm.py@a1b2c3.
// No leading slash, scheme, empty, "." or ".." segment.
export const normalizeStrategySourceRef = (
  value: unknown
): string | null | undefined => {
  const ref = clearable(value, "sourceRef", STRATEGY_SOURCE_REF_MAX_LENGTH);
  if (ref === undefined || ref === null) return ref;
  const at = ref.indexOf("@");
  const path = at === -1 ? ref : ref.slice(0, at);
  const revision = at === -1 ? null : ref.slice(at + 1);
  const segments = path.split("/");
  if (
    !SOURCE_PATH_PATTERN.test(path) ||
    path.endsWith("/") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail(
      "sourceRef must be a repository-relative path such as services/research/strategies/hmm.py"
    );
  }
  if (revision !== null && !SOURCE_REVISION_PATTERN.test(revision)) {
    fail(
      "sourceRef revision after @ must be 1-64 letters, digits, dot, underscore or hyphen"
    );
  }
  return ref;
};

// Up to 20 short labels, trimmed; duplicates (case-insensitive) collapse to the first.
export const normalizeStrategyTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) fail("tags must be an array");
  const tags = value as unknown[];
  if (tags.length > STRATEGY_TAGS_MAX)
    fail(`tags must not exceed ${STRATEGY_TAGS_MAX} entries`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, entry] of tags.entries()) {
    const tag = text(entry, `tags[${index}]`, STRATEGY_TAG_MAX_LENGTH);
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
  }
  return result;
};

const optionalNumber = (
  record: Record<string, unknown>,
  key: "min" | "max" | "step",
  field: string,
  integer: boolean
): number | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${field}.${key} must be a finite number`);
  if (integer && !Number.isSafeInteger(value))
    fail(`${field}.${key} must be an integer`);
  return value as number;
};

const forbid = (
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string,
  type: StrategyParamType
): void => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null)
      fail(`${field}.${key} is not allowed for ${type} parameters`);
  }
};

const normalizeOptions = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${field}.options must be a non-empty array for choice parameters`);
  const options = value as unknown[];
  if (options.length > STRATEGY_PARAM_OPTIONS_MAX)
    fail(
      `${field}.options must not exceed ${STRATEGY_PARAM_OPTIONS_MAX} entries`
    );
  const result = options.map((option, index) =>
    text(option, `${field}.options[${index}]`, STRATEGY_PARAM_OPTION_MAX_LENGTH)
  );
  if (new Set(result).size !== result.length)
    fail(`${field}.options must be unique`);
  return result;
};

// Checks one value against one parameter definition. Used for defaults and preset values.
export const checkStrategyParamValue = (
  param: StrategyParam,
  value: unknown,
  field: string
): StrategyParamValue => {
  switch (param.type) {
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        fail(`${field} must be an integer`);
      break;
    }
    case "decimal": {
      if (typeof value !== "number" || !Number.isFinite(value))
        fail(`${field} must be a finite number`);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(`${field} must be true or false`);
      break;
    }
    case "choice": {
      if (typeof value !== "string" || !(param.options ?? []).includes(value))
        fail(`${field} must be one of ${(param.options ?? []).join(", ")}`);
      break;
    }
  }
  if (typeof value === "number") {
    if (param.min !== undefined && value < param.min)
      fail(`${field} must be at least ${param.min}`);
    if (param.max !== undefined && value > param.max)
      fail(`${field} must be at most ${param.max}`);
  }
  return value as StrategyParamValue;
};

const normalizeStrategyParam = (
  value: unknown,
  field: string
): StrategyParam => {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PARAM_KEYS as readonly string[]).includes(key))
      fail(`${field}.${key.slice(0, 40)} is not a recognized field`);
  }
  const name = record["name"];
  if (typeof name !== "string" || !STRATEGY_PARAM_NAME_PATTERN.test(name)) {
    fail(
      `${field}.name must be an identifier (letter or underscore, then letters, digits or underscores; at most 64)`
    );
  }
  if (!includesValue(STRATEGY_PARAM_TYPES, record["type"]))
    fail(`${field}.type must be one of ${STRATEGY_PARAM_TYPES.join(", ")}`);
  const type = record["type"] as StrategyParamType;
  const title = text(
    record["title"],
    `${field}.title`,
    STRATEGY_PARAM_TITLE_MAX_LENGTH
  );
  // Key order is stable: name, type, title, default, then bounds or options.
  const param: StrategyParam = {
    name: name as string,
    type,
    title,
    default: false,
  };
  if (type === "integer" || type === "decimal") {
    forbid(record, ["options"], field, type);
    const integer = type === "integer";
    const min = optionalNumber(record, "min", field, integer);
    const max = optionalNumber(record, "max", field, integer);
    const step = optionalNumber(record, "step", field, integer);
    if (min !== undefined && max !== undefined && min > max)
      fail(`${field}.min must not exceed max`);
    if (step !== undefined && step <= 0) fail(`${field}.step must be positive`);
    if (min !== undefined) param.min = min;
    if (max !== undefined) param.max = max;
    if (step !== undefined) param.step = step;
  } else if (type === "boolean") {
    forbid(record, ["min", "max", "step", "options"], field, type);
  } else {
    forbid(record, ["min", "max", "step"], field, type);
    param.options = normalizeOptions(record["options"], field);
  }
  const fallback = record["default"];
  if (fallback === undefined || fallback === null)
    fail(`${field}.default is required`);
  param.default = checkStrategyParamValue(param, fallback, `${field}.default`);
  return param;
};

// At most 60 parameters with unique (case-insensitive) names.
export const normalizeStrategyParams = (value: unknown): StrategyParam[] => {
  if (!Array.isArray(value)) fail("params must be an array");
  const entries = value as unknown[];
  if (entries.length > STRATEGY_PARAMS_MAX)
    fail(`params must not exceed ${STRATEGY_PARAMS_MAX} entries`);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const param = normalizeStrategyParam(entry, `params[${index}]`);
    const key = param.name.toLowerCase();
    if (seen.has(key))
      fail(`params[${index}].name ${param.name} duplicates another parameter`);
    seen.add(key);
    return param;
  });
};

export const normalizeStrategyPresetName = (value: unknown): string => {
  return text(value, "name", STRATEGY_PRESET_NAME_MAX_LENGTH);
};

// Preset values: a non-empty subset of the schema; unknown names, wrong types and out-of-bounds values fail.
export const normalizeStrategyPresetValues = (
  value: unknown,
  params: readonly StrategyParam[]
): StrategyPresetValues => {
  if (!isRecord(value)) fail("values must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) fail("values must set at least one parameter");
  const byName = new Map(params.map((param) => [param.name, param]));
  const result: StrategyPresetValues = {};
  for (const [name, entry] of entries) {
    const param = byName.get(name);
    if (param === undefined)
      fail(`values.${name.slice(0, 64)} is not a parameter of this strategy`);
    result[name] = checkStrategyParamValue(
      requirePresent(param, "param"),
      entry,
      `values.${name}`
    );
  }
  return result;
};
