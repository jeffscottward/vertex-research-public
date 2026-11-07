import { ensureDevelopmentSeedIdentity } from "@darkfactory/auth/server";
import {
  backtestRuns,
  contactRateLimits,
  forwardDriftMonitors,
  marketBarSeries,
} from "@darkfactory/db/schema";
import {
  createAgentModelRunsRepository,
  createNodeDatabase,
  createSectorRotationRepository,
  type Database,
  resetDevelopment,
  seedDevelopment,
} from "@darkfactory/db/server";
import { type E2EEnvironment, e2eEnvironment } from "../env.ts";

const EXPECTED_SEED_IDENTITIES = 3;
const RESET_ATTEMPTS = 3;

// SQLSTATE deadlock_detected. The app server and its research worker keep querying while a spec
// resets; Postgres then aborts one side and rolls its transaction back, so the reset runs again.
const DEADLOCK_DETECTED = "40P01";

/** The driver error code, looking through at most a few `cause` links (cycles end). */
const pgCode = (error: unknown, depth = 0): unknown => {
  if (depth > 5 || typeof error !== "object" || error === null)
    return undefined;
  const { cause, code } = error as { cause?: unknown; code?: unknown };
  return code ?? pgCode(cause, depth + 1);
};

const retryOnDeadlock = async <T>(work: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= RESET_ATTEMPTS || pgCode(error) !== DEADLOCK_DETECTED)
        throw error;
    }
  }
};

const withRunDatabase = async <T>(
  env: E2EEnvironment,
  work: (database: Database) => Promise<T>
): Promise<T> => {
  const resource = createNodeDatabase({
    connectionString: env.databaseUrl,
    maxConnections: 1,
  });
  try {
    return await work(resource.db);
  } finally {
    await resource.close();
  }
};

/**
 * Truncates every app table, removes every stored bar series and backtest run, and re-seeds
 * exactly the three E2E identities. Bars and runs are not user data, so the product reset keeps
 * them; a spec still must not see another spec's symbols (the Core 7 default universe opens on
 * its first stored member) or builder runs (the strategy builder reopens the newest one).
 */
export const resetDatabase = (
  env: E2EEnvironment = e2eEnvironment()
): Promise<void> =>
  withRunDatabase(env, async (database) => {
    await retryOnDeadlock(() =>
      resetDevelopment(database, { environment: "test" })
    );
    // Monitors restrict run deletes (their alerts cascade); bars cascade from their series.
    await database.delete(forwardDriftMonitors);
    await database.delete(backtestRuns);
    await database.delete(marketBarSeries);
    const seeded = await seedDevelopment(database, {
      environment: "test",
      prepareIdentity: (identities) =>
        ensureDevelopmentSeedIdentity(
          {
            baseURL: env.appUrl,
            environment: "test",
            secret: env.authSecret,
            trustedOrigins: [env.appUrl],
          },
          identities
        ),
    });
    if (
      seeded.identitiesCreated !== EXPECTED_SEED_IDENTITIES ||
      seeded.usersConverged !== EXPECTED_SEED_IDENTITIES
    ) {
      throw new Error("E2E seed did not create exactly three identities");
    }
    await seedSectorRotation(database);
  });

// The 11 sector ETFs of SECTOR_ROTATION_SECTORS (packages/api). Technology moves from
// Improving to Leading between the two days, so the change list has one entry.
const E2E_SECTOR_QUADRANTS = [
  ["XLB", "lagging"],
  ["XLC", "leading"],
  ["XLE", "weakening"],
  ["XLF", "improving"],
  ["XLI", "leading"],
  ["XLK", "leading"],
  ["XLP", "lagging"],
  ["XLRE", "lagging"],
  ["XLU", "weakening"],
  ["XLV", "improving"],
  ["XLY", "leading"],
] as const;
const QUADRANT_POINT = {
  improving: { momentum: 101.2, ratio: 98.6 },
  lagging: { momentum: 98.9, ratio: 98.1 },
  leading: { momentum: 101.4, ratio: 102.3 },
  weakening: { momentum: 98.7, ratio: 101.8 },
} as const;

/** YYYY-MM-DD (UTC) of today and yesterday, the two stored daily sessions. */
export const e2eSectorRotationDates = (
  now: Date = new Date()
): Readonly<{ today: string; yesterday: string }> => ({
  today: now.toISOString().slice(0, 10),
  yesterday: new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10),
});

/**
 * Stores two daily sessions for every sector ETF, as the nightly collector does. Mission
 * control and Today read the daily snapshot on every load; without stored rows it answers
 * NOT_FOUND (HTTP 404), which every signed-in operator spec would see. Weekly stays
 * uncollected, so the sector rotation page still shows its not-yet-collected state there.
 */
const seedSectorRotation = async (database: Database): Promise<void> => {
  const { today, yesterday } = e2eSectorRotationDates();
  const computedAt = new Date();
  await createSectorRotationRepository(database).upsertPoints(
    E2E_SECTOR_QUADRANTS.flatMap(([symbol, quadrant]) =>
      [yesterday, today].map((date) => {
        const stored =
          symbol === "XLK" && date === yesterday ? "improving" : quadrant;
        return {
          benchmark: "SPY",
          computedAt,
          date,
          quadrant: stored,
          symbol,
          timeframe: "daily" as const,
          ...QUADRANT_POINT[stored],
        };
      })
    )
  );
};

/**
 * Empties the database-backed contact throttle. Every local submission shares
 * one throttle key, so a spec that really submits calls this before each
 * attempt, retries included.
 */
export const clearContactThrottle = (
  env: E2EEnvironment = e2eEnvironment()
): Promise<void> =>
  withRunDatabase(env, async (database) => {
    await database.delete(contactRateLimits);
  });

/**
 * Records one finished agent model run whose tool result is a 5000-character word, as the
 * fake Vibe-Trading driver emits, and returns its id. Narrow-layout checks use it.
 */
export const seedLongTextModelRun = (
  env: E2EEnvironment = e2eEnvironment()
): Promise<string> =>
  withRunDatabase(env, async (database) => {
    const repository = createAgentModelRunsRepository(database, {
      generateId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const { run } = await repository.record({
      decisionDate: "2026-06-08",
      framework: "vibe_trading",
      model: "stated",
      provider: "local",
      runKey: "e2e-long-text",
      status: "running",
      ticker: "QAA",
    });
    await repository.appendEvents(run.id, [
      {
        agent: "market_analyst",
        body: "x".repeat(5000),
        kind: "tool_result",
        seq: 0,
        title: "services/research/adapters/vibe_trading_framework.py",
      },
    ]);
    await repository.update({ id: run.id, rating: "buy", status: "succeeded" });
    return run.id;
  });
