import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./headings.tsx";
import { KpiCard, KpiRow } from "./kpi.tsx";
import { TableCell, TableHead, TableScroll } from "./table.tsx";

describe("PageHeader (portal, Fulcrum structure)", () => {
  it("renders breadcrumb, title with status chip, description and actions", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        actions: createElement("button", { type: "button" }, "New"),
        breadcrumb: "Workspace / Todos",
        description: "Open work for today.",
        status: createElement("span", null, "Live"),
        title: "Todos",
      })
    );
    expect(html).toContain('data-slot="page-breadcrumb"');
    expect(html).toContain("Workspace / Todos");
    expect(html).toContain('data-slot="page-status"><span>Live</span>');
    expect(html).toMatch(/<h1[^>]*>Todos<\/h1>/u);
    expect(html).toContain("mt-1 text-sm");
    expect(html).toContain("Open work for today.");
    expect(html).toContain("<button");
  });

  it("keeps the plain title markup when there is no status or breadcrumb", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, { title: "Todos" })
    );
    expect(html).not.toContain("page-breadcrumb");
    expect(html).not.toContain("page-status");
    expect(html).toContain(
      '<div class="min-w-0"><h1 class="tracking-tight font-bold text-2xl">Todos</h1></div>'
    );
  });

  it("keeps the public description styling without the portal size", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        description: "About",
        title: "Home",
        variant: "public",
      })
    );
    expect(html).toContain(
      '<p class="max-w-reading text-muted-foreground">About</p>'
    );
  });
});

describe("KpiRow and KpiCard", () => {
  it("renders a labelled group of cards that stacks on mobile", () => {
    const html = renderToStaticMarkup(
      createElement(
        KpiRow,
        { label: "Summary" },
        createElement(KpiCard, {
          hint: "2 due today",
          icon: createElement("svg", null),
          label: "Open",
          value: "12",
        }),
        createElement(KpiCard, { label: "Done", value: "3" })
      )
    );
    expect(html).toMatch(
      /^<div aria-label="Summary" class="grid grid-cols-1 /u
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('data-slot="kpi-icon"');
    expect(html).toContain("2 due today");
    expect(html.match(/data-slot="kpi-card"/gu)).toHaveLength(2);
    expect(html.match(/data-slot="kpi-icon"/gu)).toHaveLength(1);
  });

  it("omits the label when none is given", () => {
    const html = renderToStaticMarkup(createElement(KpiRow, null));
    expect(html).not.toContain("aria-label");
  });
});

describe("TableScroll and numeric cells", () => {
  it("wraps a table in a focusable, labelled horizontal scroll region", () => {
    const html = renderToStaticMarkup(
      createElement(TableScroll, { label: "Watchlist", minWidth: "36rem" }, "x")
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Watchlist"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("--table-min-width:36rem");
  });

  it("uses a default minimum width", () => {
    const html = renderToStaticMarkup(
      createElement(TableScroll, { label: "T", style: { color: "red" } })
    );
    expect(html).toContain("--table-min-width:40rem");
    expect(html).toContain("color:red");
  });

  it("right-aligns numeric heads and cells", () => {
    const head = renderToStaticMarkup(
      createElement(TableHead, { numeric: true }, "Price")
    );
    const cell = renderToStaticMarkup(
      createElement(TableCell, { numeric: true }, "1.00")
    );
    const plain = renderToStaticMarkup(createElement(TableCell, null, "A"));
    expect(head).toContain("text-right");
    expect(cell).toContain("text-right tabular-nums");
    expect(plain).not.toContain("text-right");
  });
});
