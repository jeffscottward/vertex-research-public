import { expect, expectHydrated, test } from "./fixtures.ts";

const THEME_TRIGGER_NAME = "Appearance settings";
const APPEARANCE_SUBMENU_NAMES = [
  /^Theme/u,
  /^Font size/u,
  /^Density/u,
  /^Roundness/u,
] as const;

const viewportCases = [
  { height: 812, name: "mobile", width: 375 },
  { height: 900, name: "desktop", width: 1440 },
] as const;

test("home page exposes its foundation identity and journey", async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) {
    throw new Error(
      "Playwright baseURL must be configured for the smoke journey."
    );
  }

  await page.goto("/");

  await expect(page).toHaveTitle(
    "Evidence before conviction | Vertex Research"
  );
  await expect(
    page
      .getByRole("banner")
      .getByRole("link", { exact: true, name: "Vertex Research home" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Evidence before conviction.",
    })
  ).toBeVisible();

  const approachLink = page.getByRole("link", {
    name: "Explore our approach",
  });
  await expect(approachLink).toHaveAttribute("href", "#research-principles");
  await approachLink.click();

  const principles = page.getByRole("region", {
    name: "More context. Less assumption.",
  });
  await expect(page).toHaveURL(new URL("/#research-principles", baseURL).href);
  await expect(principles).toBeVisible();
  await expect(principles).toBeFocused();
});

for (const viewport of viewportCases) {
  test(`public shell navigation works at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize({
      height: viewport.height,
      width: viewport.width,
    });
    await page.goto("/");
    await expectHydrated(
      page.getByRole("button", { name: THEME_TRIGGER_NAME })
    );

    await expect(page.getByRole("navigation")).toHaveCount(
      viewport.name === "mobile" ? 1 : 2
    );
    const navigationTrigger = page.getByRole("button", {
      name: "Open navigation",
    });
    if (viewport.name === "mobile") {
      await expect(navigationTrigger).toBeVisible();
      await navigationTrigger.click();
      await expect(
        page.getByRole("navigation", { name: "Mobile navigation" })
      ).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Mobile navigation" })
          .getByRole("link", { name: "Contact" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("navigation", { name: "Mobile navigation" })
      ).toBeHidden();
      // Radix restores focus to the trigger after the close settles; wait for
      // it so that late restoration cannot steal focus from the theme menu.
      await expect(navigationTrigger).toBeFocused();
    } else {
      await expect(navigationTrigger).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: "Primary navigation" })
      ).toBeVisible();
    }

    const themeTrigger = page.getByRole("button", {
      exact: true,
      name: THEME_TRIGGER_NAME,
    });
    await expect(themeTrigger).toBeVisible();
    await expect(themeTrigger).toBeEnabled();
    await themeTrigger.focus();
    await expect(themeTrigger).toBeFocused();
    await themeTrigger.press("ArrowDown");
    const appearanceMenu = page.getByRole("menu");
    await expect(appearanceMenu).toBeVisible();
    const submenuTriggers = appearanceMenu.getByRole("menuitem");
    await expect(submenuTriggers).toHaveCount(APPEARANCE_SUBMENU_NAMES.length);
    for (const [index, name] of APPEARANCE_SUBMENU_NAMES.entries()) {
      await expect(submenuTriggers.nth(index)).toHaveAccessibleName(name);
      await expect(submenuTriggers.nth(index)).toHaveAttribute(
        "aria-haspopup",
        "menu"
      );
    }
    await expect(submenuTriggers.first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(themeTrigger).toBeFocused();

    const documentWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(
      documentWidth.scrollWidth,
      `${viewport.name} document should not overflow horizontally`
    ).toBeLessThanOrEqual(documentWidth.clientWidth + 1);
  });
}
