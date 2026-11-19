// Fundamental and news/sentiment agents for the paper agent desk (ported from vertex-research PR #2).
// Both agents read accepted report datasets. They do not fetch, invent or score missing data;
// absent inputs stay explicit gaps. Evidence dated after the run date is never used: a dataset
// captured after `asOf` contributes no valuation, committee or catalyst view to that run.
import { z } from "zod";
import { dayOf, daysBetween, isFiniteNumber, roundTo } from "./technical.ts";

const optionalText = z.string().nullish().catch(null);
const records = z.array(z.unknown()).catch([]);

export const FundamentalsDataset = z.looseObject({
  asOf: optionalText,
  financialFacts: records,
  valuation: z.looseObject({ scenarios: records }).nullish().catch(null),
});
export const NewsDataset = z.looseObject({
  articles: records.optional(),
  asOf: optionalText,
  catalysts: records,
  items: records.optional(),
  risks: records,
});
export const CommitteeDataset = z.looseObject({
  asOf: optionalText,
  finalRecommendation: z
    .looseObject({
      headline: optionalText,
      horizon: optionalText,
      status: optionalText,
    })
    .nullish()
    .catch(null),
});

export type Fundamentals = z.infer<typeof FundamentalsDataset>;
export type News = z.infer<typeof NewsDataset>;
export type Committee = z.infer<typeof CommitteeDataset>;

const Dated = z.looseObject({
  category: optionalText,
  date: optionalText,
  title: z.string().min(1),
  url: optionalText,
});
const Scenario = z.looseObject({ id: z.string(), upsidePct: z.unknown() });
const Fact = z.looseObject({ asOf: z.unknown() });

export const parseAll = <T>(
  schema: z.ZodType<T>,
  values: readonly unknown[]
): T[] =>
  values.flatMap((value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

/** Dataset capture date at or before the run date; null when absent or captured later. */
export const usableOn = (
  asOfValue: string | null | undefined,
  runAsOf: string
): boolean => {
  const day = dayOf(asOfValue);
  return day !== null && day <= runAsOf;
};

const FUNDAMENTAL_GAPS = Object.freeze([
  "Analyst consensus estimates and forecast revisions are not collected.",
  "The next scheduled earnings date is not collected.",
]);

const NOT_APPLICABLE_ASSETS: Readonly<Record<string, true>> = {
  etf: true,
  future: true,
  index: true,
};

export type FundamentalResult = Readonly<{
  agent: "fundamental";
  status: "not-applicable" | "unavailable" | "evaluated";
  latestPeriodEnd: string | null;
  lastEarnings: Readonly<{ date: string; title: string }> | null;
  evidenceAgeDays: number | null;
  stale: boolean;
  baseCaseUpsidePct: number | null;
  valuationView: "base-case-upside" | "base-case-downside" | "unknown";
  committee: Readonly<{
    status: string | null;
    headline: string | null;
    horizon: string | null;
  }> | null;
  blocking: boolean;
  reasons: readonly string[];
  gaps: readonly string[];
}>;

const emptyFundamental = (
  status: "not-applicable" | "unavailable",
  reason: string,
  blocking: boolean
): FundamentalResult => ({
  agent: "fundamental",
  baseCaseUpsidePct: null,
  blocking,
  committee: null,
  evidenceAgeDays: null,
  gaps: blocking ? [...FUNDAMENTAL_GAPS] : [],
  lastEarnings: null,
  latestPeriodEnd: null,
  reasons: [reason],
  stale: blocking,
  status,
  valuationView: "unknown",
});

const lastEarningsOn = (news: News | null, asOf: string) =>
  parseAll(Dated, news?.items ?? news?.articles ?? [])
    .filter((item) => item.category === "earnings")
    .flatMap((item) => {
      const date = dayOf(item.date);
      return date !== null && date <= asOf ? [{ date, title: item.title }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1) ?? null;

const baseUpside = (fundamentals: Fundamentals): number | null => {
  const base = parseAll(Scenario, fundamentals.valuation?.scenarios ?? []).find(
    (scenario) => scenario.id === "base"
  );
  return base !== undefined && isFiniteNumber(base.upsidePct)
    ? roundTo(base.upsidePct, 2)
    : null;
};

const committeeView = (committee: Committee | null, asOf: string) => {
  const recommendation = committee?.finalRecommendation;
  if (!(recommendation && usableOn(committee?.asOf, asOf))) return null;
  return {
    headline: recommendation.headline ?? null,
    horizon: recommendation.horizon ?? null,
    status: recommendation.status ?? null,
  };
};

/** Fundamental agent: earnings evidence, base-case valuation and committee status as of `asOf`. */
export const fundamentalAgent = (
  input: Readonly<{
    fundamentals: Fundamentals | null;
    committee: Committee | null;
    news: News | null;
    assetType: string | null;
  }>,
  {
    asOf,
    maxStaleDays = 100,
  }: Readonly<{ asOf: string; maxStaleDays?: number }>
): FundamentalResult => {
  if (
    input.assetType !== null &&
    NOT_APPLICABLE_ASSETS[input.assetType] === true
  ) {
    return emptyFundamental(
      "not-applicable",
      `Company fundamentals do not apply to asset type ${input.assetType}.`,
      false
    );
  }
  const { fundamentals } = input;
  if (fundamentals === null)
    return emptyFundamental(
      "unavailable",
      "Fundamentals dataset is missing.",
      true
    );
  const captured = usableOn(fundamentals.asOf, asOf);
  const factDates = parseAll(Fact, fundamentals.financialFacts)
    .flatMap((fact) => {
      const day = dayOf(fact.asOf);
      return day !== null && day <= asOf ? [day] : [];
    })
    .sort();
  const lastEarnings = lastEarningsOn(input.news, asOf);
  const evidenceDate =
    lastEarnings?.date ?? (captured ? dayOf(fundamentals.asOf) : null);
  const ageDays =
    evidenceDate === null ? null : daysBetween(evidenceDate, asOf);
  const committee = committeeView(input.committee, asOf);
  const baseCaseUpsidePct = captured ? baseUpside(fundamentals) : null;
  const stale = ageDays === null || ageDays > maxStaleDays;
  const reasons: string[] = [];
  if (!captured)
    reasons.push(
      "Fundamentals dataset is dated after the run date or undated; its valuation view is excluded."
    );
  if (stale)
    reasons.push(
      ageDays === null
        ? "No dated earnings or fundamentals evidence at or before the run date."
        : `Latest earnings evidence is ${ageDays} days old (limit ${maxStaleDays}).`
    );
  if (committee?.status === "insufficient-data")
    reasons.push("Committee status is insufficient-data.");
  return {
    agent: "fundamental",
    baseCaseUpsidePct,
    blocking: reasons.length > 0,
    committee,
    evidenceAgeDays: ageDays,
    gaps: [...FUNDAMENTAL_GAPS],
    lastEarnings,
    latestPeriodEnd: factDates.at(-1) ?? null,
    reasons,
    stale,
    status: "evaluated",
    valuationView:
      baseCaseUpsidePct === null
        ? "unknown"
        : baseCaseUpsidePct > 0
          ? "base-case-upside"
          : "base-case-downside",
  };
};

const Stance = z.enum(["bull", "bear", "neutral"]);
export const SentimentFile = z.strictObject({
  asOf: z
    .string()
    .refine((value) => dayOf(value) !== null, "asOf must be an ISO date"),
  posts: z.array(
    z.looseObject({
      date: z
        .string()
        .refine(
          (value) => dayOf(value) !== null,
          "post date must be an ISO date"
        ),
      stance: Stance,
    })
  ),
  source: z.string().trim().min(1, "source is required"),
});
export type Sentiment = z.infer<typeof SentimentFile>;

export type SentimentResult =
  | Readonly<{ status: "unavailable" | "after-run-date"; reason: string }>
  | Readonly<{
      status: "supplied" | "stale";
      source: string;
      asOf: string;
      ageDays: number;
      posts: number;
      counts: Readonly<Record<z.infer<typeof Stance>, number>>;
      netBullPct: number | null;
      note: string;
    }>;

const sentimentView = (
  supplied: Sentiment | null,
  reportId: string,
  asOf: string,
  maxAgeDays: number
): SentimentResult => {
  if (supplied === null) {
    return {
      reason: `No X/social sentiment collector is configured. Supply private/agent-desk/sentiment/${reportId}.json to include it.`,
      status: "unavailable",
    };
  }
  const suppliedAsOf = dayOf(supplied.asOf) as string;
  if (suppliedAsOf > asOf) {
    return {
      reason: `Sentiment file is dated ${suppliedAsOf}, after the run date; it is excluded.`,
      status: "after-run-date",
    };
  }
  const counts = { bear: 0, bull: 0, neutral: 0 };
  const posts = supplied.posts.filter(
    (post) => (dayOf(post.date) as string) <= asOf
  );
  for (const post of posts) counts[post.stance]++;
  const ageDays = daysBetween(suppliedAsOf, asOf);
  return {
    ageDays,
    asOf: suppliedAsOf,
    counts,
    netBullPct:
      posts.length === 0
        ? null
        : roundTo(((counts.bull - counts.bear) / posts.length) * 100, 2),
    note: "Counts of supplied labels. They are not a verified market-wide sentiment measure.",
    posts: posts.length,
    source: supplied.source,
    status: ageDays > maxAgeDays ? "stale" : "supplied",
  };
};

export type NewsSentimentResult = Readonly<{
  agent: "news-sentiment";
  status: "unavailable" | "evaluated";
  latestNewsDate: string | null;
  newsAgeDays: number | null;
  recentItems: readonly Readonly<{
    date: string;
    title: string;
    category: string | null;
  }>[];
  upcomingCatalysts: readonly Readonly<{ date: string; title: string }>[];
  undatedWatchItems: readonly Readonly<{ title: string }>[];
  riskCount: number;
  sentiment: SentimentResult;
  gaps: readonly string[];
}>;

/** News and sentiment agent: dated news, catalysts, risks and supplied sentiment as of `asOf`. */
export const newsSentimentAgent = (
  input: Readonly<{
    news: News | null;
    sentiment: Sentiment | null;
    reportId: string;
  }>,
  {
    asOf,
    recentDays = 30,
    maxSentimentAgeDays = 3,
  }: Readonly<{
    asOf: string;
    recentDays?: number;
    maxSentimentAgeDays?: number;
  }>
): NewsSentimentResult => {
  const { news } = input;
  const items = parseAll(Dated, news?.items ?? news?.articles ?? []);
  const dated = items.flatMap((item) => {
    const date = dayOf(item.date);
    return date !== null && date <= asOf
      ? [{ category: item.category ?? null, date, title: item.title }]
      : [];
  });
  const latestNewsDate =
    dated
      .map((item) => item.date)
      .sort()
      .at(-1) ?? null;
  const newsAgeDays =
    latestNewsDate === null ? null : daysBetween(latestNewsDate, asOf);
  // The catalyst list and risks describe the view on the dataset's capture date; a list captured
  // after the run date would leak later knowledge, so it is excluded from that run.
  const current = news !== null && usableOn(news.asOf, asOf);
  const catalysts = current ? parseAll(Dated, news.catalysts) : [];
  const gaps: string[] = [];
  if (news !== null && !current)
    gaps.push(
      "News dataset is dated after the run date or undated; catalysts and risks are excluded."
    );
  if (newsAgeDays === null || newsAgeDays > recentDays)
    gaps.push(
      `No dated news in the last ${recentDays} days; the news dataset needs a refresh.`
    );
  return {
    agent: "news-sentiment",
    gaps,
    latestNewsDate,
    newsAgeDays,
    recentItems: dated.filter(
      (item) => daysBetween(item.date, asOf) <= recentDays
    ),
    riskCount: current ? news.risks.length : 0,
    sentiment: sentimentView(
      input.sentiment,
      input.reportId,
      asOf,
      maxSentimentAgeDays
    ),
    status: items.length > 0 ? "evaluated" : "unavailable",
    undatedWatchItems: catalysts
      .filter((item) => dayOf(item.date) === null)
      .map((item) => ({ title: item.title })),
    upcomingCatalysts: catalysts.flatMap((item) => {
      const date = dayOf(item.date);
      return date !== null && date > asOf ? [{ date, title: item.title }] : [];
    }),
  };
};
