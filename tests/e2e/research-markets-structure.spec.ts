import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Research + Markets pages (card vertex-ui-research): each opens in a default state with no input,
// shows the Fulcrum page header (h1 + status chip) and never scrolls sideways at 375 px. Pages that
// call outside services on load (/research, /markets, the lens pages) have their own specs.

const PAGES = [
  { path: "/research/reports", title: "Research dossiers" },
  { path: "/news", title: "News monitor" },
  { path: "/baskets", title: "Baskets" },
  { path: "/papers", title: "Papers" },
  { path: "/academy", title: "Academy" },
  { path: "/knowledge", title: "Knowledge chat" },
] as const;

for (const { path, title } of PAGES)
  test(`${path} opens with its page header and fits 375 px`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 812, width: 375 });
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto(path);
    const header = page.locator("header", {
      has: page.getByRole("heading", { level: 1, name: title }),
    });
    await expect(header).toBeVisible();
    await expect(header.locator('[data-slot="page-status"]')).toBeVisible();
    const width = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1);
  });
