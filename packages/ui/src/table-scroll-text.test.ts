import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TableScrollText } from "./table.tsx";

describe("TableScrollText", () => {
  it("keeps a long name in a 7ch box that scrolls inside the cell, with the full name as tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(TableScrollText, {
        className: "font-semibold",
        text: "IWM 20261113 285 C",
      })
    );
    expect(html).toContain('data-slot="table-scroll-text"');
    expect(html).toContain('title="IWM 20261113 285 C"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(">IWM 20261113 285 C</span>");
    // No touch-action limit: a vertical swipe that starts on the name still scrolls the page.
    expect(html).not.toContain("touch-pan");
    for (const token of [
      "w-[7ch]",
      "overflow-x-auto",
      "whitespace-nowrap",
      "font-semibold",
    ])
      expect(html).toContain(token);
  });
});
