import type { Page } from "@playwright/test";

import {
  E2E_IDENTITIES,
  expect,
  expectHydrated,
  signInAs,
  test,
} from "./fixtures.ts";

// Assistant side panel: available on an ordinary portal page, sends the page as context, streams a
// reply with Stop in view, and keeps the streaming reply when the operator moves to another page.
// The E2E server has no model key, so the thread list is passed through with the model marked
// configured and the send stream is replaced in the browser by a fictional reply that streams until
// the request is aborted. Threads are real. Research only; no orders.

const VIEWPORTS = [
  { height: 844, width: 390 },
  { height: 900, width: 1440 },
] as const;

const markModelConfigured = async (page: Page): Promise<void> => {
  await page.route("**/api/orpc/assistant/threads/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json: { status: { configured: boolean } };
    };
    body.json.status.configured = true;
    await route.fulfill({ json: body, response });
  });
};

// Replaces only assistant.send: records the request body, then streams text every 40 ms until the
// request signal aborts (Stop).
const streamLongReply = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const encoder = new TextEncoder();
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request === null ? String(input) : request.url,
        window.location.href
      );
      if (url.pathname !== "/api/orpc/assistant/send")
        return original(input, init);
      const sent =
        typeof init?.body === "string"
          ? init.body
          : request === null
            ? ""
            : await request.clone().text();
      document.documentElement.dataset["e2eAssistantSend"] = sent;
      const signal = init?.signal ?? request?.signal ?? null;
      let timer = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let piece = 0;
          timer = window.setInterval(() => {
            piece += 1;
            const event = {
              delta: `Line ${piece}: a fictional streamed research note.\n\n`,
              modelCall: 1,
              type: "text",
            };
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`
              )
            );
          }, 40);
          signal?.addEventListener("abort", () => {
            window.clearInterval(timer);
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
        cancel() {
          window.clearInterval(timer);
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
};

for (const viewport of VIEWPORTS) {
  test(`the side panel streams a reply with page context and keeps it across pages (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await markModelConfigured(page);
    await streamLongReply(page);
    await page.goto("/todos");

    // Closed until the operator opens it from the topbar toggle (every width). Docked from 1024px;
    // a modal bottom sheet below 1024px.
    const docked = viewport.width >= 1024;
    const panel = page.getByRole(docked ? "complementary" : "dialog", {
      name: "Assistant panel",
    });
    await expect(panel).toHaveCount(0);
    const toggle = page
      .locator('[data-slot="portal-topbar"]')
      .getByRole("button", { name: "Toggle assistant panel" });
    // A click before hydration has no handler yet.
    await expectHydrated(toggle);
    await toggle.click();
    await expect(panel).toBeVisible();
    const composer = panel.getByRole("textbox", { name: "Ask the assistant" });
    await expect(composer).toBeEnabled();
    await composer.fill("Summarize the open todos.");
    await panel.getByRole("button", { name: "Send" }).click();

    const stop = panel.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await expect(stop).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset["e2eAssistantSend"] ?? ""
        )
      )
      .toContain('"path":"/todos"');
    await expect(panel.getByText("Line 3:")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`assistant-panel-${viewport.width}.png`),
    });

    // Client-side navigation keeps the panel and its streaming reply.
    if (docked) {
      await page
        .getByRole("navigation", { name: "Portal navigation" })
        .getByRole("link", { name: "Mission control" })
        .click();
      await page.waitForURL("**/dashboard");
      await expect(stop).toBeVisible();
      await expect(stop).toBeInViewport({ ratio: 1 });
    }

    await stop.click();
    await expect(stop).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
    // A thread-list read still in flight must not fail after the test ends.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
}

// No launcher floats over page content: at 375 px the Mission control "Reload" button sat under the
// old floating chat button. Both controls must be separate and hit-testable at their centers.
for (const viewport of [
  { height: 812, width: 375 },
  { height: 900, width: 1440 },
] as const) {
  test(`the assistant toggle covers no page control on Mission control (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: "dark" });
    await signInAs(page, E2E_IDENTITIES.alice);
    await page.goto("/dashboard");
    const reload = page.getByRole("button", { name: "Reload mission control" });
    const toggle = page
      .locator('[data-slot="portal-topbar"]')
      .getByRole("button", { name: "Toggle assistant panel" });
    await expect(reload).toBeVisible();
    await expectHydrated(toggle);
    await reload.scrollIntoViewIfNeeded();
    const hits = await page.evaluate(() => {
      const fixed = [...document.querySelectorAll<HTMLElement>("button")]
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.position === "fixed" && style.display !== "none";
        })
        .map((node) => node.getAttribute("aria-label") ?? node.textContent);
      const hit = (selector: string) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) return null;
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        return {
          box: {
            bottom: box.bottom,
            left: box.left,
            right: box.right,
            top: box.top,
          },
          ok: top !== null && node.contains(top),
        };
      };
      return {
        fixed,
        reload: hit('[aria-label="Reload mission control"]'),
        toggle: hit(
          '[data-slot="portal-topbar"] [aria-label="Toggle assistant panel"]'
        ),
      };
    });
    expect(hits.fixed).toEqual([]);
    expect(hits.reload?.ok).toBe(true);
    expect(hits.toggle?.ok).toBe(true);
    const a = hits.reload?.box;
    const b = hits.toggle?.box;
    const intersects =
      a !== undefined &&
      b !== undefined &&
      a.left < b.right &&
      b.left < a.right &&
      a.top < b.bottom &&
      b.top < a.bottom;
    expect(intersects).toBe(false);
    await page.screenshot({
      path: test.info().outputPath(`mission-control-${viewport.width}.png`),
    });
  });
}
