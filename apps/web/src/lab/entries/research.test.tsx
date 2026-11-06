// @vitest-environment jsdom
import {
  BasketSchema,
  BasketValuationSchema,
  MarketNewsWatchlistOutputSchema,
  PickListProposalSchema,
  PickListSchema,
  PickListScreenSchema,
  PriceAlertListOutputSchema,
  ResearchPaperSchema,
  ResearchReportDatasetOutputSchema,
  ResearchReportsListOutputSchema,
  WatchlistItemSchema,
} from "@darkfactory/api";
import {
  VertexResearchChatListThreadsOutputSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  VertexResearchChatRosterOutputSchema,
} from "@darkfactory/api/vertex";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The vendor chat surface needs a Copilot runtime; the lab test keeps everything around it real.
vi.mock("@copilotkit/react-core/v2", () => ({ CopilotChatView: () => null }));

import {
  LAB_BASKETS,
  LAB_PAPERS,
  LAB_PICK_LIST_PROPOSAL,
  LAB_PICK_LISTS,
  LAB_PRICE_ALERTS,
  LAB_RESEARCH_REPORTS,
  LAB_RESEARCH_ROSTER,
  LAB_RESEARCH_THREAD_ID,
  LAB_RESEARCH_THREAD_PAGE,
  LAB_WATCHLIST,
  labBasketValuation,
  labMarketNews,
  labPickListScreen,
  labResearchDataset,
  labResearchTranscript,
} from "../fixtures/research.ts";
import { mountLab, unmountLab } from "../test-support.tsx";
import { RESEARCH_LAB_ENTRIES } from "./research.tsx";

afterEach(async () => {
  await unmountLab();
});

const entry = (id: string) => {
  const found = RESEARCH_LAB_ENTRIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Missing lab entry ${id}`);
  return found;
};

const render = async (id: string, query = ""): Promise<HTMLElement> => {
  const host = await mountLab(entry(id).render(new URLSearchParams(query)));
  await vi.waitFor(() => expect(host.querySelector("h1")).not.toBeNull());
  return host;
};

describe("research lab fixtures", () => {
  it("match the API output schemas", () => {
    expect(() => {
      VertexResearchChatRosterOutputSchema.parse(LAB_RESEARCH_ROSTER);
      VertexResearchChatListThreadsOutputSchema.parse(LAB_RESEARCH_THREAD_PAGE);
      VertexResearchChatReadTranscriptPageOutputSchema.parse(
        labResearchTranscript(LAB_RESEARCH_THREAD_ID)
      );
      ResearchReportsListOutputSchema.parse(LAB_RESEARCH_REPORTS);
      ResearchReportDatasetOutputSchema.parse(
        labResearchDataset("NVDA", "news")
      );
      for (const item of LAB_WATCHLIST) WatchlistItemSchema.parse(item);
      PriceAlertListOutputSchema.parse(LAB_PRICE_ALERTS);
      MarketNewsWatchlistOutputSchema.parse(labMarketNews(24));
      for (const basket of LAB_BASKETS) {
        BasketSchema.parse(basket);
        BasketValuationSchema.parse(labBasketValuation(basket.id));
      }
      for (const paper of LAB_PAPERS) ResearchPaperSchema.parse(paper);
      for (const list of LAB_PICK_LISTS) {
        PickListSchema.parse(list);
        PickListScreenSchema.parse(labPickListScreen(list.id));
      }
      PickListProposalSchema.parse(LAB_PICK_LIST_PROPOSAL);
    }).not.toThrow();
  });

  it("values an unknown basket id as the first basket", () => {
    expect(labBasketValuation("missing").basket.symbol).toBe("DEMOAI");
  });
});

describe("research lab entries", () => {
  it("opens the research chat on the fake thread", async () => {
    const host = await render("research");
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        "Demo: SPY breadth vs. QQQ concentration"
      )
    );
    expect(host.querySelector("h1")?.textContent).toBe("Research");
    expect(host.textContent).toContain("demo-capital-research");
  });

  it("lists the fake dossiers", async () => {
    const host = await render("research-reports");
    expect(host.querySelector("h1")?.textContent).toBe("Research dossiers");
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Demo GPU maker dossier")
    );
  });

  it("opens the dossier from ?id= and defaults to SPY", async () => {
    const nvda = await render("research-report", "id=nvda");
    expect(nvda.querySelector("h1")?.textContent).toBe("NVDA dossier");
    await vi.waitFor(() =>
      expect(nvda.textContent).toContain("Fictional fundamentals summary")
    );
    await unmountLab();
    const spy = await render("research-report");
    expect(spy.querySelector("h1")?.textContent).toBe("SPY dossier");
  });

  it("shows the fake watchlist and basket rows", async () => {
    const host = await render("watchlist");
    expect(host.querySelector("h1")?.textContent).toBe("Watchlist");
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Demo: hedge sleeve");
      expect(host.textContent).toContain("Demo AI leaders");
    });
  });

  it("shows the fake price alerts", async () => {
    const host = await render("price-alerts");
    expect(host.querySelector("h1")?.textContent).toBe("Price alerts");
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Demo: protective stop")
    );
  });

  it("shows the fake news", async () => {
    const host = await render("news");
    expect(host.querySelector("h1")?.textContent).toBe("News monitor");
    await vi.waitFor(() =>
      expect(host.textContent).toContain("beats fictional estimates")
    );
  });

  it("opens the basket from ?symbol=", async () => {
    const host = await render("baskets", "symbol=demomtl");
    expect(host.querySelector("h1")?.textContent).toBe("Baskets");
    await vi.waitFor(() => expect(host.textContent).toContain("SLV"));
  });

  it("shows the fake pick lists", async () => {
    const host = await render("pick-lists");
    expect(host.querySelector("h1")?.textContent).toBe("Pick lists");
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Demo pick list")
    );
    const screen = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Run screen")
    );
    await act(async () => screen?.click());
    await vi.waitFor(() =>
      expect(host.textContent).toContain("close 80.00 < EMA20 85.00")
    );
  });

  it("shows the fake papers", async () => {
    const host = await render("papers");
    expect(host.querySelector("h1")?.textContent).toBe("Papers");
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Demo: Time-series momentum")
    );
  });
});
