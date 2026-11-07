import { EventEmitter, once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { APIResponse, Page, TestInfo } from "@playwright/test";

import {
  E2E_IDENTITIES,
  type E2EIdentity,
  expect,
  signInAs,
  test,
} from "./fixtures.ts";
import { clientReferenceChunkUrlPattern } from "./helpers/build-chunks.ts";
import { resetDatabase } from "./helpers/database.ts";

// Each file starts from the seeded identities, whatever ran before it.
test.beforeAll(() => resetDatabase());

const ALICE_SEED_ITEM = "Alice example item";
const BOB_SEED_ITEM = "Bob example item";
const ADMIN_SEED_ITEM = "Admin example item";
const BOB_SEED_ITEM_ID = "30000000-0000-4000-8000-000000000003";
const MOBILE_VIEWPORT = { height: 812, width: 375 } as const;
const FEATURE_ITEM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MISSION_CONTROL_CURRENT_PAGE_NAME_PATTERN =
  /^Mission control\s*, current page$/u;

interface CreatedItemEvidence {
  id: string;
  name: string;
  updatedName: string;
}

interface OrpcEnvelope {
  json?: unknown;
}

type FeatureItemStatus = "active" | "archived" | "draft";

interface OwnerFeatureItem {
  id: string;
  name: string;
  ownerId: string;
  status: FeatureItemStatus;
}

interface PolicyResult {
  code: string;
  message: string;
  status: number;
}

interface DirectPolicyEvidence {
  adminCanListAlice?: Readonly<{
    matchCount: number;
    status: 200;
  }>;
  aliceCannotGetBob?: PolicyResult;
  aliceCannotUseAdminOwnerList?: PolicyResult;
  anonymousFeatureItems?: PolicyResult;
}

let createdItem: CreatedItemEvidence | null = null;
const directPolicyEvidence: DirectPolicyEvidence = {};

const requireBaseURL = (baseURL: string | undefined): string => {
  if (baseURL === undefined) {
    throw new Error("Playwright baseURL is required for portal evidence.");
  }
  return baseURL;
};

const requireCreatedItem = (): CreatedItemEvidence => {
  if (createdItem === null) {
    throw new Error("The serial Alice lifecycle must create an item first.");
  }
  return createdItem;
};

const postOrpc = (
  page: Page,
  baseURL: string,
  procedure: string,
  input: Record<string, unknown>
): Promise<APIResponse> => {
  const origin = new URL(baseURL).origin;
  return page
    .context()
    .request.post(new URL(`/api/orpc/${procedure}`, origin).href, {
      data: { json: input },
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
      },
    });
};

const responseEnvelope = async (response: APIResponse): Promise<OrpcEnvelope> =>
  (await response.json()) as OrpcEnvelope;

const expectOrpcError = async (
  response: APIResponse,
  expected: PolicyResult
): Promise<PolicyResult> => {
  expect(response.status()).toBe(expected.status);
  const envelope = await responseEnvelope(response);
  expect(envelope.json).toEqual({
    code: expected.code,
    defined: true,
    message: expected.message,
    status: expected.status,
  });
  return expected;
};

const listOwnerItems = async (
  page: Page,
  baseURL: string
): Promise<OwnerFeatureItem[]> => {
  const response = await postOrpc(page, baseURL, "featureItems/list", {
    limit: 50,
  });
  expect(response.status()).toBe(200);
  const { json } = await responseEnvelope(response);
  if (!Array.isArray(json)) {
    throw new TypeError("Owner feature item list must return an array.");
  }
  return json as OwnerFeatureItem[];
};

type FeatureItemCounts = Readonly<{
  active: number;
  archived: number;
  draft: number;
  total: number;
}>;

const countsFromItems = (
  items: readonly OwnerFeatureItem[]
): FeatureItemCounts => ({
  active: items.filter((item) => item.status === "active").length,
  archived: items.filter((item) => item.status === "archived").length,
  draft: items.filter((item) => item.status === "draft").length,
  total: items.length,
});

interface DashboardSummaryEvidence {
  featureItems: FeatureItemCounts &
    Readonly<{
      recent: readonly Readonly<{ name: string; ownerId: string }>[];
    }>;
  session: Readonly<{ name: string; role: string; userId: string }>;
}

// Mission control replaced the upstream item overview on /dashboard, so the
// owner-scoped counts and recent items are read from the same summary the
// page loads (dashboard.summary) instead of from rendered text.
const expectDashboardSummary = async (
  page: Page,
  baseURL: string,
  expected: Readonly<{
    counts: FeatureItemCounts;
    hidden: readonly string[];
    identity: E2EIdentity;
    recent: readonly string[];
  }>
): Promise<void> => {
  await expect(page).toHaveURL((url) => url.pathname === "/dashboard");
  await expect(
    page.getByRole("heading", { level: 1, name: "Mission control" })
  ).toBeVisible();
  const response = await postOrpc(page, baseURL, "dashboard/summary", {});
  expect(response.status()).toBe(200);
  const summary = (await responseEnvelope(response))
    .json as DashboardSummaryEvidence;
  expect(summary.session).toMatchObject({
    name: expected.identity.name,
    role: expected.identity.role,
    userId: expected.identity.id,
  });
  expect(summary.featureItems).toMatchObject(expected.counts);
  const recent = summary.featureItems.recent;
  expect(recent.every((item) => item.ownerId === expected.identity.id)).toBe(
    true
  );
  const recentNames = recent.map((item) => item.name);
  for (const name of expected.recent) {
    expect(recentNames).toContain(name);
  }
  for (const name of expected.hidden) {
    expect(recentNames).not.toContain(name);
  }
};

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1
  );
};

const safeProjectName = (name: string): string =>
  name.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-").toLowerCase();

const writePolicyEvidence = async (testInfo: TestInfo): Promise<void> => {
  const path = testInfo.outputPath("portal-direct-policy.json");
  const evidence = {
    assertions: {
      adminCanListAlice: directPolicyEvidence.adminCanListAlice?.status === 200,
      adminCrossOwnerMatchCount:
        directPolicyEvidence.adminCanListAlice?.matchCount ?? 0,
      aliceCannotGetBob: directPolicyEvidence.aliceCannotGetBob?.status === 404,
      aliceCannotUseAdminOwnerList:
        directPolicyEvidence.aliceCannotUseAdminOwnerList?.status === 403,
      anonymousFeatureItemsDenied:
        directPolicyEvidence.anonymousFeatureItems?.status === 401,
    },
    viewport: MOBILE_VIEWPORT,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
};

test.describe
  .serial("DF-113/114 portal owner and admin journeys", () => {
    test("anonymous portal access redirects and raw oRPC returns 401", async ({
      baseURL,
      page,
    }) => {
      const appURL = requireBaseURL(baseURL);

      await page.goto("/dashboard");
      await expect(page).toHaveURL(
        new URL("/sign-in?callbackURL=%2Fdashboard", appURL).href
      );

      directPolicyEvidence.anonymousFeatureItems = await expectOrpcError(
        await postOrpc(page, appURL, "featureItems/list", { limit: 50 }),
        {
          code: "UNAUTHORIZED",
          message: "Authentication required",
          status: 401,
        }
      );
    });

    test("Alice uses the mobile portal shell and the owner-scoped item API", async ({
      baseURL,
      browserErrors,
      page,
    }, testInfo) => {
      const appURL = requireBaseURL(baseURL);
      const runKey = [
        safeProjectName(testInfo.project.name),
        testInfo.parallelIndex,
        testInfo.repeatEachIndex,
        testInfo.retry,
      ].join("-");
      const name = `DF-113 portal lifecycle ${runKey}`;
      const updatedName = `${name} reviewed`;
      const description =
        "Created through the real mobile portal and persisted by oRPC.";
      const updatedDescription =
        "Edited through the owner-scoped detail UI before archival.";

      await page.setViewportSize(MOBILE_VIEWPORT);
      await signInAs(page, E2E_IDENTITIES.alice);
      const portalModuleGate = new EventEmitter();
      const portalModuleRequested = once(portalModuleGate, "route-ready", {
        signal: AbortSignal.timeout(15_000),
      });
      await page.route(
        // vinext names client chunks by hash only; the build's reference map
        // names the chunk that holds the portal shell.
        clientReferenceChunkUrlPattern("src/components/portal-shell.tsx"),
        async (route) => {
          portalModuleGate.emit("route-ready");
          await once(portalModuleGate, "release");
          await route.continue();
        },
        { times: 1 }
      );
      const coldDashboardNavigation = page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
      });
      const navigationTrigger = page.getByRole("button", {
        exact: true,
        name: "Open portal navigation",
      });
      const navigationTriggerElement = page.locator(
        'button[aria-label="Open portal navigation"]'
      );
      const mobileNavigation = page.getByRole("navigation", {
        name: "Mobile portal navigation",
      });
      const overviewLink = mobileNavigation.locator('a[href="/dashboard"]');
      // Each sidebar group is a disclosure; its summary comes before its links.
      const overviewGroupToggle = mobileNavigation
        .locator('details[data-slot="portal-group"] > summary')
        .first();
      const userMenuTrigger = page.locator("#user-menu-trigger");
      const userMenu = page.locator("#user-menu-content");
      const settingsMenuItem = userMenu.getByRole("menuitem", {
        exact: true,
        name: "Settings",
      });
      const featureItemsLink = mobileNavigation.locator(
        'a[href="/feature-items"]'
      );
      const decisionInboxLink = mobileNavigation.locator('a[href="/today"]');
      const closeNavigation = page.getByRole("button", {
        name: "Close portal navigation",
      });

      try {
        await Promise.all([coldDashboardNavigation, portalModuleRequested]);
        await expect(page).toHaveURL(new URL("/dashboard", appURL).href);
        expect(await userMenuTrigger.getAttribute("data-hydration-state")).toBe(
          "pending"
        );
        const initialAliceItems = await listOwnerItems(page, appURL);
        expect(initialAliceItems).toContainEqual(
          expect.objectContaining({
            name: ALICE_SEED_ITEM,
            ownerId: E2E_IDENTITIES.alice.id,
            status: "draft",
          })
        );
        expect(
          initialAliceItems.every(
            (item) => item.ownerId === E2E_IDENTITIES.alice.id
          )
        ).toBe(true);
        await expectDashboardSummary(page, appURL, {
          counts: countsFromItems(initialAliceItems),
          hidden: [BOB_SEED_ITEM],
          identity: E2E_IDENTITIES.alice,
          recent: [ALICE_SEED_ITEM],
        });
        await expectNoHorizontalOverflow(page);
        // Audit P2-1: at phone width the user menu shows only the avatar, so the
        // page title keeps its full text instead of collapsing to "M…".
        const pageTitle = page.locator('[data-slot="portal-page-title"]');
        await expect(pageTitle).toHaveText("Mission control");
        expect(
          await pageTitle.evaluate(
            (element) => element.scrollWidth <= element.clientWidth
          )
        ).toBe(true);

        await expect(navigationTriggerElement).toHaveCount(1);
        await expect(navigationTrigger).toBeVisible();
        await expect(navigationTrigger).toBeEnabled();
        await expect(navigationTrigger).toHaveAttribute(
          "popovertarget",
          "portal-navigation"
        );
        await navigationTrigger.focus();
        await navigationTrigger.press("Enter");
        await expect(mobileNavigation).toBeVisible();
        await expect(overviewLink).toHaveAccessibleName(
          MISSION_CONTROL_CURRENT_PAGE_NAME_PATTERN
        );
        await expect(overviewLink).toHaveAttribute("aria-current", "page");
        await expect(closeNavigation).toBeFocused();
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press("Tab");
        await expect(overviewGroupToggle).toBeFocused();
        await expect(overviewGroupToggle).toHaveText("Overview");
        await page.keyboard.press("Tab");
        await expect(overviewLink).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(overviewGroupToggle).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(closeNavigation).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(mobileNavigation).toBeHidden();
        await expect(navigationTrigger).toBeVisible();
        await expect(navigationTrigger).toBeFocused();

        await navigationTrigger.press("Enter");
        await expect(closeNavigation).toBeFocused();
      } finally {
        portalModuleGate.emit("release");
      }

      await expect(userMenuTrigger).toHaveAttribute(
        "data-hydration-state",
        "ready",
        { timeout: 15_000 }
      );
      await expect(userMenuTrigger).toHaveAccessibleName(
        E2E_IDENTITIES.alice.name
      );
      await expect(mobileNavigation).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(overviewGroupToggle).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(overviewLink).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(mobileNavigation).toBeHidden();
      await expect(navigationTrigger).toBeFocused();

      // The user menu holds only Settings and Sign out; arrow between them from the keyboard.
      await userMenuTrigger.focus();
      await userMenuTrigger.press("Enter");
      await expect(userMenu).toBeVisible();
      await expect(userMenu.getByRole("menuitem")).toHaveText([
        "Settings",
        "Sign out",
      ]);
      await expect(settingsMenuItem).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settingsMenuItem).not.toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(settingsMenuItem).toBeFocused();
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(userMenu).toBeHidden();
      await expect(userMenuTrigger).toBeFocused();

      // The "Data & Ops" group closes the list, and the starter
      // template's /feature-items pages are gone (audit P2-3).
      await navigationTrigger.focus();
      await navigationTrigger.press("Enter");
      await expect(mobileNavigation).toBeVisible();
      await expect(mobileNavigation).toContainText("Data & Ops");
      await expect(mobileNavigation).not.toContainText("Features");
      await expect(featureItemsLink).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(overviewGroupToggle).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(overviewLink).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(decisionInboxLink).toBeFocused();
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(mobileNavigation).toBeHidden();
      for (const removedPath of ["/feature-items", "/feature-items/new"]) {
        browserErrors.allowHttpError({
          method: "GET",
          pathname: removedPath,
          status: 404,
        });
        for (const message of [
          "Failed to load resource: the server responded with a status of 404 ()",
          "Failed to load resource: the server responded with a status of 404 (Not Found)",
        ]) {
          browserErrors.allowConsoleError({ message, pathname: removedPath });
        }
        const removed = await page.goto(removedPath);
        expect(removed?.status()).toBe(404);
      }

      // The owner-scoped feature-item API (the template's reference brick)
      // stays: create, activate, rename, archive and read back, all as Alice.
      directPolicyEvidence.aliceCannotGetBob = await expectOrpcError(
        await postOrpc(page, appURL, "featureItems/get", {
          id: BOB_SEED_ITEM_ID,
        }),
        {
          code: "NOT_FOUND",
          message: "Feature item not found",
          status: 404,
        }
      );
      directPolicyEvidence.aliceCannotUseAdminOwnerList = await expectOrpcError(
        await postOrpc(page, appURL, "admin/featureItems/list", {
          limit: 50,
          ownerId: E2E_IDENTITIES.bob.id,
        }),
        {
          code: "FORBIDDEN",
          message: "Forbidden",
          status: 403,
        }
      );

      const createResponse = await postOrpc(
        page,
        appURL,
        "featureItems/create",
        { description, metadata: {}, name }
      );
      expect(createResponse.status()).toBe(200);
      const created = (await responseEnvelope(createResponse))
        .json as OwnerFeatureItem;
      expect(created).toMatchObject({
        name,
        ownerId: E2E_IDENTITIES.alice.id,
        status: "draft",
      });
      expect(created.id).toMatch(FEATURE_ITEM_ID_PATTERN);
      createdItem = { id: created.id, name, updatedName };

      const activated = await postOrpc(
        page,
        appURL,
        "featureItems/changeStatus",
        { id: created.id, status: "active" }
      );
      expect(activated.status()).toBe(200);
      const updated = await postOrpc(page, appURL, "featureItems/update", {
        description: updatedDescription,
        id: created.id,
        name: updatedName,
      });
      expect(updated.status()).toBe(200);
      const archived = await postOrpc(page, appURL, "featureItems/archive", {
        id: created.id,
      });
      expect(archived.status()).toBe(200);

      const archivedResponse = await postOrpc(
        page,
        appURL,
        "featureItems/get",
        { id: created.id }
      );
      expect(archivedResponse.status()).toBe(200);
      expect((await responseEnvelope(archivedResponse)).json).toMatchObject({
        description: updatedDescription,
        id: created.id,
        name: updatedName,
        ownerId: E2E_IDENTITIES.alice.id,
        status: "archived",
      });

      await page.goto("/dashboard");
      const finalAliceItems = await listOwnerItems(page, appURL);
      expect(finalAliceItems).toContainEqual(
        expect.objectContaining({
          id: created.id,
          name: updatedName,
          ownerId: E2E_IDENTITIES.alice.id,
          status: "archived",
        })
      );
      await expectDashboardSummary(page, appURL, {
        counts: countsFromItems(finalAliceItems),
        hidden: [BOB_SEED_ITEM],
        identity: E2E_IDENTITIES.alice,
        recent: [updatedName],
      });
    });

    test("Bob sees only his archived seed through the owner-scoped API", async ({
      baseURL,
      page,
    }) => {
      const appURL = requireBaseURL(baseURL);
      const aliceItem = requireCreatedItem();
      await signInAs(page, E2E_IDENTITIES.bob);
      const bobItems = await listOwnerItems(page, appURL);
      expect(bobItems).toEqual([
        expect.objectContaining({
          name: BOB_SEED_ITEM,
          ownerId: E2E_IDENTITIES.bob.id,
          status: "archived",
        }),
      ]);
      await expectDashboardSummary(page, appURL, {
        counts: countsFromItems(bobItems),
        hidden: [aliceItem.updatedName],
        identity: E2E_IDENTITIES.bob,
        recent: [BOB_SEED_ITEM],
      });
    });

    test("admin keeps an owner-only dashboard and can use the cross-owner procedure", async ({
      baseURL,
      page,
    }, testInfo) => {
      const appURL = requireBaseURL(baseURL);
      const aliceItem = requireCreatedItem();
      await signInAs(page, E2E_IDENTITIES.admin);
      const adminItems = await listOwnerItems(page, appURL);
      expect(adminItems).toEqual([
        expect.objectContaining({
          name: ADMIN_SEED_ITEM,
          ownerId: E2E_IDENTITIES.admin.id,
          status: "active",
        }),
      ]);
      // The summary is owner-only even for an administrator.
      await expectDashboardSummary(page, appURL, {
        counts: countsFromItems(adminItems),
        hidden: [ALICE_SEED_ITEM, aliceItem.updatedName],
        identity: E2E_IDENTITIES.admin,
        recent: [ADMIN_SEED_ITEM],
      });

      const crossOwnerResponse = await postOrpc(
        page,
        appURL,
        "admin/featureItems/list",
        {
          limit: 50,
          ownerId: E2E_IDENTITIES.alice.id,
          query: aliceItem.updatedName,
          status: "archived",
        }
      );
      expect(crossOwnerResponse.status()).toBe(200);
      const envelope = await responseEnvelope(crossOwnerResponse);
      expect(Array.isArray(envelope.json)).toBe(true);
      const items = envelope.json as OwnerFeatureItem[];
      expect(items).toContainEqual(
        expect.objectContaining({
          id: aliceItem.id,
          name: aliceItem.updatedName,
          ownerId: E2E_IDENTITIES.alice.id,
          status: "archived",
        })
      );
      directPolicyEvidence.adminCanListAlice = {
        matchCount: items.filter(
          (item) =>
            item.id === aliceItem.id && item.ownerId === E2E_IDENTITIES.alice.id
        ).length,
        status: 200,
      };

      await writePolicyEvidence(testInfo);
    });
  });
