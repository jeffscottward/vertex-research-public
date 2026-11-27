import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./headings.tsx";
import { KpiCard, KpiRow } from "./kpi.tsx";
import { StatusBadge } from "./status-badge.tsx";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "./table.tsx";

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
      '<div class="min-w-0"><h1 class="font-bold text-2xl">Todos</h1></div>'
    );
  });

  it("prints a status badge in the status slot as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        status: createElement(StatusBadge, { status: "info" }, "Loading"),
        title: "Todos",
      })
    );
    expect(html).toContain(
      '<span class="inline-flex" data-slot="page-status"><span class="'
    );
    expect(html).toMatch(
      /data-slot="page-status"><span class="[^"]*" data-slot="badge" data-status="info">/u
    );
    for (const shape of ["rounded-none", "border-0", "bg-transparent", "p-0"]) {
      expect(html).toContain(`in-data-[slot=page-status]:${shape}`);
    }
    expect(html).toContain("in-data-[slot=page-status]:before:hidden");
    expect(html).toContain("in-data-[slot=page-status]:text-muted-foreground");
    expect(html).toContain('<span class="sr-only">Status:</span>');
    expect(html).toContain("<span>Loading</span>");
  });

  it("has no negative letter-spacing in the title of either variant", () => {
    const portal = renderToStaticMarkup(
      createElement(PageHeader, { title: "Todos" })
    );
    const publicPage = renderToStaticMarkup(
      createElement(PageHeader, { title: "Home", variant: "public" })
    );
    expect(portal).toContain('<h1 class="font-bold text-2xl">Todos</h1>');
    expect(publicPage).toContain(
      '<h1 class="font-extrabold text-4xl">Home</h1>'
    );
    expect(portal).not.toContain("tracking-");
    expect(publicPage).not.toContain("tracking-");
  });

  it("renders no eyebrow above the public title", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        description: "About",
        title: "Home",
        variant: "public",
      })
    );
    expect(html).toContain(
      '<div class="min-w-0 space-y-3"><h1 class="font-extrabold text-4xl">Home</h1><p class="max-w-reading text-muted-foreground">About</p></div>'
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

describe("StatusBadge", () => {
  const badge = (
    status: "neutral" | "success" | "warning" | "info" | "destructive",
    plain?: boolean
  ) =>
    renderToStaticMarkup(
      createElement(
        StatusBadge,
        plain === undefined ? { status } : { plain, status },
        "Ready"
      )
    );

  it("keeps the default pill look when plain is false or not set", () => {
    for (const html of [badge("success"), badge("success", false)]) {
      expect(html).not.toContain("data-plain");
      expect(html).toContain('data-slot="badge"');
      expect(html).toContain('data-status="success"');
      expect(html).toMatch(/class="[^"]*\brounded-full border px-2 py-0\.5 /u);
      expect(html).toContain("before:size-1.5");
      expect(html).toContain(
        "border-success-border bg-success-subtle text-success-foreground"
      );
      expect(html).toContain(
        '<span class="sr-only">Status:</span><span>Ready</span>'
      );
    }
  });

  it("prints a plain status with no border, fill, dot, rounded box or padding", () => {
    const html = badge("success", true);
    expect(html).toBe(
      '<span class="relative inline-flex w-fit shrink-0 items-center whitespace-nowrap font-medium text-xs text-muted-foreground" data-plain="true" data-slot="badge" data-status="success"><span class="sr-only">Status:</span><span>Ready</span></span>'
    );
    for (const shape of ["border", "bg-", "rounded", "before:", "px-", "py-"]) {
      expect(html).not.toContain(shape);
    }
  });

  it("keeps the warning and destructive text colour in the plain look", () => {
    expect(badge("warning", true)).toContain("text-warning-foreground");
    expect(badge("warning", true)).not.toContain("text-muted-foreground");
    expect(badge("destructive", true)).toContain("text-destructive");
    expect(badge("destructive", true)).not.toContain("text-muted-foreground");
    for (const status of ["neutral", "info", "success"] as const) {
      expect(badge(status, true)).toContain("text-muted-foreground");
      expect(badge(status, true)).toContain(`data-status="${status}"`);
    }
  });

  it("keeps the warning and destructive text colour in the page status slot", () => {
    for (const status of ["neutral", "info", "success"] as const) {
      expect(badge(status)).toContain(
        "in-data-[slot=page-status]:text-muted-foreground"
      );
    }
    for (const status of ["warning", "destructive"] as const) {
      const html = badge(status);
      expect(html).toContain("in-data-[slot=page-status]:border-0");
      expect(html).toContain("in-data-[slot=page-status]:bg-transparent");
      expect(html).not.toContain(
        "in-data-[slot=page-status]:text-muted-foreground"
      );
    }
    expect(badge("warning")).toContain("text-warning-foreground");
    expect(badge("destructive")).toContain("text-destructive");
  });

  it("merges a caller class and passes other attributes through", () => {
    const html = renderToStaticMarkup(
      createElement(
        StatusBadge,
        { className: "ml-2", id: "row-status", plain: true, status: "info" },
        "Draft"
      )
    );
    expect(html).toContain('id="row-status"');
    expect(html).toMatch(/class="[^"]*text-muted-foreground ml-2"/u);
  });
});

describe("TableHeader", () => {
  it("prints header cells as written, without an upper-case transform", () => {
    const html = renderToStaticMarkup(
      createElement(
        Table,
        null,
        createElement(
          TableHeader,
          { className: "extra" },
          createElement(
            TableRow,
            null,
            createElement(TableHead, null, "Net premium")
          )
        )
      )
    );
    expect(html).toContain(
      '<thead class="bg-muted/50 [&amp;_th]:h-9 [&amp;_th]:font-medium [&amp;_th]:text-muted-foreground [&amp;_th]:text-xs [&amp;_tr]:border-b [&amp;_tr]:hover:bg-transparent extra" data-slot="table-header">'
    );
    expect(html).toContain(">Net premium</th>");
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-wide");
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
