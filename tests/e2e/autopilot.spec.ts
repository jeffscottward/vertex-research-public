import { join } from "node:path";
import {
  createAutopilotRepository,
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
} from "@darkfactory/db/server";
import type { Page } from "@playwright/test";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Autopilot: the page opens on the latest completed campaign with no clicks, an operator starts a
// campaign on synthetic bars, runs one tick, reads the leaderboard and a tearsheet, checks that
// "Request live" is always blocked, and sends a (seeded, fictional) verified candidate to the
// PAPER deployment-request flow. Research only; nothing is armed.

const DAY_MS = 86_400_000;
// Optional evidence copy of the screenshots (passing runs keep no test output).
const EVIDENCE_DIR = process.env["AUTOPILOT_EVIDENCE_DIR"] ?? "";
const SEEDED_NAME = "Seeded verified (fixture)";

const shot = async (page: Page, name: string) => {
  await page.screenshot({
    fullPage: true,
    path:
      EVIDENCE_DIR === ""
        ? test.info().outputPath(name)
        : join(EVIDENCE_DIR, name),
  });
};

const syntheticBars = (size: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 * Math.exp(0.0008 * index) + 4 * Math.sin(index / 6.4);
    return {
      c: close,
      h: close + 0.5,
      l: close - 0.5,
      o: close,
      t: Date.UTC(2015, 0, 1) + index * DAY_MS,
      v: null,
    };
  });

const passedCheck = (id: string, label: string) => ({
  detail: "Fictional E2E fixture.",
  id,
  label,
  passed: true,
  threshold: "fixture",
  value: 1,
});

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
      syntheticBars(900)
    );
    // Autopilot tables are not part of the E2E reset: every run seeds fresh ids.
    const run = crypto.randomUUID();
    let next = 0;
    const repository = createAutopilotRepository(resource.db, {
      generateId: () => {
        next += 1;
        return `e2e-seeded-${run}-${next}`;
      },
      now: () => new Date(),
    });
    const campaign = await repository.createCampaign({
      config: {
        budget: {
          gatePerGeneration: 1,
          maxCandidates: 20,
          maxCpuMinutes: 1,
          populationSize: 4,
          tickSeconds: 2,
        },
        costBps: 5,
        gateVersion: "autopilot-gate-v1",
        seed: 1,
      },
      createdBy: "e2e",
      name: SEEDED_NAME,
      symbol: "TEST",
      timeframe: "1d",
    });
    // Completed and newest, so it is the campaign the page opens on by default.
    await repository.transitionCampaign({ id: campaign.id, to: "completed" });
    const definition = {
      entry: {
        all: [
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: {
              length: 20,
              name: "ema",
              source: "close",
              type: "indicator",
            },
          },
        ],
      },
      exit: { any: [] },
      name: "AP TEST fixture",
      sizing: { mode: "allIn" },
      stopLoss: { kind: "none" },
      takeProfit: { kind: "none" },
      version: 1,
    };
    await repository.insertCandidates([
      {
        campaignId: campaign.id,
        definition,
        firstT: new Date("2015-01-01T00:00:00.000Z"),
        fitness: 2,
        generation: 0,
        genome: {
          entry: [{ block: "trendEma", params: [20] }],
          exit: [],
          stop: null,
          target: null,
        },
        genomeKey: "e2e-fixture",
        id: `e2e-verified-${run}`,
        inSample: {
          fitness: 2,
          maxDrawdown: -0.1,
          sharpe: 2,
          totalReturn: 0.4,
          trades: 30,
        },
        label: "trendEma(20) fixture",
        lastT: new Date("2016-06-01T00:00:00.000Z"),
        origin: "random",
        parentIds: [],
        returnsCount: 539,
        returnsMean: 0.0005,
        returnsStd: 0.01,
        series: "TEST/1d",
      },
    ]);
    await repository.recordGate({
      gate: {
        checks: [
          passedCheck("oosSharpe", "Out-of-sample Sharpe"),
          passedCheck("deflatedSharpe", "Deflated Sharpe ratio"),
          passedCheck("neighbours", "Parameter neighbourhood"),
        ],
        costStress: { costBps: 10, oosSharpe: 1 },
        curve: [
          { equity: 1, t: "2015-01-01T00:00:00.000Z" },
          { equity: 1.2, t: "2016-06-01T00:00:00.000Z" },
          { equity: 1.4, t: "2017-06-19T00:00:00.000Z" },
        ],
        deflatedSharpe: {
          expectedMaxSharpe: 0,
          probability: 0.99,
          sharpe: 0.1,
          trials: 1,
        },
        fdr: { discoveries: 1, qValue: 0.01, tested: 1 },
        folds: [],
        monteCarlo: {
          drawdownP5: -0.1,
          finalP5: 0.1,
          finalP50: 0.3,
          probabilityOfProfit: 0.95,
        },
        neighbours: [],
        oos: {
          cagr: 0.1,
          maxDrawdown: -0.05,
          sharpe: 1,
          totalReturn: 0.2,
          trades: 10,
        },
        passed: true,
        splitT: "2016-06-01T00:00:00.000Z",
        tradesTotal: 40,
        version: "autopilot-gate-v1",
      },
      id: `e2e-verified-${run}`,
      oosSharpe: 1,
      status: "verified",
    });
  } finally {
    await resource.close();
  }
});

test("an operator runs a campaign and sends a verified candidate to paper", async ({
  browserErrors,
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/autopilot");
  await expect(
    page.getByRole("heading", { level: 1, name: "Autopilot" })
  ).toBeVisible();

  // No input: the latest completed campaign opens with its candidates, and the URL stays clean.
  const campaign = page.getByRole("region", { name: "Campaign" });
  await expect(
    campaign.getByRole("heading", { name: SEEDED_NAME })
  ).toBeVisible();
  await expect(
    campaign
      .locator("table", { has: page.getByText("Gated candidates") })
      .getByRole("button", { name: "trendEma(20) fixture" })
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("campaign")).toBe(false);

  // Start a small campaign and run one tick from the page.
  const form = page.getByRole("region", { name: "New campaign" });
  await form.getByLabel("Name", { exact: true }).fill("E2E campaign");
  await form.getByLabel("Population per generation").fill("8");
  await form.getByLabel("Maximum candidates").fill("40");
  await form.getByLabel("Tick slice (seconds)").fill("3");
  await form.getByLabel("Gated per generation").fill("2");
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(form.getByText("Campaign started.")).toBeVisible();
  await expect(
    campaign.getByRole("heading", { name: "E2E campaign" })
  ).toBeVisible();
  // The selection is in the URL, so the view can be linked.
  await expect(page).toHaveURL(/[?&]campaign=/u);
  const campaignLink = page.url();
  await expect(
    campaign.getByText("Running", { exact: true }).first()
  ).toBeVisible();
  await campaign.getByRole("button", { name: "Run one tick now" }).click();
  const leaderboard = campaign.locator("table", {
    has: page.getByText("Leaderboard (best in-sample fitness)"),
  });
  await expect(leaderboard.locator("tbody tr").first()).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, "autopilot-campaign-dark.png");

  // A gated candidate shows its checklist, including the deflated Sharpe check.
  const gated = campaign.locator("table", {
    has: page.getByText("Gated candidates"),
  });
  await expect(gated.locator("tbody tr").first()).toBeVisible();
  await gated.locator("tbody tr").first().getByRole("button").click();
  const tearsheet = page.getByRole("region", { name: "Candidate tearsheet" });
  await expect(tearsheet.getByText("Gate checklist")).toBeVisible();
  await expect(
    tearsheet.getByText(/^Deflated Sharpe ratio: (pass|fail)$/u)
  ).toBeVisible();

  // The seeded verified candidate goes to paper; live stays blocked.
  await page
    .getByRole("region", { name: "Campaigns" })
    .getByRole("button", { name: SEEDED_NAME })
    .first()
    .click();
  // Check the selected campaign, not the URL: the E2E campaign may finish during its tick and
  // become the default.
  await expect(
    campaign.getByRole("heading", { name: SEEDED_NAME })
  ).toBeVisible();
  await campaign
    .locator("table", { has: page.getByText("Gated candidates") })
    .getByRole("button", { name: "trendEma(20) fixture" })
    .click();
  await expect(
    tearsheet.getByRole("heading", { name: "trendEma(20) fixture" })
  ).toBeVisible();
  await tearsheet.getByRole("button", { name: "Request live" }).click();
  await expect(
    tearsheet.getByText(
      "Live readiness: not allowed. Autopilot never requests or arms live trading."
    )
  ).toBeVisible();
  await expect(
    tearsheet.getByText("Master rule: options only: conflict.")
  ).toBeVisible();
  await tearsheet.getByRole("button", { name: "Send to paper" }).click();
  await expect(
    tearsheet.getByText(/Paper deployment request .+ is requested\./u)
  ).toBeVisible();
  await expect(
    tearsheet.getByRole("button", { name: "Send to paper" })
  ).toBeDisabled();
  await shot(page, "autopilot-paper-dark.png");

  // The Monitor tab reads the Quant VPS status endpoint, which E2E does not configure.
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/agentOps/deployment/status",
    status: 503,
  });
  await page.goto("/deployments");
  await page.getByRole("tab", { name: "Requests" }).click();
  await expect(
    page.getByText(/Autopilot TEST trendEma\(20\) fixture/u).first()
  ).toBeVisible();
  await shot(page, "autopilot-deployment-request-dark.png");

  // Narrow layout keeps the page usable, and the campaign link opens that campaign.
  await page.setViewportSize({ height: 900, width: 375 });
  await page.goto(campaignLink);
  await expect(
    page.getByRole("heading", { level: 1, name: "Autopilot" })
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Campaign" })
      .getByRole("heading", { name: "E2E campaign" })
  ).toBeVisible();
  await shot(page, "autopilot-375-dark.png");
});
