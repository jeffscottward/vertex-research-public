import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Panel } from "./panel.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

describe("Panel", () => {
  it("renders a section with a heading bar, padded body and no empty slots", () => {
    const html = renderToStaticMarkup(
      createElement(Panel, { title: "Engines" }, "Body text")
    );
    expect(html).toMatch(/^<section[^>]*data-slot="panel"/u);
    expect(html).toContain("overflow-clip");
    expect(html).not.toContain("overflow-hidden");
    expect(html).toContain(
      '<h2 class="font-semibold text-base leading-snug">Engines</h2>'
    );
    expect(html).toContain('data-slot="panel-content"');
    expect(html).toMatch(/class="p-4" data-slot="panel-content">Body text/u);
    expect(html).not.toContain("text-muted-foreground");
    expect(html).not.toContain('data-slot="panel-actions"');
  });

  it("renders the description, wrapping actions, heading level and flush table inset", () => {
    const html = renderToStaticMarkup(
      createElement(
        Panel,
        {
          actions: createElement("button", { type: "button" }, "Reload"),
          className: "extra",
          contentClassName: "body-extra",
          description: "Pushed every minute",
          flush: true,
          headingId: "engines-title",
          headingLevel: 3,
          id: "engines",
          title: "Timers",
        },
        createElement(
          Table,
          null,
          createElement(
            TableHeader,
            null,
            createElement(
              TableRow,
              null,
              createElement(TableHead, null, "Engine")
            )
          ),
          createElement(
            TableBody,
            null,
            createElement(TableRow, null, createElement(TableCell, null, "a"))
          )
        )
      )
    );
    expect(html).toContain('id="engines"');
    expect(html).toContain("extra");
    expect(html).toContain('aria-labelledby="engines-title"');
    expect(html).toContain(
      '<h3 class="font-semibold text-base leading-snug" id="engines-title">'
    );
    expect(html).toContain(
      '<p class="text-muted-foreground text-sm">Pushed every minute</p>'
    );
    expect(html).toContain('data-slot="panel-actions"');
    expect(html).toMatch(
      /<div class="flex min-w-0 max-w-full flex-wrap items-center gap-2" data-slot="panel-actions">/u
    );
    expect(html).toContain('<button type="button">Reload</button>');
    expect(html).not.toContain("shrink-0");
    expect(html).toContain("[&amp;_[data-slot=table]_td:first-child]:pl-4");
    expect(html).toContain("body-extra");
    expect(html).not.toContain('class="p-4');
    // Header labels are small and muted, printed as written; numbers line up.
    expect(html).toContain("[&amp;_th]:text-xs");
    expect(html).toContain("[&amp;_th]:text-muted-foreground");
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-wide");
    expect(html).toContain("tabular-nums");
  });
});
