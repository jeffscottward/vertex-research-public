import { desc, eq, sql } from "drizzle-orm";

import type {
  Breadth90BasketValue,
  Breadth90DayKindValue,
  Breadth90EventKindValue,
  Breadth90GradeValue,
  Breadth90StateValue,
  Breadth90TierValue,
  Breadth90TriggerValue,
} from "../schema/index.ts";
import {
  breadth90Days,
  breadth90Events,
  breadth90Status,
} from "../schema/index.ts";
import { type DatabaseExecutor, withTransaction } from "./client.ts";

// Breadth-90 signal store (breadth90.*). Sessions are upserted by date: a push overwrites the stored
// row unless that row is final and the push is not, so a closed session replaces its intraday value
// and a late intraday push never reverts a final one. The status only moves forward in asOf.
// Events are insert-once by (kind, date, tier), so a rerun never records an event twice. The status
// is one row per market ("nyse"). Inputs are validated by the oRPC contract; the table checks
// enforce the same rules. Research only: no order path.

export type {
  Breadth90BasketValue,
  Breadth90DayKindValue,
  Breadth90EventKindValue,
  Breadth90GradeValue,
  Breadth90StateValue,
  Breadth90TierValue,
  Breadth90TriggerValue,
} from "../schema/index.ts";

/** Rows one insert statement may hold (keeps each statement well under the parameter limit). */
export const BREADTH90_UPSERT_BATCH = 500;
/** The one status row the rig tick maintains. */
export const BREADTH90_STATUS_ID = "nyse";

export type Breadth90DayRecord = Readonly<{
  /** YYYY-MM-DD of the NYSE session. */
  date: string;
  uvol: number;
  dvol: number;
  adv: number;
  decl: number;
  upPct: number;
  advPct: number | null;
  kind: Breadth90DayKindValue;
  final: boolean;
  source: string;
  sourceAsOf: string;
}>;

export type Breadth90StoredDay = Breadth90DayRecord &
  Readonly<{ updatedAt: Date }>;

export type Breadth90EventRecord = Readonly<{
  kind: Breadth90EventKindValue;
  date: string;
  tier: Breadth90TierValue;
  upPct: number;
  advPct: number | null;
  armedOn: string | null;
  strict: boolean;
  trigger: Breadth90TriggerValue | null;
  grade: Breadth90GradeValue | null;
}>;

export type Breadth90StoredEvent = Breadth90EventRecord &
  Readonly<{ id: string; createdAt: Date }>;

export type Breadth90StatusRecord = Readonly<{
  state: Breadth90StateValue;
  armedOn: string | null;
  strict: boolean;
  sessionsLeft: number | null;
  asOf: Date;
  basket: Breadth90BasketValue | null;
}>;

export type Breadth90StoredStatus = Breadth90StatusRecord &
  Readonly<{ updatedAt: Date }>;

export type Breadth90Repository = Readonly<{
  /** Upserts by date (a non-final row never replaces a final one); returns the rows written. */
  upsertDays: (days: readonly Breadth90DayRecord[]) => Promise<number>;
  /** The newest `limit` sessions, newest first. */
  listRecentDays: (limit: number) => Promise<Breadth90StoredDay[]>;
  /** Insert-once by (kind, date, tier); returns the events this call created. */
  recordEvents: (
    events: readonly Breadth90EventRecord[]
  ) => Promise<Breadth90StoredEvent[]>;
  /** The newest `limit` events by session date, then creation time. */
  listRecentEvents: (limit: number) => Promise<Breadth90StoredEvent[]>;
  /** Replaces the single status row unless the stored one has a newer asOf. */
  saveStatus: (status: Breadth90StatusRecord) => Promise<void>;
  /** One push in one transaction: upsertDays, recordEvents, then saveStatus. */
  collect: (push: Breadth90CollectRecord) => Promise<Breadth90CollectResult>;
  /** The status row, or null before the first push. */
  getStatus: () => Promise<Breadth90StoredStatus | null>;
}>;

export type Breadth90CollectRecord = Readonly<{
  days: readonly Breadth90DayRecord[];
  events: readonly Breadth90EventRecord[];
  status: Breadth90StatusRecord;
}>;

export type Breadth90CollectResult = Readonly<{
  days: number;
  created: Breadth90StoredEvent[];
}>;

export type Breadth90RepositoryDependencies = Readonly<{
  now?: () => Date;
  generateId?: () => string;
}>;

type DayRow = typeof breadth90Days.$inferSelect;
type EventRow = typeof breadth90Events.$inferSelect;

const dayOf = (row: DayRow): Breadth90StoredDay => ({
  adv: row.adv,
  advPct: row.advPct,
  date: row.date,
  decl: row.decl,
  dvol: row.dvol,
  final: row.final,
  kind: row.kind,
  source: row.source,
  sourceAsOf: row.sourceAsOf,
  updatedAt: row.updatedAt,
  upPct: row.upPct,
  uvol: row.uvol,
});

const eventOf = (row: EventRow): Breadth90StoredEvent => ({
  advPct: row.advPct,
  armedOn: row.armedOn,
  createdAt: row.createdAt,
  date: row.date,
  grade: row.grade,
  id: row.id,
  kind: row.kind,
  strict: row.strict,
  tier: row.tier,
  trigger: row.trigger,
  upPct: row.upPct,
});

const batches = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += BREADTH90_UPSERT_BATCH)
    out.push(items.slice(start, start + BREADTH90_UPSERT_BATCH));
  return out;
};

export const createBreadth90Repository = (
  database: DatabaseExecutor,
  dependencies: Breadth90RepositoryDependencies = {}
): Breadth90Repository => {
  const now = dependencies.now ?? (() => new Date());
  const generateId = dependencies.generateId ?? (() => crypto.randomUUID());
  const repository: Breadth90Repository = {
    collect: (push) =>
      withTransaction(database, async (transaction) => {
        const scoped = createBreadth90Repository(transaction, {
          generateId,
          now,
        });
        const days = await scoped.upsertDays(push.days);
        const created = await scoped.recordEvents(push.events);
        await scoped.saveStatus(push.status);
        return { created, days };
      }),
    getStatus: async () => {
      const rows = await database
        .select()
        .from(breadth90Status)
        .where(eq(breadth90Status.id, BREADTH90_STATUS_ID))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        armedOn: row.armedOn,
        asOf: row.asOf,
        basket: row.basket,
        sessionsLeft: row.sessionsLeft,
        state: row.state,
        strict: row.strict,
        updatedAt: row.updatedAt,
      };
    },
    listRecentDays: async (limit) => {
      const rows = await database
        .select()
        .from(breadth90Days)
        .orderBy(desc(breadth90Days.date))
        .limit(limit);
      return rows.map(dayOf);
    },
    listRecentEvents: async (limit) => {
      const rows = await database
        .select()
        .from(breadth90Events)
        .orderBy(desc(breadth90Events.date), desc(breadth90Events.createdAt))
        .limit(limit);
      return rows.map(eventOf);
    },
    recordEvents: async (events) => {
      const created: Breadth90StoredEvent[] = [];
      const createdAt = now();
      for (const batch of batches(events)) {
        const rows = await database
          .insert(breadth90Events)
          .values(
            batch.map((event) => ({
              advPct: event.advPct,
              armedOn: event.armedOn,
              createdAt,
              date: event.date,
              grade: event.grade,
              id: generateId(),
              kind: event.kind,
              strict: event.strict,
              tier: event.tier,
              trigger: event.trigger,
              upPct: event.upPct,
            }))
          )
          .onConflictDoNothing({
            target: [
              breadth90Events.kind,
              breadth90Events.date,
              breadth90Events.tier,
            ],
          })
          .returning();
        created.push(...rows.map(eventOf));
      }
      return created;
    },
    saveStatus: async (status) => {
      const updatedAt = now();
      const values = {
        armedOn: status.armedOn,
        asOf: status.asOf,
        basket: status.basket,
        sessionsLeft: status.sessionsLeft,
        state: status.state,
        strict: status.strict,
        updatedAt,
      };
      await database
        .insert(breadth90Status)
        .values({ ...values, id: BREADTH90_STATUS_ID })
        .onConflictDoUpdate({
          set: values,
          // An older push (a delayed retry) never overwrites a newer status.
          setWhere: sql`excluded.as_of >= ${breadth90Status.asOf}`,
          target: breadth90Status.id,
        });
    },
    upsertDays: async (days) => {
      let written = 0;
      const updatedAt = now();
      for (const batch of batches(days)) {
        const rows = await database
          .insert(breadth90Days)
          .values(batch.map((day) => ({ ...day, updatedAt })))
          .onConflictDoUpdate({
            set: {
              adv: sql`excluded.adv`,
              advPct: sql`excluded.adv_pct`,
              decl: sql`excluded.decl`,
              dvol: sql`excluded.dvol`,
              final: sql`excluded.final`,
              kind: sql`excluded.kind`,
              source: sql`excluded.source`,
              sourceAsOf: sql`excluded.source_as_of`,
              updatedAt: sql`excluded.updated_at`,
              upPct: sql`excluded.up_pct`,
              uvol: sql`excluded.uvol`,
            },
            // A non-final push never replaces a stored final session.
            setWhere: sql`${breadth90Days.final} = false or excluded.final = true`,
            target: breadth90Days.date,
          })
          .returning({ date: breadth90Days.date });
        written += rows.length;
      }
      return written;
    },
  };
  return repository;
};
