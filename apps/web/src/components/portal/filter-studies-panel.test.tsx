// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import BacktestsPage from "../../app/(portal)/backtests/page.tsx";
import seeded from "../../features/research-studies/fixtures/adx-filter-study.json";
import { toFilterStudyViewModel } from "../../features/research-studies/view-model.ts";
import { FilterStudiesPanel } from "./filter-studies-panel.tsx";

const FILTER_STUDY_MODEL = toFilterStudyViewModel(seeded);

const render = (markup: string): HTMLElement => {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container;
};

describe("FilterStudiesPanel", () => {
  it("shows both study tables with labeled headers and verdicts", () => {
    const view = render(
      renderToStaticMarkup(<FilterStudiesPanel model={FILTER_STUDY_MODEL} />)
    );
    const section = view.querySelector(
      "section[aria-labelledby='filter-studies-heading']"
    );
    expect(section?.querySelector("h2")?.textContent).toBe("Filter studies");
    const tables = view.querySelectorAll("table");
    expect(tables).toHaveLength(2);
    expect(tables[0]?.querySelectorAll("tbody tr")).toHaveLength(13);
    expect(tables[0]?.querySelector("thead")?.textContent).toContain(
      "Deflated Sharpe"
    );
    expect(tables[1]?.querySelector("thead")?.textContent).not.toContain(
      "Deflated Sharpe"
    );
    expect(tables[1]?.querySelectorAll("tbody tr")).toHaveLength(2);
    const breakout = view.querySelector("[data-row='breakout_20:adx_above']");
    expect(breakout?.querySelector("th[scope='row']")?.textContent).toBe(
      "20-day breakout"
    );
    expect(breakout?.lastElementChild?.className).toContain("text-destructive");
    expect(
      view.querySelector("[data-row='rvol:rvol_above_1']")?.lastElementChild
        ?.className
    ).toContain("text-warning-foreground");
    return expect(
      view.querySelector("[data-row='sma_cross_20_50:none']")?.lastElementChild
        ?.className
    ).toContain("text-muted-foreground");
  });

  it("keeps the focusable region as the only horizontal scroller", () => {
    const view = render(
      renderToStaticMarkup(<FilterStudiesPanel model={FILTER_STUDY_MODEL} />)
    );
    const containers = view.querySelectorAll("[data-slot='table-container']");
    expect(containers).toHaveLength(2);
    for (const container of containers) {
      expect(container.className).toContain("overflow-visible");
      expect(container.className).not.toContain("overflow-x-auto");
      expect(container.parentElement?.getAttribute("tabindex")).toBe("0");
    }
  });

  it("is part of the Backtests page", () => {
    const view = render(renderToStaticMarkup(<BacktestsPage />));
    return expect(
      view.querySelector("#filter-studies-heading")?.textContent
    ).toBe("Filter studies");
  });
});
