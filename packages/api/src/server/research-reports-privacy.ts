import type { ResearchReportDatasetName } from "../contracts/research-reports.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

const PRIVATE_SECTION_IDS: Readonly<Record<string, true>> = {
  entry: true,
};

const PRIVATE_RESEARCH_TEXT =
  /\b(?:ibkr|interactive\s+brokers|broker(?:age|s)?|nlv|net\s+liquidation|portfolio(?:s)?|account(?:s)?|user[- ]?orders?|(?:limit|market|stop|share|pending|open|working|filled|active|resting)\s+orders?|(?:order|orders)\s+(?:pending|filled|working|open|placed|submitted|resting)|filled|existing\s+(?:position|holding|shares)|current\s+(?:position|holding|shares|exposure))\b/iu;

const STRATEGY_FIELDS = [
  "kind",
  "expiry",
  "multiplier",
  "hypothetical",
  "stockShares",
  "stockEntry",
] as const;

const LEG_FIELDS = ["side", "type", "strike", "premium", "multiplier"] as const;

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

const filterTextList = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.filter(
    (item) => typeof item !== "string" || !isPrivateResearchText(item)
  );
};

const filterRecordList = (value: unknown, keys: readonly string[]): unknown => {
  if (!Array.isArray(value)) return value;
  return value.filter((entry) => {
    const item = asRecord(entry);
    return item === null || !hasPrivateField(item, keys);
  });
};

const sanitizeSection = (entry: unknown): readonly unknown[] => {
  const section = asRecord(entry);
  if (section === null) return [entry];
  if (
    PRIVATE_SECTION_IDS[String(section["id"])] === true ||
    hasPrivateField(section, ["title"])
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
  if (leg === null) return typeof entry === "string" ? null : entry;
  const next: Record<string, unknown> = {};
  for (const field of LEG_FIELDS) {
    if (field in leg) next[field] = leg[field];
  }
  return next;
};

const sanitizeStrategy = (entry: unknown): unknown => {
  const row = asRecord(entry);
  if (row === null) return typeof entry === "string" ? null : entry;
  const next: Record<string, unknown> = {};
  for (const field of STRATEGY_FIELDS) {
    if (field in row) next[field] = row[field];
  }
  if ("legs" in row) {
    next["legs"] = Array.isArray(row["legs"])
      ? row["legs"].map(sanitizeLeg)
      : row["legs"];
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
    next["metrics"] = filterRecordList(root["metrics"], [
      "label",
      "value",
      "period",
    ]);
  }
  if ("sections" in root) {
    next["sections"] = Array.isArray(root["sections"])
      ? root["sections"].flatMap(sanitizeSection)
      : root["sections"];
  }
  if ("sources" in root) {
    next["sources"] = filterRecordList(root["sources"], ["id", "title", "url"]);
  }
  if ("warnings" in root) {
    next["warnings"] = filterTextList(root["warnings"]);
  }
  if ("strategies" in root) {
    next["strategies"] = Array.isArray(root["strategies"])
      ? root["strategies"].map(sanitizeStrategy)
      : root["strategies"];
  }
  return next;
};
