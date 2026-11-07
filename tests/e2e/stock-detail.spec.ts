import type { Page, Route } from "@playwright/test";

import {
  createFakeMarketDataGateway,
  createFakeOptionsChainGateway,
} from "../../apps/web/src/features/stock-detail/fake-gateways.ts";
import {
  E2E_IDENTITIES,
  expect,
  expectHydrated,
  signInAs,
  test,
} from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// /stock/<SYMBOL> and the /charts default state. Yahoo, IBKR and QuantData are not
// reachable in a browser run, so the market data RPCs answer with the deterministic
// DUMMY gateways the unit tests and the lab use. Read-only: no order path on these pages.

const optionsChain = createFakeOptionsChainGateway();
const marketData = createFakeMarketDataGateway();

// oRPC sends the input as {"json": input}: a POST body, or the `data` query value for GET.
const rpcInput = (route: Route): Record<string, unknown> => {
  const request = route.request();
  const raw: unknown =
    request.postData() === null
      ? JSON.parse(new URL(request.url()).searchParams.get("data") ?? "{}")
      : request.postDataJSON();
  const json: unknown =
    typeof raw === "object" && raw !== null ? Reflect.get(raw, "json") : null;
  return typeof json === "object" && json !== null
    ? (json as Record<string, unknown>)
    : {};
};

const reply = async (route: Route, json: unknown) =>
  await route.fulfill({
    body: JSON.stringify({ json }),
    contentType: "application/json",
    status: 200,
  });

const mockMarketData = async (page: Page) => {
  await page.route("**/api/orpc/marketData/bars**", async (route) => {
    const input = rpcInput(route);
    await reply(
      route,
      await marketData.bars({
        barSize: (input["barSize"] as "1 day" | undefined) ?? "1 day",
        symbol: String(input["symbol"] ?? "SPY"),
      })
    );
  });
  await page.route("**/api/orpc/optionsChain/chain**", async (route) => {
    const input = rpcInput(route);
    const expiry = input["expiry"];
    await reply(
      route,
      await optionsChain.chain({
        symbol: String(input["symbol"] ?? "SPY"),
        ...(typeof expiry === "string" ? { expiry } : {}),
      })
    );
  });
  // The analytics tab is not opened here; any snapshot request stays pending.
  await page.route("**/api/orpc/optionsAnalytics/snapshot**", () => undefined);
};

test.beforeAll(() => resetDatabase());

test("stock detail opens with chart and options chain, all Greeks, no input", async ({
  page,
}, testInfo) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ height: 1100, width: 1440 });
  await mockMarketData(page);
  await page.goto("/stock/NVDA");

  await expect(
    page.getByRole("heading", { level: 1, name: "NVDA" })
  ).toBeVisible();
  await expect(
    page.locator("[data-stock-chart=NVDA] canvas").first()
  ).toBeVisible({
    timeout: 20_000,
  });
  const split = page.locator("[data-chain-layout=split]");
  await expect(split).toBeVisible();
  for (const title of ["Delta", "Gamma", "Theta per day", "Implied volatility"])
    await expect(split.locator(`abbr[title="${title}"]`)).toHaveCount(2);
  await expect(split.locator("tr[data-atm]")).toHaveCount(1);
  for (const button of ["Overlay", "Study"])
    await expect(page.locator(`[data-chart-menu="${button}"]`)).toBeVisible();

  const expiry = page.getByRole("combobox", { name: "Expiry" });
  await expiry.selectOption("2026-12-18");
  await expect(page).toHaveURL(/\?expiry=2026-12-18$/u);
  await expect(page.locator('[data-options-chain="2026-12-18"]')).toBeVisible();

  await page.getByRole("button", { name: "1W" }).click();
  await expect(page).toHaveURL(/interval=1W/u);

  const screenshot = testInfo.outputPath("stock-detail-dark.png");
  await page.locator("main").screenshot({ path: screenshot });
  await testInfo.attach("stock-detail-dark", {
    contentType: "image/png",
    path: screenshot,
  });
});

test("stock detail stacks calls and puts on a phone", async ({ page }) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.setViewportSize({ height: 844, width: 390 });
  await mockMarketData(page);
  await page.goto("/stock/NVDA?tab=options");
  await expect(page.locator("[data-chain-layout=split]")).toBeHidden();
  await expect(page.locator("[data-chain-layout=calls]")).toBeVisible();
  await page.getByRole("button", { name: "Puts" }).click();
  await expect(page.locator("[data-chain-layout=puts]")).toBeVisible();
  // The page itself does not scroll sideways; only the table does.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("charts open on the SPY chart and change interval through the URL", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.setViewportSize({ height: 1100, width: 1440 });
  await mockMarketData(page);
  await page.goto("/charts");
  await expect(
    page.getByRole("heading", { level: 2, name: "SPY · 1D" })
  ).toBeVisible();
  // Contract settings stay closed: no request form fills the page.
  await expect(
    page.getByRole("combobox", { name: "Security type" })
  ).toBeHidden();
  // The heading is server-rendered; a click before hydration is lost.
  const hourly = page.getByRole("button", { name: "1h" });
  await expectHydrated(hourly);
  await hourly.click();
  await expect(page).toHaveURL(/\/charts\?symbol=SPY&interval=1h$/u);
  await page.getByRole("textbox", { name: "Symbol" }).fill("nvda");
  await page.getByRole("button", { exact: true, name: "Open" }).click();
  await expect(page).toHaveURL(/symbol=NVDA/u);
  await expect(
    page.getByRole("link", { name: "Options chain" })
  ).toHaveAttribute("href", "/stock/NVDA");
});
