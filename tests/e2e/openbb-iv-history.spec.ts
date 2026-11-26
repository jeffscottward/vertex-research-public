import {
  createNodeDatabase,
  createOpenbbRepository,
} from "@darkfactory/db/server";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

const EMPTY_IBKR_VOLATILITY = {
  implied: null,
  sourceErrors: [],
  spread: null,
  spx: null,
  vix: null,
  vixeq: null,
  vvix: null,
};

const DAY_MS = 86_400_000;
type IvSource = "cboe" | "unknown";

const CORE_IV_SOURCES: ReadonlyArray<{
  underlying: string;
  source: IvSource;
  yahooAt?: number;
}> = [
  { underlying: "SPY", source: "cboe", yahooAt: 126 },
  { underlying: "QQQ", source: "cboe" },
  { underlying: "IWM", source: "unknown" },
];

const ivRow = (underlying: string, asOf: string, index: number) => ({
  asOf,
  atmIv30d: 0.2 + index / 10_000,
  callIv25d30d: 0.19,
  callOi: 10,
  callVolume: 5,
  callWall: 600,
  contracts: 1200,
  gammaFlip: 580,
  netGex: -1.5e9,
  putIv25d30d: 0.22,
  putOi: 12,
  putVolume: 6,
  putWall: 550,
  underlying,
  underlyingPrice: 590.25,
});

const seedIvHistory = async (): Promise<void> => {
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    const repository = createOpenbbRepository(resource.db);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days = Array.from({ length: 252 }, (_, index) =>
      new Date(today.getTime() - (251 - index) * DAY_MS)
        .toISOString()
        .slice(0, 10)
    );
    const rows = CORE_IV_SOURCES.flatMap(({ underlying, source, yahooAt }) =>
      days.map((asOf, index) => ({
        ...ivRow(underlying, asOf, index),
        source: yahooAt === index ? "yahoo_fallback" : source,
      }))
    );
    await repository.upsertRows("option_iv_daily", rows);
  } finally {
    await resource.close();
  }
};

test.beforeAll(async () => {
  await seedIvHistory();
});

test("shows IV history provenance without viewport overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // The unrelated monitor has no E2E service; OpenBB reads stay on the real test API and DB.
  await page.route("**/api/orpc/ibkrMonitor/volatility", (route) =>
    route.fulfill({ json: { json: EMPTY_IBKR_VOLATILITY, meta: [] } })
  );
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/markets");

  const table = page.getByRole("table", { name: "Core 7 IV" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Market context" })
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "IV history" })
  ).toBeVisible();
  await expect(
    table
      .getByRole("row")
      .filter({ hasText: "SPY" })
      .getByText("Yahoo IV in sample")
  ).toBeVisible();
  await expect(
    table.getByRole("row").filter({ hasText: "QQQ" }).getByText("Cboe only")
  ).toBeVisible();
  await expect(
    table
      .getByRole("row")
      .filter({ hasText: "IWM" })
      .getByText("Source not verified")
  ).toBeVisible();

  const tableContainer = page
    .locator('[data-slot="table-container"]')
    .filter({ has: table });
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1024, 900],
    [1440, 1000],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(tableContainer).toBeVisible();
    await expect
      .poll(() =>
        page.locator("html").evaluate((element) => element.clientWidth)
      )
      .toBe(width);
    const pageWidth = await page.locator("html").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(
      pageWidth.clientWidth + 1
    );
  }
});
