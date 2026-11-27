import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootNotFound from "./not-found.tsx";

describe("app root not-found page", () => {
  const html = renderToStaticMarkup(<RootNotFound />);

  it("shows one title, one sentence and a link to the start page", () => {
    expect(html.match(/<h[1-6]/g)).toEqual(["<h1"]);
    expect(html).toContain(">Page not found</h1>");
    expect(html).toContain("There is no page to show at this address.");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Go to the start page<\/a>/);
  });

  it("uses theme tokens and the full viewport height", () => {
    const main = html.match(/<main[^>]*>/)?.[0] ?? "";
    expect(main).toContain("min-h-dvh");
    expect(main).toContain("bg-background");
    expect(main).toContain("text-foreground");
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("tracking-");
  });
});
