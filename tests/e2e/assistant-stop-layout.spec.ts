import type { Page } from "@playwright/test";

import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";

// Assistant chat layout and Stop: while a long reply streams, only the message list scrolls, the
// composer and Stop stay inside the viewport, and Stop ends the stream. The E2E server has no model
// key, so the real thread list response is passed through with the model marked configured, and the
// send stream is replaced in the browser by a fictional reply that keeps streaming until the request
// is aborted. Threads are real. Research only; no orders.

const VIEWPORTS = [
  { height: 812, width: 375 },
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

// Replaces only the assistant.send request: an oRPC event stream of text pieces every 40 ms that
// never finishes on its own and errors when the request signal aborts (Stop).
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
      // Counts sends, so the test can prove that the Stop click does not resend the draft.
      const root = document.documentElement;
      const sends = Number(root.getAttribute("data-assistant-sends") ?? "0");
      root.setAttribute("data-assistant-sends", String(sends + 1));
      const signal = init?.signal ?? request?.signal ?? null;
      let timer = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let piece = 0;
          timer = window.setInterval(() => {
            piece += 1;
            const event = {
              delta: `Line ${piece}: a fictional streamed research note that makes the reply long.\n\n`,
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
  test(`Stop stays in view during a long streamed reply and ends it (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, E2E_IDENTITIES.alice);
    await markModelConfigured(page);
    await streamLongReply(page);
    await page.goto("/assistant");

    const conversation = page.getByRole("region", {
      name: "Assistant conversation",
    });
    const messages = conversation.getByRole("region", { name: "Messages" });
    const transcript = conversation.getByRole("list", { name: "Transcript" });
    const composer = conversation.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await composer.fill("Write a long fictional research note.");
    await conversation.getByRole("button", { name: "Send" }).click();

    const stop = conversation.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await expect(transcript).toHaveAttribute("aria-busy", "true");
    // The reply grows past the height of the message list, which scrolls on its own.
    await expect
      .poll(
        () =>
          messages.evaluate(
            (element) => element.scrollHeight - element.clientHeight
          ),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(400);
    await expect(stop).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeInViewport({ ratio: 1 });
    // Following the end: new text keeps the list scrolled to (near) its end.
    await expect
      .poll(() =>
        messages.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThan(120);
    await page.screenshot({
      path: test.info().outputPath(`assistant-streaming-${viewport.width}.png`),
    });

    await stop.click();
    await expect(stop).toHaveCount(0);
    await expect(
      conversation.getByRole("button", { name: "Send" })
    ).toBeVisible();
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(
      conversation.getByText(
        "Stopped. The server ends this turn and keeps the reply written so far"
      )
    ).toBeVisible();
    await expect(
      conversation.locator('[data-message-role="streaming"]')
    ).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-assistant-sends",
      "1"
    );
    // Stop also refreshes the thread list; let that routed request end with the test.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
}
