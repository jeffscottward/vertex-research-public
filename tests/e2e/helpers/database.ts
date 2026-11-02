import { ensureDevelopmentSeedIdentity } from "@darkfactory/auth/server";
import { contactRateLimits } from "@darkfactory/db/schema";
import {
  createAgentModelRunsRepository,
  createNodeDatabase,
  type Database,
  resetDevelopment,
  seedDevelopment,
} from "@darkfactory/db/server";
import { type E2EEnvironment, e2eEnvironment } from "../env.ts";

const EXPECTED_SEED_IDENTITIES = 3;

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

/** Truncates every app table and re-seeds exactly the three E2E identities. */
export const resetDatabase = (
  env: E2EEnvironment = e2eEnvironment()
): Promise<void> =>
  withRunDatabase(env, async (database) => {
    await resetDevelopment(database, { environment: "test" });
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
  });

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
