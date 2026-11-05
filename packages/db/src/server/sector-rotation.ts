import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type {
  SectorRotationAlertDeliveryValue,
  SectorRotationQuadrantValue,
  SectorRotationTimeframeValue,
} from "../schema/index.ts";
import { sectorRotationAlerts, sectorRotationPoints } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Sector rotation points and quadrant alerts (sectorRotation.*). Points are recomputed nightly and
// upserted by (timeframe, symbol, date). Alerts are insert-once by (symbol, quadrant, entered_on),
// so a rerun never sends the same alert twice. Inputs are validated by the oRPC contract; the table
// checks enforce the same rules. Research only: no order path.

export type {
  SectorRotationAlertDeliveryValue,
  SectorRotationQuadrantValue,
  SectorRotationTimeframeValue,
} from "../schema/index.ts";

/** Rows one insert statement may hold (keeps each statement well under the parameter limit). */
export const SECTOR_ROTATION_UPSERT_BATCH = 500;

export type SectorRotationPointRecord = Readonly<{
  timeframe: SectorRotationTimeframeValue;
  symbol: string;
  benchmark: string;
  /** YYYY-MM-DD of the bar close. */
  date: string;
  ratio: number;
  momentum: number;
  quadrant: SectorRotationQuadrantValue;
  computedAt: Date;
}>;

export type SectorRotationPointQuery = Readonly<{
  timeframe: SectorRotationTimeframeValue;
  /** Inclusive YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive YYYY-MM-DD; omitted = no upper bound. */
  toDate?: string;
  /** Omitted = every stored symbol. */
  symbols?: readonly string[];
}>;

export type SectorRotationAlertKey = Readonly<{
  symbol: string;
  quadrant: SectorRotationQuadrantValue;
  /** YYYY-MM-DD of the first period in the new quadrant. */
  enteredOn: string;
}>;

export type SectorRotationRepository = Readonly<{
  /** Upserts by (timeframe, symbol, date); returns the number of rows written. */
  upsertPoints: (
    points: readonly SectorRotationPointRecord[]
  ) => Promise<number>;
  /** Points sorted by symbol, then date ascending. */
  listPoints: (
    query: SectorRotationPointQuery
  ) => Promise<SectorRotationPointRecord[]>;
  /** Insert-once with delivery "pending"; true only when this call created the alert. */
  recordAlert: (
    input: SectorRotationAlertKey & Readonly<{ line: string; createdAt: Date }>
  ) => Promise<boolean>;
  /** Settles the delivery of a recorded alert. */
  recordDelivery: (
    input: SectorRotationAlertKey &
      Readonly<{
        delivery: Exclude<SectorRotationAlertDeliveryValue, "pending">;
      }>
  ) => Promise<void>;
  /**
   * Records the result of the scheduler's chat post for an alert the server could not deliver.
   * Updates only a row whose delivery is "not-configured" or "failed"; never inserts. True only
   * when a row changed.
   */
  recordChatDelivery: (
    input: SectorRotationAlertKey & Readonly<{ delivery: "sent" | "failed" }>
  ) => Promise<boolean>;
}>;

export type SectorRotationRepositoryDependencies = Readonly<{
  now?: () => Date;
}>;

export const createSectorRotationRepository = (
  database: DatabaseExecutor,
  dependencies: SectorRotationRepositoryDependencies = {}
): SectorRotationRepository => {
  const now = dependencies.now ?? (() => new Date());
  return {
    listPoints: async (query) => {
      if (query.symbols !== undefined && query.symbols.length === 0) return [];
      const rows = await database
        .select()
        .from(sectorRotationPoints)
        .where(
          and(
            eq(sectorRotationPoints.timeframe, query.timeframe),
            gte(sectorRotationPoints.date, query.fromDate),
            query.toDate === undefined
              ? undefined
              : lte(sectorRotationPoints.date, query.toDate),
            query.symbols === undefined
              ? undefined
              : inArray(sectorRotationPoints.symbol, [...query.symbols])
          )
        )
        .orderBy(
          asc(sectorRotationPoints.symbol),
          asc(sectorRotationPoints.date)
        );
      return rows.map((row) => ({
        benchmark: row.benchmark,
        computedAt: row.computedAt,
        date: row.date,
        momentum: row.momentum,
        quadrant: row.quadrant,
        ratio: row.ratio,
        symbol: row.symbol,
        timeframe: row.timeframe,
      }));
    },
    recordAlert: async (input) => {
      const created = await database
        .insert(sectorRotationAlerts)
        .values({
          createdAt: input.createdAt,
          delivery: "pending",
          enteredOn: input.enteredOn,
          line: input.line,
          quadrant: input.quadrant,
          symbol: input.symbol,
          updatedAt: input.createdAt,
        })
        .onConflictDoNothing()
        .returning({ symbol: sectorRotationAlerts.symbol });
      return created.length > 0;
    },
    recordDelivery: async (input) => {
      await database
        .update(sectorRotationAlerts)
        .set({ delivery: input.delivery, updatedAt: now() })
        .where(
          and(
            eq(sectorRotationAlerts.symbol, input.symbol),
            eq(sectorRotationAlerts.quadrant, input.quadrant),
            eq(sectorRotationAlerts.enteredOn, input.enteredOn)
          )
        );
    },
    recordChatDelivery: async (input) => {
      const updated = await database
        .update(sectorRotationAlerts)
        .set({ delivery: input.delivery, updatedAt: now() })
        .where(
          and(
            eq(sectorRotationAlerts.symbol, input.symbol),
            eq(sectorRotationAlerts.quadrant, input.quadrant),
            eq(sectorRotationAlerts.enteredOn, input.enteredOn),
            inArray(sectorRotationAlerts.delivery, ["not-configured", "failed"])
          )
        )
        .returning({ symbol: sectorRotationAlerts.symbol });
      return updated.length > 0;
    },
    upsertPoints: async (points) => {
      let written = 0;
      for (
        let start = 0;
        start < points.length;
        start += SECTOR_ROTATION_UPSERT_BATCH
      ) {
        const batch = points.slice(start, start + SECTOR_ROTATION_UPSERT_BATCH);
        await database
          .insert(sectorRotationPoints)
          .values(
            batch.map((point) => ({
              benchmark: point.benchmark,
              computedAt: point.computedAt,
              date: point.date,
              momentum: point.momentum,
              quadrant: point.quadrant,
              ratio: point.ratio,
              symbol: point.symbol,
              timeframe: point.timeframe,
            }))
          )
          .onConflictDoUpdate({
            set: {
              benchmark: sql`excluded.benchmark`,
              computedAt: sql`excluded.computed_at`,
              momentum: sql`excluded.momentum`,
              quadrant: sql`excluded.quadrant`,
              ratio: sql`excluded.ratio`,
            },
            target: [
              sectorRotationPoints.timeframe,
              sectorRotationPoints.symbol,
              sectorRotationPoints.date,
            ],
          });
        written += batch.length;
      }
      return written;
    },
  };
};
