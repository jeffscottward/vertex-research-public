import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PortalNotFound from "./not-found.tsx";

describe("portal not-found state", () => {
  const html = renderToStaticMarkup(<PortalNotFound />);

  it("shows one title, one sentence and a link to Mission control", () => {
    expect(html.match(/<h[1-6]/g)).toEqual(["<h1"]);
    expect(html).toContain(">Page not found</h1>");
    expect(html).toContain("There is no page to show at this address.");
    expect(html).toMatch(
      /<a [^>]*href="\/dashboard"[^>]*>Go to Mission control<\/a>/
    );
  });

  it("adds no second main landmark, skip-link target or page height to the shell", () => {
    expect(html).not.toContain("<main");
    expect(html).not.toContain('id="main-content"');
    expect(html).not.toContain("min-h-dvh");
    expect(html).toMatch(/^<section aria-labelledby="portal-not-found-title"/);
    expect(html).not.toContain("tracking-");
  });
});
