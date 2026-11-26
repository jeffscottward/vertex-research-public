import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestPortalSession: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: mocks.getRequestPortalSession,
}));

vi.mock("../../../components/portal/basket-watchlist-section.tsx", () => ({
  BasketWatchlistSection: () => null,
}));

vi.mock("../../../components/portal/watchlist-workspace.tsx", () => ({
  WatchlistWorkspace: () => null,
}));

vi.mock("../../../components/portal/trade-journal-source.ts", () => ({
  resolveJournalSource: () => "demo",
}));

import { BasketWatchlistSection } from "../../../components/portal/basket-watchlist-section.tsx";
import { WatchlistWorkspace } from "../../../components/portal/watchlist-workspace.tsx";
import WatchlistPage, { metadata } from "./page.tsx";

const childrenOf = (node: ReactNode): ReactElement[] => {
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) return [];
  const raw = node.props.children;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((child): child is ReactElement => isValidElement(child));
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("WatchlistPage", () => {
  it("omits operator-only BasketWatchlistSection for non-operators and includes it for operators", async () => {
    expect(metadata.title).toBe("Watchlist");
    mocks.headers.mockResolvedValue(new Headers({ cookie: "s=1" }));

    mocks.getRequestPortalSession.mockResolvedValueOnce({
      isOperator: false,
    });
    const memberChildren = childrenOf(await WatchlistPage());
    expect(
      memberChildren.some((el) => el.type === BasketWatchlistSection)
    ).toBe(false);
    const memberWorkspace = memberChildren.find(
      (el) => el.type === WatchlistWorkspace
    );
    expect(memberWorkspace?.props).toMatchObject({ operator: false });

    mocks.getRequestPortalSession.mockResolvedValueOnce({
      isOperator: true,
    });
    const operatorChildren = childrenOf(await WatchlistPage());
    expect(
      operatorChildren.some((el) => el.type === BasketWatchlistSection)
    ).toBe(true);
    const operatorWorkspace = operatorChildren.find(
      (el) => el.type === WatchlistWorkspace
    );
    expect(operatorWorkspace?.props).toMatchObject({ operator: true });
  });
});
