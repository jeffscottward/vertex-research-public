import type { ResearchReportDatasetName } from "../contracts/research-reports.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

const PRIVATE_SECTION_IDS: Readonly<Record<string, true>> = {
  entry: true,
};

const PRIVATE_RESEARCH_TEXT =
  /(?:^|[^a-z0-9])(?:ibkr|interactive\s+brokers|broker(?:age|s)?|nlv|net\s+liquidation|portfolio(?:s)?|account(?:s)?|user[-_ ]?orders?|(?:limit|market|stop|share|pending|open|working|filled|active|resting)[\s_-]+orders?|(?:order|orders)[\s_-]+(?:pending|filled|working|open|placed|submitted|resting)|filled|existing[\s_-]+(?:positions?|holdings?|shares)|current[\s_-]+(?:positions?|holdings?|shares|exposure))(?=$|[^a-z0-9])/iu;

const STRATEGY_FIELDS = [
  "kind",
  "expiry",
  "multiplier",
  "hypothetical",
] as const;
const STOCK_FIELDS = ["stockShares", "stockEntry"] as const;
const LEG_FIELDS = ["side", "type", "strike", "premium", "multiplier"] as const;
const METRIC_FIELDS = ["label", "value", "period"] as const;
const SOURCE_FIELDS = ["id", "title", "url"] as const;

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

/** True when stored text mentions private broker, portfolio, account, NLV or user-order details. */
export const isPrivateResearchText = (value: string): boolean =>
  PRIVATE_RESEARCH_TEXT.test(value);

const hasPrivateField = (entry: JsonRecord, keys: readonly string[]): boolean =>
  keys.some((key) => {
    const value = entry[key];
    return typeof value === "string" && isPrivateResearchText(value);
  });

const pickFields = (
  entry: JsonRecord,
  keys: readonly string[]
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in entry) next[key] = entry[key];
  }
  return next;
};

const sanitizeNonArray = (value: unknown): unknown =>
  typeof value === "string" ? null : value;

const filterTextList = (value: unknown): unknown => {
  if (!Array.isArray(value)) return sanitizeNonArray(value);
  return value.filter(
    (item) => typeof item !== "string" || !isPrivateResearchText(item)
  );
};

const sanitizeRecordList = (
  value: unknown,
  keys: readonly string[]
): unknown => {
  if (!Array.isArray(value)) return sanitizeNonArray(value);
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    if (item === null) return [sanitizeNonArray(entry)];
    return hasPrivateField(item, keys) ? [] : [pickFields(item, keys)];
  });
};

const sanitizeSection = (entry: unknown): readonly unknown[] => {
  const section = asRecord(entry);
  if (section === null) return [sanitizeNonArray(entry)];
  if (
    PRIVATE_SECTION_IDS[String(section["id"])] === true ||
    hasPrivateField(section, ["id", "title"])
  ) {
    return [];
  }
  const rawBody = Array.isArray(section["body"]) ? section["body"] : null;
  const rawBullets = Array.isArray(section["bullets"])
    ? section["bullets"]
    : null;
  const body = rawBody === null ? undefined : filterTextList(rawBody);
  const bullets = rawBullets === null ? undefined : filterTextList(rawBullets);
  const hadLines = (rawBody?.length ?? 0) + (rawBullets?.length ?? 0) > 0;
  const keptLines =
    (Array.isArray(body) ? body.length : 0) +
    (Array.isArray(bullets) ? bullets.length : 0);
  if (hadLines && keptLines === 0) return [];
  return [
    {
      id: section["id"],
      title: section["title"],
      ...(body === undefined ? {} : { body }),
      ...(bullets === undefined ? {} : { bullets }),
    },
  ];
};

const sanitizeLeg = (entry: unknown): unknown => {
  const leg = asRecord(entry);
  return leg === null ? sanitizeNonArray(entry) : pickFields(leg, LEG_FIELDS);
};

const sanitizeStrategy = (entry: unknown): unknown => {
  const row = asRecord(entry);
  if (row === null) return sanitizeNonArray(entry);
  const next = pickFields(row, STRATEGY_FIELDS);
  if (row["kind"] !== "stock" || row["hypothetical"] === true) {
    Object.assign(next, pickFields(row, STOCK_FIELDS));
  }
  if ("legs" in row) {
    next["legs"] = Array.isArray(row["legs"])
      ? row["legs"].map(sanitizeLeg)
      : sanitizeNonArray(row["legs"]);
  }
  return next;
};

const copyPublicText = (
  root: JsonRecord,
  next: Record<string, unknown>,
  key: "title" | "summary"
): void => {
  if (!(key in root)) return;
  const value = root[key];
  if (typeof value !== "string" || !isPrivateResearchText(value)) {
    next[key] = value;
  }
};

/**
 * Removes private broker, portfolio, account, NLV and user-order text from `options-analysis`
 * payloads before they leave the server, while keeping public research text and the exact
 * structural fields that PayoffLab needs for charts and outcome counts.
 */
export const sanitizeResearchDatasetData = (
  dataset: ResearchReportDatasetName,
  data: unknown
): unknown => {
  if (dataset !== "options-analysis") return data;
  const root = asRecord(data);
  if (root === null) return data;

  const next: Record<string, unknown> = {};
  if ("asOf" in root) next["asOf"] = root["asOf"];
  if ("currency" in root) next["currency"] = root["currency"];
  copyPublicText(root, next, "title");
  copyPublicText(root, next, "summary");
  if ("metrics" in root) {
    next["metrics"] = sanitizeRecordList(root["metrics"], METRIC_FIELDS);
  }
  if ("sections" in root) {
    next["sections"] = Array.isArray(root["sections"])
      ? root["sections"].flatMap(sanitizeSection)
      : sanitizeNonArray(root["sections"]);
  }
  if ("sources" in root) {
    next["sources"] = sanitizeRecordList(root["sources"], SOURCE_FIELDS);
  }
  if ("warnings" in root) {
    next["warnings"] = filterTextList(root["warnings"]);
  }
  if ("strategies" in root) {
    next["strategies"] = Array.isArray(root["strategies"])
      ? root["strategies"].map(sanitizeStrategy)
      : sanitizeNonArray(root["strategies"]);
  }
  return next;
};
