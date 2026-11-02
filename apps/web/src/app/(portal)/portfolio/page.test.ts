import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestPortalSession: vi.fn(),
  headers: vi.fn(
    async () =>
      new Headers({
        "cf-connecting-ip": "203.0.113.42",
        cookie: "better-auth.session_token=opaque",
      })
  ),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: mocks.getRequestPortalSession,
}));
vi.mock("../../../components/portal/portfolio-tabs.tsx", () => ({
  PortfolioTabs: "portfolio-tabs",
}));
vi.mock("../../../features/experience/portfolio.tsx", () => ({
  PortfolioWorkspace: "portfolio-workspace",
}));

import PortfolioPage, { metadata } from "./page.tsx";

describe("PortfolioPage", () => {
  beforeEach(() => mocks.getRequestPortalSession.mockReset());

  it("gives operators the ibkr-monitor tabs from the cached request session", async () => {
    mocks.getRequestPortalSession.mockResolvedValueOnce({ isOperator: true });
    const page = await PortfolioPage();
    expect(metadata).toEqual({ title: "Portfolio" });
    expect(page.type).toBe("portfolio-tabs");
    expect(page.props.operator).toBe(true);
    expect(
      isValidElement(page.props.projection) &&
        page.props.projection.type === "portfolio-workspace"
    ).toBe(true);
    return expect(mocks.getRequestPortalSession).toHaveBeenCalledWith(
      "better-auth.session_token=opaque",
      "203.0.113.42"
    );
  });

  return it.each([[{ isOperator: false }], [null]])(
    "gives a non-operator (or no session) the projection only: %o",
    async (session) => {
      mocks.getRequestPortalSession.mockResolvedValueOnce(session);
      const page = await PortfolioPage();
      return expect(page.props.operator).toBe(false);
    }
  );
});
