import type { Locator } from "@playwright/test";

import academyMedia from "../../packages/academy/src/lessons/media-manifest.json" with {
  type: "json",
};
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// State changes must not shift layout: a control keeps its size and font
// weight when its label or pressed state changes (motion review follow-ups).

test.use({ colorScheme: "dark" });

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("control is not visible");
  return rect;
};

// Academy media files are not committed, so every lazy-loaded thumbnail
// answers 404 in E2E (same allowance as account-admin-theme.spec.ts).
const ACADEMY_THUMBNAILS: ReadonlySet<string> = new Set(
  Object.values(academyMedia).map((entry) => entry.thumbnail)
);

test("the Academy theme toggle keeps its width when it changes label", async ({
  browserErrors,
  page,
}) => {
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && ACADEMY_THUMBNAILS.has(pathname))
      browserErrors.allowHttpError({ method: "GET", pathname, status: 404 });
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/academy");
  const toggle = page.getByRole("button", {
    name: /Switch the Academy to (light|dark) mode/u,
  });
  const before = await box(toggle);
  const label = await toggle.getAttribute("aria-label");
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-label", label ?? "");
  const after = await box(toggle);
  expect(after.width).toBe(before.width);
  await toggle.click();
  expect((await box(toggle)).width).toBe(before.width);
});

test("pressed library view buttons keep their font weight and width", async ({
  page,
}) => {
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/library");
  const group = page.getByRole("group", { name: "View" });
  const rows = group.getByRole("button", { name: "Rows" });
  const cards = group.getByRole("button", { name: "Cards" });
  const weight = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).fontWeight);
  await expect(rows).toHaveAttribute("aria-pressed", "true");
  const pressedWeight = await weight(rows);
  const releasedWeight = await weight(cards);
  const cardsWidth = (await box(cards)).width;
  expect(pressedWeight).toBe(releasedWeight);
  await cards.click();
  await expect(cards).toHaveAttribute("aria-pressed", "true");
  expect(await weight(cards)).toBe(releasedWeight);
  expect((await box(cards)).width).toBe(cardsWidth);
});
