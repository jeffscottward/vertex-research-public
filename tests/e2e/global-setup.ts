import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createAcademyContentRepository,
  createNodeDatabase,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { importAcademyCourses } from "../../scripts/academy/import-lessons.ts";
import { DATABASE_COURSE_FIXTURE_CONTENT } from "../../scripts/academy/lessons/index.ts";
import { e2eEnvironment } from "./env.ts";
import { resetDatabase } from "./helpers/database.ts";
import {
  FAKE_ASSISTANT_MODEL_HOST,
  startFakeAssistantModel,
} from "./helpers/fake-assistant-model.ts";
import {
  FAKE_IBKR_RECOVERY_HOST,
  startFakeIbkrRecovery,
} from "./helpers/fake-ibkr-recovery.ts";
import { startPreviewCaptureServer } from "./helpers/preview-capture.ts";
import { runTeardown, type TeardownStep } from "./helpers/teardown.ts";

// Runs once per invocation, after the webServers are up. The app only opens the
// database per request, and its readiness probe (/robots.txt) needs none.
// The returned teardown runs before Playwright stops the webServers, so the app is
// still up when the database is dropped; the testkit drop ends its connections.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = e2eEnvironment();
  const database = await createPostgresTestDatabase({
    runId: `e2e_${env.runId}`,
  });
  // Teardown steps in setup order; runTeardown runs them one at a time, the last one first.
  const steps: TeardownStep[] = [
    {
      name: "remove the run directory",
      run: () => rm(env.runPaths.root, { force: true, recursive: true }),
    },
    {
      name: "drop the test database",
      run: () => dropPostgresTestDatabase(database),
    },
  ];
  try {
    if (database.databaseUrl !== env.databaseUrl) {
      throw new Error("E2E database differs from the one the app was given");
    }
    const resource = createNodeDatabase({
      connectionString: env.databaseUrl,
      maxConnections: 1,
    });
    try {
      await migrate(resource.db);
      // Database-backed Academy courses (QuantFinanceToGo) with synthetic sources: CI has no knowledge
      // base, and the real transcripts never enter the repository. Resets never truncate them.
      await importAcademyCourses(createAcademyContentRepository(resource.db), {
        content: DATABASE_COURSE_FIXTURE_CONTENT,
      });
    } finally {
      await resource.close();
    }
    await resetDatabase(env);
    const capture = await startPreviewCaptureServer({
      appOrigin: env.appUrl,
      authDirectory: env.runPaths.authPreviews,
      binding: { hmacKey: env.previewHmacKey, runId: env.runId },
      contactDirectory: env.runPaths.contactPreviews,
      port: env.capturePort,
    });
    steps.push({
      name: "close the preview capture server",
      run: () => capture.close(),
    });
    // Fake QuantVPS recovery service behind the run's HTTPS proxy (a static portless route).
    const recovery = await startFakeIbkrRecovery();
    steps.push({
      name: "close the fake IBKR recovery service",
      run: () => recovery.close(),
    });
    const portless = (args: string[]) =>
      promisify(execFile)("node_modules/.bin/portless", args, {
        env: env.proxyEnv,
      });
    await portless([
      "alias",
      FAKE_IBKR_RECOVERY_HOST,
      String(recovery.port),
      "--force",
    ]);
    steps.push({
      name: `remove the proxy alias ${FAKE_IBKR_RECOVERY_HOST}`,
      run: async () => {
        await portless(["alias", "--remove", FAKE_IBKR_RECOVERY_HOST]);
      },
    });
    // Fake chat completions model behind the same proxy (E2E_ASSISTANT_MODEL_URL).
    const model = await startFakeAssistantModel();
    steps.push({
      name: "close the fake assistant model",
      run: () => model.close(),
    });
    await portless([
      "alias",
      FAKE_ASSISTANT_MODEL_HOST,
      String(model.port),
      "--force",
    ]);
    steps.push({
      name: `remove the proxy alias ${FAKE_ASSISTANT_MODEL_HOST}`,
      run: async () => {
        await portless(["alias", "--remove", FAKE_ASSISTANT_MODEL_HOST]);
      },
    });
  } catch (error) {
    await runTeardown(steps);
    throw error;
  }
  return () => runTeardown(steps);
}
