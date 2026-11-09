import {
  MarketDailySeriesInputError,
  type MarketDailySeriesRepository,
  type OpenbbOptionIvDailyRow,
  type OpenbbRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  OPENBB_CORE7,
  OPENBB_IV_PERCENTILE_MIN_SESSIONS,
  OPENBB_VOL_INDEX_IDS,
} from "../contracts/openbb.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// OpenBB procedures (openbb.*, docs/vertex-rebuild/openbb.md). Operator-only. ingest and recordRun
// (scheduler, scripts/openbb/tick.ts) also need an agent API key, like sectorRotation.collect; they
// upsert by primary key, so a repeated batch is harmless. Vol index closes go to the market daily
// series tables (kind `index`, source `cboe`). The reads are read-only. Research only: no orders.

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<{
  BAD_REQUEST: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const DAY_MS = 86_400_000;
const VX_EARLIER_SESSIONS = 5;
const CLOSES_LOOKBACK_DAYS = 30;
const SEC_FILINGS_LIMIT = 25;
const SEC_INSIDER_LIMIT = 50;
const FTD_LIMIT = 60;
const SHORTS_FTD_LIMIT = 500;
/** Default history of openbb.macro and daily openbb.factors (a year with margin). */
const DEFAULT_HISTORY_DAYS = 400;
/** Default history of monthly openbb.factors (ten years). */
const DEFAULT_MONTHLY_HISTORY_DAYS = 3653;

const systemClock = (): Date => new Date();
let clock = systemClock;

/** Test seam: fixes "today" for the default date windows. */
export const setOpenbbClockForTesting = (next: (() => Date) | null): void => {
  clock = next ?? systemClock;
};

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

/** Calendar date in New York (`YYYY-MM-DD`) shifted by `days`. */
const nyDate = (days = 0, from?: string): string => {
  const base = from ?? NY_DATE.format(clock());
  return new Date(Date.parse(`${base}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
};

const repositoriesFor = (
  context: ApiContext,
  failures: Failures
): Readonly<{
  openbb: OpenbbRepository;
  series: MarketDailySeriesRepository;
}> => {
  const { marketDailySeries, openbb } = context.repositories;
  if (openbb === undefined || marketDailySeries === undefined)
    throw failures.STORAGE_ERROR();
  return { openbb, series: marketDailySeries };
};

const requireWriteKey = (
  context: ApiContext,
  failures: Failures,
  procedure: string
): void => {
  if (context.agentApiKeyPresented !== true)
    throw failures.FORBIDDEN({
      message: `openbb.${procedure} needs an agent API key`,
    });
};

const sha256Hex = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/**
 * IV percentile of the newest row: the percentile (0..100) of its atm_iv_30d among the stored values of
 * the window (the newest 252 sessions), as the share of the other values strictly below it. Null
 * when the newest value is missing or fewer than 20 sessions have a value.
 */
export const openbbIvPercentile = (
  rows: readonly Pick<OpenbbOptionIvDailyRow, "atmIv30d">[]
): number | null => {
  const latest = rows.at(-1)?.atmIv30d ?? null;
  const values = rows.flatMap((row) =>
    row.atmIv30d === null ? [] : [row.atmIv30d]
  );
  if (latest === null || values.length < OPENBB_IV_PERCENTILE_MIN_SESSIONS)
    return null;
  const below = values.filter((value) => value < latest).length;
  return (100 * below) / (values.length - 1);
};

type Close = Readonly<{ close: number; date: string }>;

/** top / bottom when both closes are from the same session (and bottom is not 0), else null. */
const ratio = (top: Close | undefined, bottom: Close | undefined) =>
  top === undefined ||
  bottom === undefined ||
  top.date !== bottom.date ||
  bottom.close === 0
    ? null
    : top.close / bottom.close;

const ingest = api.openbb.ingest
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    requireWriteKey(context, failures, "ingest");
    const { openbb, series } = repositoriesFor(context, failures);
    const { batch } = input;
    let written = 0;
    if (batch.table === "daily_series") {
      const byId = new Map<string, typeof batch.rows>();
      for (const row of batch.rows)
        byId.set(row.seriesId, [...(byId.get(row.seriesId) ?? []), row]);
      for (const [id, rows] of byId) {
        const points = rows.map(({ seriesId: _id, ...point }) => ({
          ...point,
          adjClose: null,
        }));
        try {
          await series.upsertPoints(
            {
              id,
              kind: "index",
              source: "cboe",
              sourceSha256: await sha256Hex(JSON.stringify(points)),
            },
            points
          );
        } catch (error) {
          if (error instanceof MarketDailySeriesInputError)
            throw failures.BAD_REQUEST({ message: `${id}: ${error.message}` });
          throw error;
        }
        written += new Set(points.map((point) => point.date)).size;
      }
    } else if (batch.table === "macro_points")
      written = await openbb.upsertMacroPoints(batch.rows);
    else written = await openbb.upsertRows(batch.table, batch.rows as never);
    return { received: batch.rows.length, table: batch.table, written };
  });

const recordRun = api.openbb.recordRun
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    requireWriteKey(context, failures, "recordRun");
    const { openbb } = repositoriesFor(context, failures);
    const run = await openbb.recordRun({
      ...input,
      finishedAt: new Date(input.finishedAt),
      startedAt: new Date(input.startedAt),
    });
    return { id: run.id };
  });

const status = api.openbb.status
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const [runs, tables] = await Promise.all([
      openbb.latestRuns(),
      openbb.tableStats(),
    ]);
    return { runs, tables };
  });

const volContext = api.openbb.volContext
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb, series } = repositoriesFor(
      context,
      errors as unknown as Failures
    );
    const asOf = input.asOf ?? null;
    const [loaded, curveDates, ivRows, term] = await Promise.all([
      series.loadSeries(OPENBB_VOL_INDEX_IDS, {
        from: nyDate(-CLOSES_LOOKBACK_DAYS, asOf ?? undefined),
        ...(asOf === null ? {} : { to: asOf }),
      }),
      openbb.vxCurveDates(asOf, VX_EARLIER_SESSIONS + 1),
      openbb.optionIvDaily(OPENBB_CORE7, asOf),
      openbb.optionIvTermLatest(asOf),
    ]);
    const indices = OPENBB_VOL_INDEX_IDS.flatMap((id) => {
      const columns = loaded.get(id);
      const date = columns?.dates.at(-1);
      return columns === undefined || date === undefined
        ? []
        : [{ close: columns.close.at(-1) as number, date, id }];
    });
    const close = (id: string) => indices.find((index) => index.id === id);
    const latestDate = curveDates[0];
    const earlierDate = curveDates[VX_EARLIER_SESSIONS];
    const curveRows = await openbb.vxCurve(
      [latestDate, earlierDate].filter((day) => day !== undefined)
    );
    const curve = (day: string | undefined) =>
      day === undefined
        ? null
        : {
            asOf: day,
            points: curveRows
              .filter((row) => row.asOf === day)
              .map(({ contractMonth, price }) => ({ contractMonth, price })),
          };
    const ivDaily = OPENBB_CORE7.flatMap((underlying) => {
      const rows = ivRows.filter((row) => row.underlying === underlying);
      const latest = rows.at(-1);
      return latest === undefined
        ? []
        : [
            {
              ...latest,
              ivPercentile: openbbIvPercentile(rows),
              sessions: rows.length,
            },
          ];
    });
    const dates = [
      ...indices.map((index) => index.date),
      ...ivDaily.map((row) => row.asOf),
      ...curveDates.slice(0, 1),
    ].sort();
    return {
      asOf: dates.at(-1) ?? null,
      indices,
      ivDaily,
      ratios: {
        vix3mVix6m: ratio(close("VIX3M"), close("VIX6M")),
        vix9dVix: ratio(close("VIX9D"), close("VIX")),
        vixVix3m: ratio(close("VIX"), close("VIX3M")),
      },
      term,
      vxCurve: { earlier: curve(earlierDate), latest: curve(latestDate) },
    };
  });

const cot = api.openbb.cot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const from = nyDate(-7 * input.weeks);
    const rows = await openbb.cot(input.market ?? null, from);
    return {
      from,
      rows: rows.map(({ spreading: _spreading, ...row }) => ({
        ...row,
        net: row.long - row.short,
      })),
    };
  });

const macro = api.openbb.macro
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const from = input.from ?? nyDate(-DEFAULT_HISTORY_DAYS);
    const series = await openbb.macroSeries(input.ids ?? null);
    const points = await openbb.macroPoints(
      series.map((row) => row.id),
      from
    );
    return {
      from,
      series: series.map((row) => ({
        ...row,
        points: points
          .filter((point) => point.seriesId === row.id)
          .map(({ date, value }) => ({ date, value })),
      })),
    };
  });

const events = api.openbb.events
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const from = input.from ?? nyDate(-7);
    const to = input.to ?? nyDate(30);
    return {
      events: await openbb.events(from, to, input.kinds ?? null),
      from,
      to,
    };
  });

const shorts = api.openbb.shorts
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const from = nyDate(-input.days);
    const [shortVolume, shortInterest, otcWeekly, ftd] = await Promise.all([
      openbb.shortVolume(input.symbol, from),
      openbb.shortInterest(input.symbol, from),
      openbb.otcWeekly(input.symbol, from),
      openbb.ftd(input.symbol, from, SHORTS_FTD_LIMIT),
    ]);
    return {
      from,
      ftd,
      otcWeekly,
      shortInterest,
      shortVolume: shortVolume.map((row) => ({
        ...row,
        shortRatio:
          row.totalVolume > 0 ? row.shortVolume / row.totalVolume : null,
      })),
      symbol: input.symbol,
    };
  });

const sec = api.openbb.sec
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const [filings, insiderTrades, ftd] = await Promise.all([
      openbb.secFilings(input.symbol, SEC_FILINGS_LIMIT),
      openbb.insiderTrades(input.symbol, SEC_INSIDER_LIMIT),
      openbb.ftd(input.symbol, null, FTD_LIMIT),
    ]);
    // 13F rows match by their symbol; rows the fetcher could not map fall back to the CUSIPs
    // of the symbol's FTD rows.
    const holdings13f = await openbb.holdings13f(input.symbol, [
      ...new Set(ftd.map((row) => row.cusip)),
    ]);
    return { filings, ftd, holdings13f, insiderTrades, symbol: input.symbol };
  });

const factors = api.openbb.factors
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const { openbb } = repositoriesFor(context, errors as unknown as Failures);
    const from =
      input.from ??
      nyDate(
        input.frequency === "monthly"
          ? -DEFAULT_MONTHLY_HISTORY_DAYS
          : -DEFAULT_HISTORY_DAYS
      );
    return {
      from,
      frequency: input.frequency,
      rows: await openbb.factors(input.frequency, from),
    };
  });

export const openbbRouter = {
  cot,
  events,
  factors,
  ingest,
  macro,
  recordRun,
  sec,
  shorts,
  status,
  volContext,
};
