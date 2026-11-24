import type { ResearchReportDatasetName } from "../contracts/research-reports.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

const PRIVATE_SECTION_IDS: Readonly<Record<string, true>> = {
  entry: true,
};

const OPTION_KINDS: Readonly<Record<string, true>> = {
  "bull-call-spread": true,
  "cash-secured-put": true,
  "long-call": true,
  "put-credit-spread": true,
};

const CURRENCY_CODE = /^[A-Z]{3}$/u;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

// Keep synchronized with PRIVATE_OPTIONS_TEXT in apps/web/src/features/research-reports/view-model.ts.
const PRIVATE_RESEARCH_TEXT =
  /(?:^|[^a-z0-9])(?:ibkr|interactive[\s_-]+brokers|broker(?:age|s)?|nlv|net[\s_-]+liquidation|portfolio(?:s)?|account(?:s)?|user[-_ ]?orders?|(?:limit|market|stop|share|pending|open|working|filled|active|resting|placed|submitted)[\s_-]+orders?|(?:order|orders)[\s_-]+(?:pending|filled|working|open|placed|submitted|resting|active)|filled|(?:existing|current)[\s_-]+(?:positions?|holdings?|shares|exposure))(?=$|[^a-z0-9])/iu;

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** True when stored text mentions private broker, portfolio, account, NLV or user-order details. */
export const isPrivateResearchText = (value: string): boolean => {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2");
  return PRIVATE_RESEARCH_TEXT.test(normalized);
};

const isPublicScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string"
    ? !isPrivateResearchText(value)
    : isFiniteNumber(value) || typeof value === "boolean";

const hasPrivateStringField = (
  entry: JsonRecord,
  keys: readonly string[]
): boolean =>
  keys.some((key) => {
    const value = entry[key];
    return typeof value === "string" && isPrivateResearchText(value);
  });

const sanitizeMetric = (entry: unknown): readonly JsonRecord[] => {
  const item = asRecord(entry);
  if (
    item === null ||
    hasPrivateStringField(item, ["label", "value", "period"])
  ) {
    return [];
  }
  const next: Record<string, unknown> = {};
  if (typeof item["label"] === "string") next["label"] = item["label"];
  if (isPublicScalar(item["value"])) next["value"] = item["value"];
  if (typeof item["period"] === "string") next["period"] = item["period"];
  return Object.keys(next).length === 0 ? [] : [next];
};

const sanitizeSource = (entry: unknown): readonly JsonRecord[] => {
  const item = asRecord(entry);
  if (item === null || hasPrivateStringField(item, ["id", "title", "url"])) {
    return [];
  }
  const next: Record<string, unknown> = {};
  if (typeof item["id"] === "string") next["id"] = item["id"];
  if (typeof item["title"] === "string") next["title"] = item["title"];
  if (typeof item["url"] === "string") next["url"] = item["url"];
  return Object.keys(next).length === 0 ? [] : [next];
};

const sanitizeSection = (entry: unknown): readonly JsonRecord[] => {
  const section = asRecord(entry);
  if (
    section === null ||
    (typeof section["id"] === "string" &&
      PRIVATE_SECTION_IDS[section["id"].trim().toLowerCase()] === true) ||
    hasPrivateStringField(section, ["id", "title"])
  ) {
    return [];
  }
  const rawBody = Array.isArray(section["body"]) ? section["body"] : null;
  const rawBullets = Array.isArray(section["bullets"])
    ? section["bullets"]
    : null;
  const body = rawBody === null ? undefined : rawBody.filter(isPublicScalar);
  const bullets =
    rawBullets === null ? undefined : rawBullets.filter(isPublicScalar);
  const hadLines = (rawBody?.length ?? 0) + (rawBullets?.length ?? 0) > 0;
  const keptLines = (body?.length ?? 0) + (bullets?.length ?? 0);
  if (hadLines && keptLines === 0) return [];
  const next: Record<string, unknown> = {};
  if (typeof section["id"] === "string") next["id"] = section["id"];
  if (typeof section["title"] === "string") next["title"] = section["title"];
  if (body !== undefined) next["body"] = body;
  if (bullets !== undefined) next["bullets"] = bullets;
  return Object.keys(next).length === 0 ? [] : [next];
};

const sanitizeCalendarDate = (value: unknown): string | null => {
  const match = typeof value === "string" ? CALENDAR_DATE.exec(value) : null;
  if (match === null) return null;
  const [text, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === text ? text : null;
};

const sanitizeMultiplier = (value: unknown): number | null => {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isFiniteNumber(parsed) && parsed > 0 ? parsed : null;
};

const sanitizeLeg = (entry: unknown): JsonRecord | null => {
  const leg = asRecord(entry);
  if (leg === null) return null;
  const next: Record<string, unknown> = {};
  if (leg["side"] === "buy" || leg["side"] === "sell") {
    next["side"] = leg["side"];
  }
  if (leg["type"] === "call" || leg["type"] === "put") {
    next["type"] = leg["type"];
  }
  if (isFiniteNumber(leg["strike"]) && leg["strike"] >= 0) {
    next["strike"] = leg["strike"];
  }
  if (isFiniteNumber(leg["premium"]) && leg["premium"] >= 0) {
    next["premium"] = leg["premium"];
  }
  if ("multiplier" in leg && leg["multiplier"] !== undefined) {
    next["multiplier"] = sanitizeMultiplier(leg["multiplier"]);
  }
  return next;
};

const sanitizeStrategy = (entry: unknown): JsonRecord | null => {
  const row = asRecord(entry);
  if (row === null) return null;
  const kind = row["kind"];
  if (kind === "stock") {
    const next: Record<string, unknown> = { kind: "stock" };
    if (typeof row["hypothetical"] === "boolean") {
      next["hypothetical"] = row["hypothetical"];
    }
    if (
      row["hypothetical"] === true &&
      isFiniteNumber(row["stockShares"]) &&
      row["stockShares"] > 0
    ) {
      next["stockShares"] = row["stockShares"];
      if (isFiniteNumber(row["stockEntry"]) && row["stockEntry"] >= 0) {
        next["stockEntry"] = row["stockEntry"];
      }
    }
    return next;
  }
  if (typeof kind !== "string" || OPTION_KINDS[kind] !== true) {
    return {};
  }
  const next: Record<string, unknown> = { kind };
  const expiry = sanitizeCalendarDate(row["expiry"]);
  if (expiry !== null) next["expiry"] = expiry;
  if ("multiplier" in row && row["multiplier"] !== undefined) {
    next["multiplier"] = sanitizeMultiplier(row["multiplier"]);
  }
  if ("legs" in row) {
    next["legs"] = Array.isArray(row["legs"])
      ? row["legs"].map(sanitizeLeg)
      : null;
  }
  return next;
};

const copyPublicText = (
  root: JsonRecord,
  next: Record<string, unknown>,
  key: "asOf" | "title" | "summary"
): void => {
  const value = root[key];
  if (typeof value === "string" && !isPrivateResearchText(value)) {
    next[key] = value;
  }
};

/**
 * Removes private broker, portfolio, account, NLV and user-order text from `options-analysis`
 * payloads before they leave the server, while keeping public research text and the exact
 * validated structural fields that PayoffLab needs for charts and outcome counts.
 */
export const sanitizeResearchDatasetData = (
  dataset: ResearchReportDatasetName,
  data: unknown
): unknown => {
  if (dataset !== "options-analysis") return data;
  const root = asRecord(data);
  if (root === null) return null;

  const next: Record<string, unknown> = {};
  copyPublicText(root, next, "asOf");
  if (
    typeof root["currency"] === "string" &&
    CURRENCY_CODE.test(root["currency"])
  ) {
    next["currency"] = root["currency"];
  }
  copyPublicText(root, next, "title");
  copyPublicText(root, next, "summary");
  if ("metrics" in root) {
    next["metrics"] = Array.isArray(root["metrics"])
      ? root["metrics"].flatMap(sanitizeMetric)
      : null;
  }
  if ("sections" in root) {
    next["sections"] = Array.isArray(root["sections"])
      ? root["sections"].flatMap(sanitizeSection)
      : null;
  }
  if ("sources" in root) {
    next["sources"] = Array.isArray(root["sources"])
      ? root["sources"].flatMap(sanitizeSource)
      : null;
  }
  if ("warnings" in root) {
    next["warnings"] = Array.isArray(root["warnings"])
      ? root["warnings"].filter(isPublicScalar)
      : null;
  }
  if ("strategies" in root && root["strategies"] !== undefined) {
    next["strategies"] = Array.isArray(root["strategies"])
      ? root["strategies"].map(sanitizeStrategy)
      : null;
  }
  return next;
};
