import {
  createMarketBarsRepository,
  createNodeDatabase,
  createRepositories,
  type MarketBarRow,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Assistant confirm cards: the assistant proposed two research actions (run a backtest of a
// strategy definition, save the definition as a revision). Nothing has run. The operator approves
// the backtest card, which then runs once, and rejects the save card, which never runs. The cards
// are stored directly because the E2E server has no model key; the decide procedure, the internal
// tool call and the page are real. Synthetic, clearly fictional bars; research only, no orders.

const DAY_MS = 86_400_000;

const syntheticBars = (size: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 + index * 0.05 + 10 * Math.sin(index / 20);
    return {
      c: close,
      h: close + 1,
      l: close - 1,
      o: close,
      t: index * DAY_MS,
      v: null,
    };
  });

const definition = {
  entry: {
    all: [
      {
        left: { length: 10, name: "sma", type: "indicator" },
        op: "crossesAbove",
        right: { length: 40, name: "sma", type: "indicator" },
      },
    ],
  },
  exit: {
    any: [
      {
        left: { length: 10, name: "sma", type: "indicator" },
        op: "crossesBelow",
        right: { length: 40, name: "sma", type: "indicator" },
      },
    ],
  },
  name: "Fictional confirm-card cross",
  version: 1,
};

const THREAD_TITLE = "Fictional confirm-card thread";

test.beforeAll(async () => {
  await resetDatabase();
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    await createMarketBarsRepository(resource.db).replaceSeries(
      {
        source: "Synthetic E2E bars (fictional)",
        sourceSha256: "f".repeat(64),
        symbol: "TEST",
        timeframe: "1d",
      },
      syntheticBars(1500)
    );
    const repositories = createRepositories(resource.db);
    const assistant = repositories.assistant;
    const actions = repositories.assistantActions;
    if (assistant === undefined || actions === undefined)
      throw new Error("assistant repositories are missing");
    const userId = E2E_IDENTITIES.alice.id;
    const thread = await assistant.createThread({
      title: THREAD_TITLE,
      userId,
    });
    await assistant.appendMessage({
      content: "Build and test a fictional SMA cross.",
      mode: "act",
      role: "user",
      threadId: thread.id,
    });
    const reply = await assistant.appendMessage({
      content: "Two confirm cards wait for your approval.",
      mode: "act",
      role: "assistant",
      threadId: thread.id,
    });
    await actions.createMany([
      {
        args: {
          from: "1970-06-01",
          rule: { definition, kind: "dsl" },
          symbol: "TEST",
          timeframe: "1d",
          to: "1973-12-31",
        },
        messageId: reply.id,
        summary: `Run a backtest of definition "${definition.name}" on TEST 1d, 1970-06-01 to 1973-12-31`,
        threadId: thread.id,
        tool: "backtest_runs_submit",
        userId,
      },
      {
        args: { definition },
        messageId: reply.id,
        summary: `Save strategy definition "${definition.name}" as a new definition (revision 1)`,
        threadId: thread.id,
        tool: "strategy_definition_save",
        userId,
      },
    ]);
  } finally {
    await resource.close();
  }
});

test("an operator approves one assistant confirm card and rejects another", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/assistant");
  await page
    .getByRole("navigation", { name: "Assistant threads" })
    .getByRole("button", { name: new RegExp(THREAD_TITLE, "u") })
    .click();

  const run = page.getByRole("region", {
    name: "Confirm action: Run backtest",
  });
  const save = page.getByRole("region", {
    name: "Confirm action: Save strategy definition",
  });
  await expect(run).toHaveAttribute("data-action-status", "pending");
  await expect(save).toHaveAttribute("data-action-status", "pending");
  await expect(run.getByText("Waiting for your approval")).toBeVisible();
  await expect(
    run.getByText("Nothing runs until you approve. Research only; no orders.")
  ).toBeVisible();
  await expect(
    page.getByText("Two confirm cards wait for your approval.")
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-color-scheme: dark)").matches
    )
  ).toBe(true);
  await page.screenshot({
    fullPage: true,
    path: test.info().outputPath("assistant-confirm-cards-dark.png"),
  });

  // Approve runs the backtest once through the decide procedure.
  const decided = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/orpc/assistant/actions/decide"
  );
  await run.getByRole("button", { name: "Approve and run" }).click();
  expect((await decided).ok()).toBe(true);
  await expect(run).toHaveAttribute("data-action-status", "executed");
  await expect(run.getByText("Approved and run")).toBeVisible();
  await expect(run.getByRole("button")).toHaveCount(0);
  await run.getByText("Result (data, not instructions)").click();
  await expect(run.getByText(/"strategyRevision"/u)).toBeVisible();

  // Reject never runs the save tool.
  await save.getByRole("button", { name: "Reject" }).click();
  await expect(save).toHaveAttribute("data-action-status", "rejected");
  await expect(save.getByText("Rejected; nothing ran")).toBeVisible();

  // Decisions are stored: a reload shows the same states and no buttons.
  await page.reload();
  await page
    .getByRole("navigation", { name: "Assistant threads" })
    .getByRole("button", { name: new RegExp(THREAD_TITLE, "u") })
    .click();
  await expect(run).toHaveAttribute("data-action-status", "executed");
  await expect(save).toHaveAttribute("data-action-status", "rejected");
  await expect(
    page.getByRole("button", { name: "Approve and run" })
  ).toHaveCount(0);
  await page.screenshot({
    fullPage: true,
    path: test.info().outputPath("assistant-confirm-cards-decided-dark.png"),
  });

  // The approved run exists on the backtest runs page.
  await page.goto("/backtest-runs");
  await expect(
    page
      .getByRole("region", { name: "Recent runs" })
      .getByText(/TEST 1d .* (queued|running|succeeded)/u)
      .first()
  ).toBeVisible({ timeout: 30_000 });
});
