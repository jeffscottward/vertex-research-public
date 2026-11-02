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

describe("academy route files", () => {
  it("shows the gallery to operators, dark by default, with one card per lesson", async () => {
    const html = renderToStaticMarkup(await AcademyPage());
    expect(metadata).toEqual({ title: "Academy" });
    expect(html).toContain('data-theme="default-dark"');
    expect(
      html.match(/data-lesson-card=/gu)?.length ?? 0
    ).toBeGreaterThanOrEqual(5);
  });

  it("refuses non-operators (private transcripts)", async () => {
    sessionMock.isOperator = false;
    const html = renderToStaticMarkup(await AcademyPage());
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
