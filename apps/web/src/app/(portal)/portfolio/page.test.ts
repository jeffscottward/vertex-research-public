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

  it("gives owner operators the ibkr-monitor and owner order tabs from the cached request session", async () => {
    mocks.getRequestPortalSession.mockResolvedValueOnce({
      isOperator: true,
      isOwner: true,
    });
    const page = await PortfolioPage({
      searchParams: Promise.resolve({ tab: "pnl" }),
    });
    expect(metadata).toEqual({ title: "Portfolio" });
    expect(page.type).toBe("portfolio-tabs");
    expect(page.props.operator).toBe(true);
    expect(page.props.owner).toBe(true);
    expect(page.props.initialTab).toBe("pnl");
    expect(
      isValidElement(page.props.projection) &&
        page.props.projection.type === "portfolio-workspace"
    ).toBe(true);
    return expect(mocks.getRequestPortalSession).toHaveBeenCalledWith(
      "better-auth.session_token=opaque",
      "203.0.113.42"
    );
  });

  it("gives non-admin operators the read-only monitor without owner order access", async () => {
    mocks.getRequestPortalSession.mockResolvedValueOnce({
      isOperator: true,
      isOwner: false,
    });
    const page = await PortfolioPage({
      searchParams: Promise.resolve({ tab: "positions" }),
    });
    expect(page.props.operator).toBe(true);
    return expect(page.props.owner).toBe(false);
  });

  return it.each([[{ isOperator: false, isOwner: false }], [null]])(
    "gives a non-operator (or no session) the projection only: %o",
    async (session) => {
      mocks.getRequestPortalSession.mockResolvedValueOnce(session);
      const page = await PortfolioPage({
        searchParams: Promise.resolve({ tab: ["pnl", "orders"] }),
      });
      expect(page.props.initialTab).toBeUndefined();
      expect(page.props.operator).toBe(false);
      return expect(page.props.owner).toBe(false);
    }
  );
});
