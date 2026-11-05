import type { Page } from "@playwright/test";

// Owner evidence screenshots (owner 2026-11-05, card vertex-portfolio-layout-bugs): always dark,
// taken from the top of the page, and visibly marked as mock data when they come from the E2E
// server. A full-page screenshot of a scrolled page draws fixed and sticky elements (sidebar,
// tab bar) at the scroll position, in the middle of the image, so the page scrolls to the top
// first.

const MOCK_EVIDENCE_BANNER = "MOCK DATA - E2E test server, not the live app";

export const useDarkEvidence = (page: Page): Promise<void> =>
  page.emulateMedia({ colorScheme: "dark" });

/** Full-page dark screenshot from the top of the page, with a mock-data banner on top. */
export const captureMockEvidence = async (
  page: Page,
  path: string
): Promise<void> => {
  await useDarkEvidence(page);
  await page.evaluate((text) => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    const banner = document.createElement("div");
    banner.dataset["evidenceBanner"] = "mock";
    banner.textContent = text;
    banner.setAttribute(
      "style",
      "padding:8px 16px;background:#b45309;color:#fff;font:600 14px/1.4 sans-serif;text-align:center"
    );
    document.body.prepend(banner);
  }, MOCK_EVIDENCE_BANNER);
  try {
    await page.screenshot({ animations: "disabled", fullPage: true, path });
  } finally {
    await page.evaluate(() =>
      document.querySelector("[data-evidence-banner]")?.remove()
    );
  }
};

interface LayoutProblem {
  readonly element: string;
  readonly problem: string;
}

/**
 * Visible elements in the main content that reach past the right edge of the screen and are
 * not inside a horizontal scroll area, plus page-level horizontal overflow.
 */
export const findLayoutProblems = (page: Page): Promise<LayoutProblem[]> =>
  page.evaluate(() => {
    const problems: { element: string; problem: string }[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1)
      problems.push({
        element: "html",
        problem: `page scrolls sideways: ${document.documentElement.scrollWidth}px > ${width}px`,
      });
    const describe = (element: Element): string => {
      const label =
        element.getAttribute("aria-label") ??
        element.textContent?.trim().slice(0, 40) ??
        "";
      return `${element.tagName.toLowerCase()}${element.id === "" ? "" : `#${element.id}`} "${label}"`;
    };
    const clippedByScroller = (element: Element): boolean => {
      for (
        let parent = element.parentElement;
        parent !== null && parent !== document.body;
        parent = parent.parentElement
      ) {
        // Only a scroll area counts: content cut off by overflow hidden is a clipping bug.
        const overflow = getComputedStyle(parent).overflowX;
        if (
          (overflow === "auto" || overflow === "scroll") &&
          parent.getBoundingClientRect().right <= width + 1
        )
          return true;
      }
      return false;
    };
    const main = document.querySelector("#main-content") ?? document.body;
    for (const element of main.querySelectorAll("*")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.position === "fixed") continue;
      if (box.right > width + 1 && !clippedByScroller(element))
        problems.push({
          element: describe(element),
          problem: `right edge ${Math.round(box.right)}px > ${width}px`,
        });
    }
    return problems.slice(0, 20);
  });
