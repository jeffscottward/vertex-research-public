import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isOperator: false,
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: async () => ({
    expiresAt: new Date(),
    isOperator: mocks.isOperator,
    name: "Owner",
    role: "member",
    userId: "u",
  }),
}));
vi.mock("../../../../features/stock-detail/stock-detail-workspace.tsx", () => ({
  StockDetailWorkspace: ({
    operator,
    symbol,
  }: {
    operator: boolean;
    symbol: string;
  }) => <div data-operator={String(operator)} data-workspace={symbol} />,
}));

import StockPage, { generateMetadata } from "./page.tsx";

const params = (symbol: string) => Promise.resolve({ symbol });

describe("stock page", () => {
  it("renders the breadcrumb, header and workspace for a ticker", async () => {
    const html = renderToStaticMarkup(
      await StockPage({ params: params("nvda") })
    );
    expect(html).toContain("<h1");
    expect(html).toMatch(/<h1[^>]*>NVDA<\/h1>/u);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toMatch(
      /<a[^>]*href="\/charts\?symbol=NVDA"[^>]*>Open in Charts<\/a>/u
    );
    expect(html).toContain('data-operator="false" data-workspace="NVDA"');
    expect(await generateMetadata({ params: params("brk.b") })).toEqual({
      title: "BRK.B · Stock",
    });
    expect(await generateMetadata({ params: params("<x>") })).toEqual({
      title: "Stock",
    });
  });

  it("tells the workspace about an operator session", async () => {
    mocks.isOperator = true;
    const html = renderToStaticMarkup(
      await StockPage({ params: params("spy") })
    );
    mocks.isOperator = false;
    expect(html).toContain('data-operator="true" data-workspace="SPY"');
  });

  it("answers 404 for a value that is not a ticker", async () => {
    await expect(StockPage({ params: params("%3Cscript%3E") })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(mocks.notFound).toHaveBeenCalled();
  });
});
