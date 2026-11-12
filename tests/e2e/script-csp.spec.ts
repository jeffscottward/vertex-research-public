import type { Page } from "@playwright/test";

import {
  E2E_IDENTITIES,
  expect,
  expectHydrated,
  signInAs,
  test,
} from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// sec-20 item 7: page responses carry a per-request script nonce. These checks
// run with the CSP enforced: the app's own scripts must all run (React
// hydrates, client controls respond) and a script without the nonce must not.
test.beforeAll(() => resetDatabase());

const NONCE_CSP = /; script-src 'self' 'nonce-[A-Za-z0-9+/=]+'$/u;

const recordViolations = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { __cspViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(
        `${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`
      );
    });
  });
};

// Zod probes `Function("")` once to pick its JIT parser; under this CSP the
// probe is refused and Zod uses its plain parser. That refusal is expected.
const ZOD_JIT_PROBE = /^script-src eval /u;

// Three call sites read the list that recordViolations installed.
const violations = async (page: Page): Promise<string[]> => {
  const recorded: unknown = await page.evaluate(() =>
    Reflect.get(window, "__cspViolations")
  );
  if (!Array.isArray(recorded)) throw new Error("CSP recorder missing");
  return recorded
    .map(String)
    .filter((violation) => !ZOD_JIT_PROBE.test(violation));
};

test("app scripts run under the nonce CSP", async ({ page }) => {
  await recordViolations(page);
  const response = await page.goto("/sign-in");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(NONCE_CSP);

  const password = page.getByLabel("Password", { exact: true });
  await expectHydrated(password);
  await page.getByLabel("Email address", { exact: true }).fill("bad");
  // Client-side validation runs: the hydrated form flags the bad address.
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("a foreign inline script without the nonce does not run", async ({
  context,
}) => {
  // A second page: the browser-error guard watches only the fixture page, and
  // Chromium logs this expected refusal as a console error.
  const page = await context.newPage();
  await recordViolations(page);
  await page.goto("/sign-in");
  const injected = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__foreignScriptRan = true";
    document.head.append(script);
    return "__foreignScriptRan" in window;
  });
  expect(injected).toBe(false);
  expect(await violations(page)).toEqual([
    expect.stringMatching(/^script-src-elem inline /u),
  ]);
  await page.close();
});

test("a signed-in portal page hydrates under the nonce CSP", async ({
  page,
}) => {
  await recordViolations(page);
  await signInAs(page, E2E_IDENTITIES.alice);
  const response = await page.reload();
  expect(response?.headers()["content-security-policy"] ?? "").toMatch(
    NONCE_CSP
  );
  await expectHydrated(
    page.getByRole("heading", { level: 1, name: "Mission control" })
  );
  expect(await violations(page)).toEqual([]);
});
