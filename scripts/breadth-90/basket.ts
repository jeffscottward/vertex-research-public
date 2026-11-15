// The dip basket written by the trading research desk (schema dip-basket.v1, default
// ~/Documents/reports/trading/dip-basket/basket.json, override BREADTH90_BASKET). The tick reads the
// alert-ready summary, the report path, the rules note and the tiers; every field is optional and a
// missing or unreadable file only drops the basket lines. Research only: no orders are placed.

import { z } from "zod";

const TierSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  tickers: z.array(z.string()).optional(),
  weight_pct_nlv: z.number().optional(),
});

const BasketFileSchema = z
  .object({
    as_of: z.string().optional(),
    asOf: z.string().optional(),
    generatedAt: z.string().optional(),
    reportPath: z.string().optional(),
    rulesNote: z.string().optional(),
    summary: z.string().optional(),
    tiers: z.array(TierSchema).optional(),
  })
  .passthrough();

export type BasketTier = Readonly<{
  id: string;
  label: string;
  tickers: readonly string[];
  weightPctNlv: number | null;
}>;

export type BasketSummary = Readonly<{
  available: boolean;
  summary: string | null;
  reportPath: string | null;
  rulesNote: string | null;
  asOf: string | null;
  tiers: readonly BasketTier[];
  /** Alert lines: the summary, the report path and the rules note (empty when unavailable). */
  lines: readonly string[];
}>;

export const basketPathOf = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string =>
  env["BREADTH90_BASKET"] ??
  `${home}/Documents/reports/trading/dip-basket/basket.json`;

const UNAVAILABLE: BasketSummary = {
  asOf: null,
  available: false,
  lines: [],
  reportPath: null,
  rulesNote: null,
  summary: null,
  tiers: [],
};

export const readBasket = (text: string | null): BasketSummary => {
  if (text === null) {
    return UNAVAILABLE;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return UNAVAILABLE;
  }
  const parsed = BasketFileSchema.safeParse(raw);
  if (!parsed.success) {
    return UNAVAILABLE;
  }
  const file = parsed.data;
  // Clamped to the breadth90.collect contract limits, so one long field never fails every push.
  const tiers = (file.tiers ?? []).slice(0, 20).map((tier, index) => ({
    id: (tier.id ?? `tier-${index + 1}`).slice(0, 80),
    label: (tier.label ?? tier.id ?? `Tier ${index + 1}`).slice(0, 120),
    tickers: (tier.tickers ?? [])
      .slice(0, 100)
      .map((ticker) => ticker.slice(0, 16)),
    weightPctNlv: tier.weight_pct_nlv ?? null,
  }));
  const summary = file.summary?.trim().slice(0, 1000) || null;
  const reportPath = file.reportPath?.slice(0, 500) || null;
  const rulesNote = file.rulesNote?.slice(0, 1000) || null;
  const tierLine =
    tiers.length > 0
      ? `🧺 Tiers: ${tiers.map((tier) => `${tier.label}${tier.weightPctNlv === null ? "" : ` ${tier.weightPctNlv}% NLV`} (${tier.tickers.join(" ")})`).join(" · ")}`
      : null;
  const lines = [
    summary ? (summary.startsWith("🧺") ? summary : `🧺 ${summary}`) : tierLine,
    reportPath ? `📄 Report: ${reportPath}` : null,
    rulesNote ? `📏 ${rulesNote}` : null,
  ].filter((line): line is string => line !== null);
  return {
    asOf: (file.asOf ?? file.as_of ?? file.generatedAt)?.slice(0, 64) ?? null,
    available: true,
    lines,
    reportPath,
    rulesNote,
    summary,
    tiers,
  };
};
