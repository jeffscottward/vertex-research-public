import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ isOperator: true }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Lessons from memory: database courses from their import input (no Postgres, no oRPC dispatch).
vi.mock(
  "../../../../../lib/academy-lessons.ts",
  () => import("../../../../../lib/academy-lessons.test-support.ts")
);
vi.mock("../../../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: async () => ({
    userId: "u",
    role: "member",
    isOperator: sessionMock.isOperator,
    name: "Owner",
    expiresAt: new Date(),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { lessonSummaries } from "@darkfactory/academy/lessons";
import AcademyCoursePage, { metadata } from "./page.tsx";

const page = (course: string, search: Record<string, string> = {}) =>
  AcademyCoursePage({
    params: Promise.resolve({ course }),
    searchParams: Promise.resolve(search),
  });

beforeEach(() => {
  sessionMock.isOperator = true;
  vi.unstubAllEnvs();
});

describe("academy course gallery route", () => {
  it("lists one course's lessons with its URL filters", async () => {
    const html = renderToStaticMarkup(await page("dyr", { type: "concept" }));
    expect(metadata).toEqual({ title: "Academy" });
    expect(html).toContain('data-academy-gallery="dyr"');
    expect(html).toContain("Define Your Risk videos");
    const concepts = lessonSummaries().filter(
      (lesson) => lesson.course === "dyr" && lesson.kind === "concept"
    ).length;
    expect(html).toContain(`Showing ${concepts} of`);
  });

  it("renders a course without lessons and 404s an unknown course", async () => {
    vi.stubEnv(
      "VERTEX_ACADEMY_MEDIA_BASE_URL",
      "https://media.example/academy"
    );
    const html = renderToStaticMarkup(await page("quantfinancetogo"));
    expect(html).toContain('data-academy-gallery="quantfinancetogo"');
    expect(html).toContain("QuantFinanceToGo videos");
    await expect(page("no-such-course")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("refuses non-operators", async () => {
    sessionMock.isOperator = false;
    const html = renderToStaticMarkup(await page("dyr"));
    expect(html).toContain('data-operator-feature="academy"');
    expect(html).not.toContain("data-academy-gallery");
  });
});
