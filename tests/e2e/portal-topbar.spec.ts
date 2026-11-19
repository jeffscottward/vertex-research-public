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
// top bar is narrowest between those widths. Sweep them with and without the panel.
test("the top bar keeps every control inside it at every width, with the assistant panel docked too", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/watchlist");
  const topbar = page.locator('[data-slot="portal-topbar"]');
  const breadcrumb = topbar.getByRole("navigation", { name: "Breadcrumb" });
  // Worst case: a name longer than the 10rem the menu truncates it to (after hydration, so
  // React does not render the name again).
  await expectHydrated(page.locator("#user-menu-trigger"));
  await page.evaluate(() => {
    const name = [...document.querySelectorAll("#user-menu-trigger span")].find(
      (span) => span.textContent === "Alice Adams"
    );
    if (name !== undefined)
      name.textContent = "Alice Adams-Longname Of Testshire";
  });
  const checkWidth = async (width: number, docked: boolean) => {
    await page.setViewportSize({ height: 900, width });
    await expect(
      page.getByRole("complementary", { name: "Assistant panel" })
    ).toHaveCount(docked ? 1 : 0);
    const label = `${width}px${docked ? " with the assistant panel" : ""}`;
    await expect(breadcrumb, label).toBeVisible();
    await expect(
      topbar.getByRole("button", { name: /Alice Adams/u }),
      label
    ).toBeInViewport({ ratio: 1 });
    expect(await controlsPastTopbar(page), label).toEqual([]);
    expect(await findLayoutProblems(page), label).toEqual([]);
  };
  for (const width of [640, 700, 768, 820, 900, 960, 1024, 1100, 1280, 1440])
    await checkWidth(width, false);
  const toggle = topbar.getByRole("button", {
    name: "Toggle assistant panel",
  });
  // A click before hydration has no handler yet.
  await expectHydrated(toggle);
  await toggle.click();
  for (const width of [1024, 1100, 1180, 1280, 1366, 1440])
    await checkWidth(width, true);
});
