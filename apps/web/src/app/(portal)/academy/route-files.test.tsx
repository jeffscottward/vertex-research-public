import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ isOperator: true }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: async () => ({
    userId: "u",
    role: "member",
    isOperator: sessionMock.isOperator,
    name: "Owner",
    expiresAt: new Date(),
  }),
}));

import AcademyError from "./error.tsx";
import AcademyLoading from "./loading.tsx";
import AcademyPage, { metadata } from "./page.tsx";

beforeEach(() => {
  sessionMock.isOperator = true;
});

// React separates adjacent text nodes with <!-- --> in static markup; strip them for text checks.
const render = async (searchParams: Record<string, string> = {}) =>
  renderToStaticMarkup(
    await AcademyPage({ searchParams: Promise.resolve(searchParams) })
  ).replaceAll("<!-- -->", "");

describe("academy route files", () => {
  it("shows the gallery to operators, dark by default, with the first page of cards", async () => {
    const html = await render();
    expect(metadata).toEqual({ title: "Academy" });
    expect(html).toContain('data-theme="default-dark"');
    expect(html.match(/data-lesson-card=/gu)?.length ?? 0).toBe(12);
    expect(html).toContain("Page 1 of");
  });

  it("renders the filters and page from the URL query", async () => {
    const html = await render({ type: "strategy", page: "2", q: "" });
    expect(html).toMatch(/<option value="strategy" selected="">/u);
    expect(html).toContain("Page 2 of");
    expect(html).not.toContain('data-lesson-card="vega-exposure-basics"');
  });

  it("refuses non-operators (private transcripts)", async () => {
    sessionMock.isOperator = false;
    const html = await render();
    expect(html).toContain('data-operator-feature="academy"');
    expect(html).not.toContain("data-academy-gallery");
  });

  it("renders loading and error states", () => {
    expect(renderToStaticMarkup(<AcademyLoading />)).toContain(
      "Loading the Academy"
    );
    expect(
      renderToStaticMarkup(<AcademyError reset={() => undefined} />)
    ).toContain("Academy unavailable");
  });
});
