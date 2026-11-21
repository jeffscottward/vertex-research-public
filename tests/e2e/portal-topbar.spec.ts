import type { Page } from "@playwright/test";
import {
  E2E_IDENTITIES,
  expect,
  expectHydrated,
  signInAs,
  test,
} from "./fixtures.ts";
import { findLayoutProblems } from "./helpers/evidence.ts";

// Portal top bar (Fulcrum structure): breadcrumb, search box that opens the command palette,
// quick actions. Checked at the four layout widths: from 768 px the sidebar takes 16rem, so the
// top bar is narrower there than at 640 px.

/** Visible top bar controls whose right edge passes the top bar's right edge. */
const controlsPastTopbar = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const topbar = document.querySelector('[data-slot="portal-topbar"]');
    if (topbar === null) return ["no top bar"];
    const right = topbar.getBoundingClientRect().right;
    return [...topbar.querySelectorAll("a, button")]
      .filter((control) => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && box.right > right + 1;
      })
      .map(
        (control) =>
          control.getAttribute("aria-label") ??
          control.textContent?.trim() ??
          control.tagName
      );
  });

for (const viewport of [
  { height: 812, width: 375 },
  { height: 900, width: 768 },
  { height: 900, width: 1024 },
  { height: 900, width: 1440 },
]) {
  test(`the top bar search opens the palette and offers a ticker at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/watchlist");
    const topbar = page.locator('[data-slot="portal-topbar"]');
    await expect(
      topbar.getByRole("navigation", { name: "Breadcrumb" })
    ).toBeVisible();
    const search = topbar
      .getByRole("button", { name: "Search ticker or page" })
      .filter({ visible: true });
    await expect(search).toHaveCount(1);
    await expect(
      topbar.getByRole("button", { name: /Alice Adams/u })
    ).toBeInViewport({ ratio: 1 });
    expect(await controlsPastTopbar(page)).toEqual([]);
    expect(await findLayoutProblems(page)).toEqual([]);
    await search.click();
    const dialog = page.getByRole("dialog", { name: "Jump to a page" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox").fill("nvda");
    await expect(
      dialog.getByRole("option", { name: /Open NVDA/u })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible();
  });
}

// From md the sidebar takes 16rem and from 1024px the docked assistant panel takes more, so the
// top bar is narrowest between those widths. Sweep them with and without the panel, at the
// default appearance and at larger ones (density "comfortable", font size "large"), every 20 px.
/** Screen widths from `from` to `to` px in 20 px steps, so no list goes stale when a threshold moves. */
const widthsFrom = (from: number, to: number): number[] =>
  Array.from({ length: (to - from) / 20 + 1 }, (_, index) => from + index * 20);
/** Narrowest page title the top bar must keep: about two letters and the ellipsis. */
const MIN_TITLE_WIDTH = 32;

for (const appearance of [
  { density: "default", fontSize: "default" },
  { density: "comfortable", fontSize: "default" },
  { density: "comfortable", fontSize: "large" },
  { density: "compact", fontSize: "small" },
]) {
  test(`the top bar keeps every control inside it at every width, with the assistant panel docked too (density ${appearance.density}, font size ${appearance.fontSize})`, async ({
    page,
  }) => {
    // 77 widths, each with several polled layout checks: more than the 30 s default.
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 900, width: 1440 });
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/watchlist");
    const topbar = page.locator('[data-slot="portal-topbar"]');
    const title = topbar.locator('[data-slot="portal-page-title"]');
    // Worst case: a name longer than the 10rem the menu truncates it to (after hydration, so
    // React does not render the name again).
    await expectHydrated(page.locator("#user-menu-trigger"));
    const swapped = await page.evaluate((settings) => {
      document.documentElement.dataset["density"] = settings.density;
      document.documentElement.dataset["fontSize"] = settings.fontSize;
      const name = [
        ...document.querySelectorAll("#user-menu-trigger span"),
      ].find((span) => span.textContent === "Alice Adams");
      if (name === undefined) return false;
      name.textContent = "Alice Adams-Longname Of Testshire";
      return true;
    }, appearance);
    expect(swapped).toBe(true);
    const checkWidth = async (width: number, docked: boolean) => {
      await page.setViewportSize({ height: 900, width });
      await expect(
        page.getByRole("complementary", { name: "Assistant panel" })
      ).toHaveCount(docked ? 1 : 0);
      const label = `${width}px${docked ? " with the assistant panel" : ""}`;
      // Poll: a JS media query (the sidebar's mobile switch) can re-render after the resize.
      await expect
        .poll(async () => (await title.boundingBox())?.width ?? 0, {
          message: label,
        })
        .toBeGreaterThanOrEqual(MIN_TITLE_WIDTH);
      await expect(
        topbar.getByRole("button", { name: /Alice Adams-Longname/u }),
        label
      ).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() => controlsPastTopbar(page), { message: label })
        .toEqual([]);
      await expect
        .poll(() => findLayoutProblems(page), { message: label })
        .toEqual([]);
    };
    for (const width of [375, ...widthsFrom(380, 1440)])
      await checkWidth(width, false);
    await page.setViewportSize({ height: 900, width: 1440 });
    const toggle = topbar.getByRole("button", {
      name: "Toggle assistant panel",
    });
    // A click before hydration has no handler yet.
    await expectHydrated(toggle);
    await toggle.click();
    for (const width of [1024, ...widthsFrom(1040, 1440)])
      await checkWidth(width, true);
  });
}
