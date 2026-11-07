import { createHash } from "node:crypto";
import { researchReports } from "@darkfactory/db/schema";
import {
  createMarketBarsRepository,
  createNodeDatabase,
  createResearchReportsRepository,
  type Database,
  type MarketBarRow,
  type ResearchDatasetInput,
} from "@darkfactory/db/server";
import type { Locator, Page, Route } from "@playwright/test";

import {
  ACADEMY_LESSONS,
  ACADEMY_MEDIA,
} from "../../packages/academy/src/lessons/index.ts";
import { e2eEnvironment } from "./env.ts";
import {
  type BrowserErrorGuard,
  E2E_IDENTITIES,
  expect,
  signInAs,
  test,
} from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Pages without other browser coverage: an Academy lesson, one research dossier, the Workspace
// settings tab, the signal alerts on /price-alerts and the engine comparison (dual run) on the
// instant backtest. Everything runs against the E2E server's own data: a fictional dossier and
// fictional daily bars seeded here, no provider and no Nautilus worker. Research only; no orders.

const PHONE = { height: 812, width: 375 } as const;

/** The document never scrolls sideways; wide content scrolls inside its own box. */
const expectNoPageOverflow = async (page: Page): Promise<void> => {
  const width = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1);
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------------------------
// Seed data: one fictional dossier and fictional daily bars for the instant backtest.

const REPORT_ID = "E2EFAKE";
const MISSING_REPORT_ID = "ZZZNONE";
const REPORT_REVISION = sha256("e2e fictional dossier revision 1");
const FUNDAMENTALS = {
  asOf: "2026-01-02",
  metrics: [
    { label: "Fictional revenue", period: "FY2025", value: 123 },
    { label: "Fictional margin", period: "FY2025", value: "45%" },
  ],
  sources: [{ title: "E2E fixture (no real source)" }],
  summary: "Made-up fundamentals for the browser test. Not a real company.",
  title: "Fictional fundamentals",
  warnings: ["Fixture data only"],
} as const;
const NEWS = {
  items: [
    {
      date: "2026-01-03",
      source: "E2E fixture wire",
      summary: "Nothing happened; this item is made up.",
      title: "Fictional headline for the E2E dossier",
    },
  ],
} as const;

const datasetBodies: Readonly<
  Record<ResearchDatasetInput["dataset"], object | null>
> = {
  committee: {},
  fundamentals: FUNDAMENTALS,
  market: {},
  news: NEWS,
  "options-analysis": {},
  // Private broker data is never stored: the importer keeps only its digest.
  portfolio: null,
  technicals: {},
};

const datasetInputs = (): ResearchDatasetInput[] =>
  Object.entries(datasetBodies).map(([dataset, data]) => {
    const body = data === null ? null : JSON.stringify(data);
    return {
      body,
      byteLength: body === null ? 0 : Buffer.byteLength(body, "utf8"),
      dataset: dataset as ResearchDatasetInput["dataset"],
      sha256: sha256(body ?? `${REPORT_ID} portfolio`),
    };
  });

const seedDossier = async (database: Database): Promise<void> => {
  await createResearchReportsRepository(database).replaceCatalog({
    categories: [],
    companyResearch: [],
    reports: [
      {
        assetType: "equity",
        companyResearch: null,
        dataRevision: REPORT_REVISION,
        id: REPORT_ID,
        identityStatus: "verified",
        metadata: {},
        name: "E2E Fictional Dossier Co",
        providerSymbol: REPORT_ID,
        sourceUpdatedAt: null,
        status: "complete",
        symbol: REPORT_ID,
      },
    ],
    revisions: [
      {
        dataRevision: REPORT_REVISION,
        datasets: datasetInputs(),
        reportId: REPORT_ID,
        source: "revision",
      },
    ],
  });
};

const DAY_MS = 86_400_000;
const BARS_SOURCE = "Synthetic E2E bars (fictional)";

const syntheticBars = (size: number): MarketBarRow[] =>
  Array.from({ length: size }, (_, index) => {
    const close = 100 + index * 0.05 + 10 * Math.sin(index / 40);
    return {
      c: close,
      h: close + 1,
      l: close - 1,
      o: close,
      t: index * DAY_MS,
      v: null,
    };
  });

const withRunDatabase = async (
  work: (database: Database) => Promise<unknown>
): Promise<void> => {
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    await work(resource.db);
  } finally {
    await resource.close();
  }
};

// resetDevelopment truncates user-owned tables only: research dossiers are imported catalog data
// and survive it, so this spec removes them itself. Revisions and datasets cascade from the report.
// The E2E database is per run and nothing else stores dossiers in it.
const removeDossiers = (): Promise<void> =>
  withRunDatabase((database) => database.delete(researchReports));

test.beforeAll(async () => {
  await resetDatabase();
  await removeDossiers();
  await withRunDatabase(async (database) => {
    await seedDossier(database);
    await createMarketBarsRepository(database).replaceSeries(
      {
        source: BARS_SOURCE,
        sourceSha256: "f".repeat(64),
        symbol: "TEST",
        timeframe: "1d",
      },
      syntheticBars(1500)
    );
  });
});

// Later specs that do not reset (research-markets-structure.spec.ts lists /research/reports) must
// not see the fictional dossier, the bars or the signal alert.
test.afterAll(async () => {
  await removeDossiers();
  await resetDatabase();
});

// ---------------------------------------------------------------------------------------------
// /academy/[slug]

// A concept lesson: a strategy lesson mounts its backtest and deploy preview, which read market
// data and the portfolio feed on load (packages/api/src/server/academy.ts).
const LESSON_INDEX = ACADEMY_LESSONS.findIndex(
  (lesson) => !(lesson.kind === "strategy" && lesson.backtest !== undefined)
);
const LESSON = ACADEMY_LESSONS[LESSON_INDEX];
const NEXT_LESSON = ACADEMY_LESSONS[LESSON_INDEX + 1];

/** Rendered lesson media are not committed, so each file answers 404 in E2E (route academy-media). */
const allowLessonMedia = (browserErrors: BrowserErrorGuard, slug: string) => {
  const media = ACADEMY_MEDIA[slug];
  if (media === undefined) return;
  for (const pathname of [media.video, media.captions, media.thumbnail])
    browserErrors.allowHttpError({ method: "GET", pathname, status: 404 });
};

test("an Academy lesson opens with its title, section links and transcript at 375 px", async ({
  browserErrors,
  page,
}) => {
  if (LESSON === undefined)
    throw new Error("the Academy has no concept lesson");
  allowLessonMedia(browserErrors, LESSON.slug);
  await page.setViewportSize(PHONE);
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto(`/academy/${LESSON.slug}`);

  const header = page.locator("header", {
    has: page.getByRole("heading", { level: 1, name: LESSON.title }),
  });
  await expect(header).toBeVisible();
  await expect(header.locator('[data-slot="page-status"]')).toHaveText(
    "Concept lesson"
  );
  // The portal top bar has its own Breadcrumb navigation; the lesson's sits in the page header.
  await expect(
    header
      .getByRole("navigation", { exact: true, name: "Breadcrumb" })
      .getByRole("link", { exact: true, name: "Academy" })
  ).toHaveAttribute("href", "/academy");

  const sections = page.getByRole("navigation", {
    exact: true,
    name: "Lesson sections",
  });
  await expect(sections.getByRole("link")).toHaveText([
    "Video",
    "Interactive example",
    "Transcript",
  ]);
  for (const heading of ["Chart video", "Interactive example", "Transcript"])
    await expect(
      page.getByRole("heading", { exact: true, level: 2, name: heading })
    ).toBeVisible();
  await expect(page.locator("[data-concept-note]")).toBeVisible();
  await expect(
    page
      .getByRole("region", { exact: true, name: "Key points" })
      .getByRole("heading", { exact: true, name: "Takeaways" })
  ).toBeVisible();

  await sections.getByRole("link", { exact: true, name: "Transcript" }).click();
  await expect(page).toHaveURL((url) => url.hash === "#transcript");
  await expect(page.locator("[data-transcript] > li")).toHaveCount(
    LESSON.source.transcript.length
  );
  if (NEXT_LESSON !== undefined)
    await expect(
      page
        .getByRole("navigation", { exact: true, name: "More lessons" })
        .getByRole("link", { name: NEXT_LESSON.title })
    ).toHaveAttribute("href", `/academy/${NEXT_LESSON.slug}`);
  await expectNoPageOverflow(page);
});

// ---------------------------------------------------------------------------------------------
// /research/reports/[reportId]

test("a research dossier opens on its first dataset and switches tabs at 375 px", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto(`/research/reports/${REPORT_ID}`);

  const header = page.locator("header", {
    has: page.getByRole("heading", { level: 1, name: `${REPORT_ID} dossier` }),
  });
  await expect(header).toBeVisible();
  await expect(header.locator('[data-slot="page-status"]')).toHaveText(
    "Research only"
  );
  await expect(
    header.getByRole("link", { exact: true, name: "Research dossiers" })
  ).toHaveAttribute("href", "/research/reports");
  // The catalog read resolves the report's ticker into a stock link.
  await expect(
    header.getByRole("link", { exact: true, name: REPORT_ID })
  ).toHaveAttribute("href", `/stock/${REPORT_ID}`);

  const tabs = page.getByRole("tablist", { exact: true, name: "Dataset" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Fundamentals",
    "Technicals",
    "Options analysis",
    "Committee",
    "News",
    "Market",
  ]);
  await expect(
    tabs.getByRole("tab", { exact: true, name: "Fundamentals" })
  ).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel");
  await expect(
    panel.getByRole("heading", { exact: true, name: "Fundamentals" })
  ).toBeVisible();
  await expect(
    panel.getByText(FUNDAMENTALS.title, { exact: true })
  ).toBeVisible();
  await expect(
    panel.getByText(FUNDAMENTALS.summary, { exact: true })
  ).toBeVisible();
  await expect(
    panel.getByText(`Revision ${REPORT_REVISION.slice(0, 12)}`)
  ).toBeVisible();
  for (const metric of FUNDAMENTALS.metrics)
    await expect(
      panel.getByRole("rowheader", { exact: true, name: metric.label })
    ).toBeVisible();
  await expectNoPageOverflow(page);

  await tabs.getByRole("tab", { exact: true, name: "News" }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "news");
  const news = page.getByRole("tabpanel");
  await expect(
    news
      .getByRole("list", { exact: true, name: "News items" })
      .getByText(NEWS.items[0].title, { exact: true })
  ).toBeVisible();

  await tabs.getByRole("tab", { exact: true, name: "Committee" }).click();
  await expect(
    page
      .getByRole("tabpanel")
      .getByText("This dataset has no summary or warnings.")
  ).toBeVisible();
  await expectNoPageOverflow(page);
});

test("an unknown dossier keeps its header and says the dataset is unavailable", async ({
  browserErrors,
  page,
}) => {
  browserErrors.allowHttpError({
    method: "POST",
    pathname: "/api/orpc/researchReports/dataset",
    status: 404,
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto(`/research/reports/${MISSING_REPORT_ID}`);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: `${MISSING_REPORT_ID} dossier`,
    })
  ).toBeVisible();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("alert")).toContainText(
    "Fundamentals dataset unavailable."
  );
  await expect(
    panel.getByRole("button", { exact: true, name: "Retry now" })
  ).toBeVisible();
});

// ---------------------------------------------------------------------------------------------
// /settings/workspace

test("the Workspace settings tab lists account and utility destinations at 375 px", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/settings/workspace");
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" })
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { exact: true, name: "Settings" })
      .getByRole("link", { exact: true, name: "Workspace" })
  ).toHaveAttribute("aria-current", "page");

  for (const heading of [
    "Account settings",
    "Session privacy and temporary data",
    "Workspace utilities",
  ])
    await expect(
      page.getByRole("heading", { exact: true, level: 2, name: heading })
    ).toBeVisible();

  const expectLinks = async (
    navigation: Locator,
    links: readonly (readonly [string, string])[]
  ) => {
    await expect(navigation.getByRole("link")).toHaveText(
      links.map(([name]) => name)
    );
    for (const [name, href] of links)
      await expect(
        navigation.getByRole("link", { exact: true, name })
      ).toHaveAttribute("href", href);
  };
  await expectLinks(
    page.getByRole("navigation", {
      exact: true,
      name: "Existing account settings",
    }),
    [
      ["Profile", "/settings/account/profile"],
      ["Address", "/settings/account/address"],
      ["Preferences", "/settings/account/preferences"],
      ["Security & sessions", "/settings/account/security"],
    ]
  );
  await expectLinks(
    page.getByRole("navigation", {
      exact: true,
      name: "Workspace utility destinations",
    }),
    [
      ["Module catalog", "/modules"],
      ["Connections", "/connections"],
      ["Audit", "/audit"],
    ]
  );
  await expectNoPageOverflow(page);
});

// ---------------------------------------------------------------------------------------------
// /price-alerts: signal and strategy alerts (LuxAlgo P4)

const SIGNAL_ALERT_NAME = "TEST 1d: close crosses above 123.45";

test("an operator creates and removes a custom signal alert at 375 px", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/price-alerts");
  await expect(
    page.getByRole("heading", { level: 1, name: "Price alerts" })
  ).toBeVisible();
  // The seeded watchlist is empty, so the price-level form points to the watchlist.
  await expect(page.getByText("Your watchlist is empty")).toBeVisible();

  const section = page.getByRole("region", {
    exact: true,
    name: "Signal alerts and watch mode",
  });
  await expect(section.getByText("None yet.", { exact: true })).toBeVisible();
  await expect(
    section.getByText("No fires yet.", { exact: true })
  ).toBeVisible();

  // Defaults: a strategy preset (SMA cross) on SPY 15m, once per bar close.
  const symbol = section.getByLabel("Symbol", { exact: true });
  const timeframe = section.getByLabel("Timeframe", { exact: true });
  const alertOn = section.getByLabel("Alert on", { exact: true });
  const condition = section.getByLabel("Condition", { exact: true });
  const frequency = section.getByLabel("Frequency", { exact: true });
  await expect(
    section.getByLabel("Ask Quant to watch", { exact: true })
  ).toBeEditable();
  await expect(
    section.getByRole("button", { exact: true, name: "Suggest a watch" })
  ).toBeDisabled();
  await expect(symbol).toHaveValue("SPY");
  await expect(timeframe).toHaveValue("15m");
  await expect(alertOn).toHaveValue("sma-cross");
  await expect(condition).toHaveValue("crosses-above");
  await expect(section.getByLabel("Fast SMA", { exact: true })).toHaveValue(
    "20"
  );
  await expect(section.getByLabel("Slow SMA", { exact: true })).toHaveValue(
    "50"
  );
  await expect(frequency).toHaveValue("per-bar-close");

  // A custom value line replaces the SMA fields and needs a value before it can be created.
  await alertOn.selectOption({ label: "Custom: price crosses a value" });
  await expect(section.getByLabel("Fast SMA", { exact: true })).toHaveCount(0);
  await expect(section.getByLabel("Slow SMA", { exact: true })).toHaveCount(0);
  const create = section.getByRole("button", {
    exact: true,
    name: "Create alert",
  });
  await expect(create).toBeDisabled();

  await symbol.fill("TEST");
  await timeframe.selectOption("1d");
  await condition.selectOption({ label: "Crossing up" });
  await section.getByLabel("Value", { exact: true }).fill("123.45");
  await frequency.selectOption({ label: "Only once" });
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      "/api/orpc/priceAlerts/signals/create"
  );
  await create.click();
  expect((await created).ok()).toBe(true);
  await expect(section.getByRole("status")).toHaveText(
    `Alert created: ${SIGNAL_ALERT_NAME}.`
  );

  const row = section.getByRole("listitem").filter({
    has: page.getByRole("button", {
      exact: true,
      name: `Remove ${SIGNAL_ALERT_NAME}`,
    }),
  });
  await expect(row).toContainText("close crosses above 123.45");
  await expect(row).toContainText("Only once");
  await expect(row).toContainText("Watching");
  await expectNoPageOverflow(page);

  // Stored: a reload lists the alert again.
  await page.reload();
  await expect(row).toContainText("fired 0");

  await row
    .getByRole("button", { exact: true, name: `Remove ${SIGNAL_ALERT_NAME}` })
    .click();
  await expect(section.getByRole("status")).toHaveText("Removed.");
  await expect(section.getByText("None yet.", { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------------------------
// Engine comparison (dual run) on /instant-backtest

const RUN_PATH = "/api/orpc/instantBacktest/run";
const COMPARISONS_PATH = "/api/orpc/backtestRuns/comparisons/list";

const openInstantBacktest = async (page: Page): Promise<void> => {
  await page.goto("/instant-backtest");
  await expect(
    page.getByRole("heading", { level: 1, name: "Instant backtest" })
  ).toBeVisible();
  await expect(page.locator("[data-instant-status]")).toHaveAttribute(
    "data-instant-status",
    "ready"
  );
  await expect(page.getByText(BARS_SOURCE)).toBeVisible();
};

test("with engine comparison off (the E2E default) the instant backtest shows no Nautilus card", async ({
  page,
}) => {
  // VERTEX_ENGINE_COMPARISON is not in the E2E app environment (tests/e2e/env.ts) and defaults to
  // "off" (packages/config/src/server.ts), so the run is never queued for Nautilus.
  const run = page.waitForResponse(
    (response) => new URL(response.url()).pathname === RUN_PATH
  );
  await signInAs(page, E2E_IDENTITIES.alice);
  await openInstantBacktest(page);
  const body = (await (await run).json()) as { json: Record<string, unknown> };
  expect(body.json).not.toHaveProperty("comparison");
  await expect(page.locator("[data-engine-comparison]")).toHaveCount(0);
  await expect(
    page.getByRole("region", { exact: true, name: "Nautilus result" })
  ).toHaveCount(0);
});

// The E2E server has comparison off and no research worker. The real run response gets the
// comparison timing the server adds when it is on; the Nautilus status is first read from the real
// comparisons list (empty for the fictional group), then a fictional finished run is returned.
const FAKE_GROUP = "e2e-fake-instant-group";
const FAKE_TS_HOST = "E2E fake web host";
const FAKE_RIG = "E2E fake rig";
const FAKE_TIMING = {
  groupId: FAKE_GROUP,
  host: FAKE_TS_HOST,
  wallMs: 4,
} as const;
const FAKE_DATE = "2026-01-02T00:00:00.000Z";

const fakeComparisonRun = {
  comparison: {
    feature: "instant",
    groupId: FAKE_GROUP,
    label: "E2E fake instant backtest",
    typescript: {
      host: FAKE_TS_HOST,
      stats: {
        bars: 1500,
        buyHoldMaxDrawdown: -0.1,
        buyHoldReturn: 0.5,
        cagr: 0.1,
        exposure: 0.5,
        maxDrawdown: -0.1,
        profitFactor: 1.5,
        sharpe: 1,
        sortino: 1,
        totalReturn: 0.2,
        trades: 10,
        winRate: 0.5,
      },
      tradeCount: 0,
      trades: [],
      wallMs: 4,
    },
  },
  createdAt: FAKE_DATE,
  differences: { items: [], ok: true },
  engineRun: {
    cpuMs: 10,
    gpu: "not used (Nautilus engine is CPU-only)",
    host: FAKE_RIG,
    processCases: 1,
    processes: 1,
    processWallMs: 20,
    wallMs: 12,
  },
  engineVersion: "e2e-fake",
  error: null,
  finishedAt: FAKE_DATE,
  from: "1970-01-01",
  id: "e2e-fake-comparison-run",
  queueWaitMs: 5,
  startedAt: FAKE_DATE,
  status: "succeeded",
  symbol: "TEST",
  timeframe: "1d",
  to: "1974-02-07",
} as const;

const addComparisonTiming = async (route: Route): Promise<void> => {
  const response = await route.fetch();
  const body = (await response.json()) as { json: Record<string, unknown> };
  body.json["comparison"] = FAKE_TIMING;
  await route.fulfill({ json: body, response });
};

// oRPC's RPC serializer marks dates in `meta` as [1, ...path].
const fulfillFinishedRun = (route: Route): Promise<void> =>
  route.fulfill({
    json: {
      json: { runs: [fakeComparisonRun] },
      meta: ["createdAt", "startedAt", "finishedAt"].map((field) => [
        1,
        "runs",
        0,
        field,
      ]),
    },
  });

test("a compared instant backtest shows the TypeScript line and the Nautilus card at 375 px", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.route(`**${RUN_PATH}`, addComparisonTiming);
  const firstRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === COMPARISONS_PATH
  );
  await openInstantBacktest(page);

  const comparison = page.locator('[data-engine-comparison="on"]');
  await expect(comparison.locator('[data-engine="typescript"]')).toHaveText(
    new RegExp(
      `^TypeScript · ${FAKE_TS_HOST} · (\\d+ ms|\\d+\\.\\d s) \\(round trip\\) · engine 4 ms$`,
      "u"
    )
  );
  const card = comparison.getByRole("region", {
    exact: true,
    name: "Nautilus result",
  });
  const read = await firstRead;
  expect(read.ok()).toBe(true);
  expect(await read.json()).toMatchObject({ json: { runs: [] } });
  await expect(card).toHaveAttribute("data-nautilus-card", "waiting");
  await expect(card).toHaveText("Nautilus · rig · queued");
  await expectNoPageOverflow(page);

  // The card polls every 2 s while no run is done; the next read finds the finished run.
  await page.route(`**${COMPARISONS_PATH}`, fulfillFinishedRun);
  await expect(card).toHaveAttribute("data-nautilus-card", "succeeded");
  await expect(card.locator("p").first()).toHaveText(
    `Nautilus · ${FAKE_RIG} · 12 ms (queue 5 ms)`
  );
  await expect(card.locator('[data-differences="0"]')).toHaveText("match");
  await expectNoPageOverflow(page);
});
