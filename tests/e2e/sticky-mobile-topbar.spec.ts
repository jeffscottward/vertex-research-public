import {
  E2E_IDENTITIES,
  expect,
  expectHydrated,
  signInAs,
  test,
} from "./fixtures.ts";

// Phone topbar: the header is sticky below 1024px, so the assistant toggle (its only entry point
// since the floating chat button was removed) stays reachable after scrolling far down a page.
// Research only; no orders.

test("the assistant toggle stays reachable after scrolling at 375px", async ({
  page,
}) => {
  await page.setViewportSize({ height: 812, width: 375 });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/todos");

  const topbar = page.locator('[data-slot="portal-topbar"]');
  const toggle = topbar.getByRole("button", {
    name: "Toggle assistant panel",
  });
  await expectHydrated(toggle);

  // Guarantee a long page regardless of seeded content, then scroll well down.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.dataset["e2eSpacer"] = "true";
    spacer.style.height = "4000px";
    document.querySelector("main")?.append(spacer);
  });
  await page.evaluate(() => window.scrollTo(0, 3000));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(2000);

  const box = await topbar.boundingBox();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1).toBeLessThan(1);
  await expect(toggle).toBeInViewport({ ratio: 1 });

  await toggle.click();
  await expect(
    page.getByRole("dialog", { name: "Assistant panel" })
  ).toBeVisible();
});
