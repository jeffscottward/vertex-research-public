import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { ADMIN_PORTAL_ROUTE_PATHS } from "../../apps/web/src/lib/navigation.ts";
import { createNodeDatabase } from "@darkfactory/db/server";
import { createVertexAuthorization } from "@darkfactory/db/server/vertex";
import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, signInAs } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Owner rule (2026-10-30): no portal page may need a typed ID or scope to show
// its content. Record pages list what exists; inputs stay only where a human
// really sets something (parameters, config, tickers, orders, settings).
// This guard opens every portal route as the seeded operator at desktop and
// phone width and fails when a text field asks for an ID, alias or scope.
// Set E2E_INPUT_AUDIT_DIR to also save screenshots and a JSON inventory of
// every form control (docs/vertex-rebuild/ui-input-audit-20261030.md).

type Control = Readonly<{
  tag: string;
  type: string;
  name: string;
  label: string;
  placeholder: string;
  visible: boolean;
}>;

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "375", width: 375, height: 812 },
] as const;

/** Words that mark a field as a record lookup or scope form. */
const LOOKUP_FIELD =
  /\b(?:ids?|identifiers?|uuids?|alias(?:es)?|scopes?|run\s*id|task\s*id|record\s*id|gateway\s*id)\b/iu;

/** Text types a person can type an ID into. */
const TEXT_TYPES: readonly string[] = ["", "text", "search", "url", "textarea"];

/**
 * Fields that match LOOKUP_FIELD but are real human input. Key: route, then
 * the field's label (or name when it has no label). Keep this list short and
 * give each entry its reason.
 */
const KEEP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Adds a new paper to the library from its arXiv ID or URL: a human input,
  // not a lookup. The papers themselves are listed below the field.
  "/papers": ["arXiv ID or URL"],
});

const controlsOn = (page: Page): Promise<Control[]> =>
  page.evaluate(() => {
    const textOf = (element: Element | null): string =>
      (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
    const labelFor = (element: HTMLElement): string => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria.trim();
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        return labelledBy
          .split(/\s+/u)
          .map((id) => textOf(document.getElementById(id)))
          .join(" ")
          .trim();
      }
      const labels = (element as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        return Array.from(labels)
          .map((label) => textOf(label))
          .join(" ")
          .trim();
      }
      return "";
    };
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        "main input, main textarea, main select"
      )
    )
      .filter((element) => {
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        return !["hidden", "submit", "button", "reset", "image"].includes(type);
      })
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          tag,
          type:
            tag === "textarea"
              ? "textarea"
              : tag === "select"
                ? "select"
                : (element.getAttribute("type") ?? "").toLowerCase(),
          name: element.getAttribute("name") ?? "",
          label: labelFor(element),
          placeholder: element.getAttribute("placeholder") ?? "",
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none",
        };
      });
  });

const settle = async (page: Page): Promise<void> => {
  // Not every page has an h1 (/portfolio uses tabs), so wait for main.
  await expect(page.locator("main").first()).toBeVisible({
    timeout: 30_000,
  });
  // Pages poll, so networkidle may never come; give reads a bounded moment.
  await page
    .waitForLoadState("networkidle", { timeout: 8000 })
    .catch(() => undefined);
};

// Fictional account scopes granted to the operator, so scoped pages render
// their default (first) scope instead of the empty state.
const SEEDED_SCOPES = [
  { accountAlias: "e2e-research-scope", environment: "research" },
  { accountAlias: "e2e-paper-scope", environment: "paper" },
] as const;

const seedScopeGrants = async (): Promise<void> => {
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    const actorId = E2E_IDENTITIES.admin.id;
    const authorization = createVertexAuthorization(resource.db, {
      clock: { now: () => new Date().toISOString() },
      // Test-only issuer: this spec seeds its own fictional grants.
      privilegedAuthorization: { authorize: () => Promise.resolve(true) },
    });
    // resetDatabase keeps vertex grants, so a retry or a new worker finds
    // them already issued: issue only the missing ones.
    const existing = await authorization.listAuthorizedScopes({ actorId });
    for (const scope of SEEDED_SCOPES) {
      if (
        existing.some(
          (granted) =>
            granted.accountAlias === scope.accountAlias &&
            granted.environment === scope.environment
        )
      )
        continue;
      await authorization.issueGrant({
        principal: { actorId },
        grantId: `e2e-grant-${scope.accountAlias}`,
        granteeActorId: actorId,
        scope,
        collectionId: null,
        resourceId: "account-scope",
        actions: ["read"],
        version: "1.0.0",
        expectedVersion: null,
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    }
  } finally {
    await resource.close();
  }
};

test.beforeAll(async () => {
  await resetDatabase();
  await seedScopeGrants();
});

for (const viewport of VIEWPORTS) {
  test(`no portal page asks for an ID or scope at ${viewport.name} px`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const auditDir = process.env["E2E_INPUT_AUDIT_DIR"];
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await signInAs(page, E2E_IDENTITIES.admin);
    const inventory: Record<string, Control[]> = {};
    const offenders: string[] = [];
    for (const route of ADMIN_PORTAL_ROUTE_PATHS) {
      await page.goto(route);
      await settle(page);
      // A page that crashed into the error boundary would pass trivially.
      await expect(page.locator("#research-page-error-title")).toHaveCount(0);
      const controls = await controlsOn(page);
      inventory[route] = controls;
      for (const control of controls) {
        // Split camelCase names (collectionId) and separators before matching.
        const described =
          `${control.label} ${control.name} ${control.placeholder}`.replace(
            /([a-z])([A-Z])/gu,
            "$1 $2"
          );
        const lookup =
          TEXT_TYPES.includes(control.type) &&
          LOOKUP_FIELD.test(described.replace(/[-_]/gu, " "));
        const allowed = (KEEP[route] ?? []).includes(
          control.label || control.name
        );
        if (lookup && !allowed) {
          offenders.push(
            `${route}: ${control.tag}[type=${control.type}] label="${control.label}" name="${control.name}" placeholder="${control.placeholder}"`
          );
        }
      }
      if (auditDir) {
        const slug = route.replace(/^\//u, "").replace(/\//gu, "__") || "root";
        await mkdir(join(auditDir, viewport.name), { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: join(auditDir, viewport.name, `${slug}.png`),
        });
      }
    }
    if (auditDir) {
      await writeFile(
        join(auditDir, `inputs-${viewport.name}.json`),
        `${JSON.stringify(inventory, null, 2)}\n`
      );
    }
    expect(offenders, "ID/scope lookup fields outside KEEP").toEqual([]);
  });
}
