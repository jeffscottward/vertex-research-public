// @vitest-environment jsdom
import type {
  ApiClient,
  MarketNote,
  MarketNotesListOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  createBrowserOwnerMarketNotesGateway,
  OWNER_MARKET_NOTES_REFRESH_MS,
  OwnerMarketNotesCard,
} from "./owner-market-notes-card.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
  vi.useRealTimers();
});

const note = (overrides: Partial<MarketNote> = {}): MarketNote => ({
  affected: {
    sectors: ["Financials"],
    strategies: ["Breadth-90 dip basket"],
    tickers: ["SPY", "XLF"],
  },
  asOf: "2026-11-05",
  claims: [
    {
      checkedAt: "2026-11-06T15:30:00.000Z",
      evidence: "FRED series T10Y2Y closed at -0.12 on 2026-11-05.",
      id: "c1",
      status: "supported",
      text: "The 2s10s curve is inverted again.",
    },
    {
      checkedAt: "2026-11-07T09:00:00.000Z",
      evidence: "VIX closed at 17.4; the reel says above 30.",
      id: "c2",
      status: "contradicted",
      text: "The VIX is above 30.",
    },
    {
      checkedAt: "2026-11-06T15:32:00.000Z",
      evidence: "No public source for dealer desk positioning.",
      id: "c3",
      status: "cannot-check",
      text: "Dealers are short gamma at every desk.",
    },
    {
      checkedAt: null,
      evidence: null,
      id: "c4",
      status: "unverified",
      text: "Credit spreads will widen next week.",
    },
  ],
  id: "note-1",
  ownerMessageUrl: null,
  receivedAt: "2026-11-06T14:00:00.000Z",
  reviewBy: "2026-11-20",
  source: {
    author: "Jane Doe",
    kind: "reel",
    url: "https://example.com/reel/1",
  },
  stance: { confidence: "medium", direction: "risk-off" },
  status: "active",
  theme: "Curve inversion returns",
  updatedAt: "2026-11-07T09:00:00.000Z",
  verification: {
    cannotCheck: 1,
    checked: false,
    contradicted: 1,
    supported: 1,
    unverified: 1,
  },
  ...overrides,
});

const list = (notes: readonly MarketNote[] = []): MarketNotesListOutput => ({
  asOf: "2026-11-11T14:00:00.000Z",
  notes: [...notes],
  today: "2026-11-11",
  truncated: false,
});

const staleNote = (): MarketNote =>
  note({
    affected: { sectors: [], strategies: [], tickers: [] },
    claims: [
      {
        checkedAt: null,
        evidence: null,
        id: "c1",
        status: "unverified",
        text: "Oil inventories fell for a fifth week.",
      },
    ],
    id: "note-2",
    reviewBy: "2026-11-01",
    source: { author: null, kind: "owner-text", url: null },
    stance: { confidence: "low", direction: "neutral" },
    status: "expired",
    theme: "Energy supply squeeze",
    verification: {
      cannotCheck: 0,
      checked: false,
      contradicted: 0,
      supported: 0,
      unverified: 1,
    },
  });

const mount = async (get: () => Promise<MarketNotesListOutput>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<OwnerMarketNotesCard gateway={{ list: get }} />)
  );
  return container;
};

interface Deferred {
  readonly promise: Promise<MarketNotesListOutput>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: MarketNotesListOutput) => void;
}

// The web tsconfig lib predates Promise.withResolvers.
const deferred = (): Deferred => {
  let resolve: (value: MarketNotesListOutput) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<MarketNotesListOutput>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return { promise, reject, resolve };
};

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent ?? null;

/** A StatusBadge prints a screen-reader "Status:" prefix, then the label. */
const badgeLabel = (container: ParentNode, selector: string) =>
  text(container, `${selector} > span:last-child`);

const cardState = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-owner-market-notes]")?.dataset[
    "ownerMarketNotes"
  ];

const themes = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-owner-market-note] h3")].map(
    (heading) => heading.textContent
  );

const refresh = async () =>
  act(async () => {
    vi.advanceTimersByTime(OWNER_MARKET_NOTES_REFRESH_MS);
  });

describe("OwnerMarketNotesCard", () => {
  it("shows loading, then the empty state under the title and the fixed scope line", async () => {
    const pending = deferred();
    const container = await mount(() => pending.promise);
    const section = container.querySelector("section");
    expect(section?.getAttribute("aria-labelledby")).toBe(
      "owner-market-notes-title"
    );
    expect(text(container, "h2#owner-market-notes-title")).toBe(
      "Owner market notes"
    );
    expect(text(container, "[data-slot=panel-header] p")).toBe(
      "Research context only. A claim is a fact only when its status is Supported. Notes never change orders, arming, sizing or risk settings."
    );
    expect(cardState(container)).toBe("loading");
    const loading = container.querySelector('[role="status"]');
    expect(loading?.textContent).toBe("Loading owner market notes…");
    expect(loading?.getAttribute("aria-busy")).toBe("true");

    await act(async () => pending.resolve(list()));
    expect(cardState(container)).toBe("empty");
    expect(text(container, "[data-owner-market-notes-empty]")).toBe(
      "No owner market notes yet."
    );
    expect(container.querySelector("[data-owner-market-note]")).toBeNull();
    expect(
      container.querySelector("[data-owner-market-notes-retired]")
    ).toBeNull();
    expect(text(container, "h2")).toBe("Owner market notes");
    expect(container.textContent).toContain("Research context only.");
  });

  it("shows active notes, then stale ones, and counts retired notes", async () => {
    const container = await mount(async () =>
      list([
        staleNote(),
        note({ id: "note-3", status: "retired", theme: "Retired theme" }),
        note(),
      ])
    );
    expect(cardState(container)).toBe("ready");
    expect(themes(container)).toEqual([
      "Curve inversion returns",
      "Energy supply squeeze",
    ]);
    expect(container.textContent).not.toContain("Retired theme");
    expect(text(container, "[data-owner-market-notes-retired]")).toBe(
      "1 retired note is not shown."
    );
    expect(text(container, "[data-owner-market-notes-today]")).toBe(
      "A note is stale when its review date is before 2026-11-11 (UTC)."
    );
    expect(
      container.querySelector("[data-owner-market-notes-empty]")
    ).toBeNull();

    const active = container.querySelector<HTMLElement>(
      '[data-owner-market-note="note-1"]'
    );
    expect(active?.dataset["noteStatus"]).toBe("active");
    expect(badgeLabel(active as HTMLElement, "[data-note-verification]")).toBe(
      "Partly checked: 1 contradicted"
    );
    expect(
      active
        ?.querySelector("[data-note-verification]")
        ?.getAttribute("data-status")
    ).toBe("destructive");
    expect(active?.querySelector("[data-note-stale]")).toBeNull();
    expect(active?.querySelector("[data-note-stale-notice]")).toBeNull();
    const facts = [...(active?.querySelectorAll("dl > div") ?? [])].map(
      (fact) => [
        fact.querySelector("dt")?.textContent,
        fact.querySelector("dd")?.textContent,
      ]
    );
    expect(facts).toEqual([
      ["As of", "2026-11-05"],
      ["Received", "2026-11-06"],
      ["Review by", "2026-11-20"],
      ["Source", "Reel by Jane Doe (example.com) (opens in a new tab)"],
      ["Stance", "Risk-off, medium confidence"],
      [
        "Claim checks",
        "1 supported, 1 contradicted, 1 cannot check, 1 unverified",
      ],
      ["Tickers", "SPY, XLF"],
      ["Sectors", "Financials"],
      ["Strategies", "Breadth-90 dip basket"],
    ]);
    const link = active?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/reel/1");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.className).toContain("min-h-11");
  });

  it("marks a stale note and says it is left out of agent context", async () => {
    const container = await mount(async () => list([staleNote()]));
    const stale = container.querySelector<HTMLElement>(
      '[data-owner-market-note="note-2"]'
    );
    expect(stale?.dataset["noteStatus"]).toBe("stale");
    expect(badgeLabel(stale as HTMLElement, "[data-note-stale]")).toBe(
      "Stale: review date passed"
    );
    expect(
      stale?.querySelector("[data-note-stale]")?.getAttribute("data-status")
    ).toBe("warning");
    expect(text(stale as HTMLElement, "[data-note-stale-notice]")).toBe(
      "Left out of agent context until the review date is renewed."
    );
    expect(badgeLabel(stale as HTMLElement, "[data-note-verification]")).toBe(
      "Unverified"
    );
    // Owner text has no source URL: the label is plain text. Empty affected groups are left out.
    expect(stale?.querySelector("a")).toBeNull();
    expect(
      [...(stale?.querySelectorAll("dt") ?? [])].map((term) => term.textContent)
    ).toEqual([
      "As of",
      "Received",
      "Review by",
      "Source",
      "Stance",
      "Claim checks",
    ]);
    expect(stale?.textContent).toContain("Owner text");
    expect(stale?.textContent).toContain("Neutral, low confidence");
    // A stale note starts collapsed, so many old notes do not push the page down.
    const button = stale?.querySelector<HTMLButtonElement>(
      "button[aria-expanded]"
    );
    expect(button?.textContent).toBe("Show claims (1)");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(stale?.querySelector("ol")?.hidden).toBe(true);
    await act(async () => button?.click());
    expect(button?.textContent).toBe("Hide claims (1)");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(stale?.querySelector("ol")?.hidden).toBe(false);
    expect(text(stale as HTMLElement, "ol [data-claim-text]")).toBe(
      "Oil inventories fell for a fifth week."
    );
  });

  it("names the state when only retired notes exist", async () => {
    const container = await mount(async () =>
      list([note({ status: "retired" }), note({ status: "retired" })])
    );
    expect(cardState(container)).toBe("empty");
    expect(text(container, "[data-owner-market-notes-empty]")).toBe(
      "No active or stale owner market notes."
    );
    expect(text(container, "[data-owner-market-notes-retired]")).toBe(
      "2 retired notes are not shown."
    );
  });

  it("says under the notes when older expired and retired notes are not listed", async () => {
    const complete = await mount(async () => list([note()]));
    expect(
      complete.querySelector("[data-owner-market-notes-truncated]")
    ).toBeNull();
    const container = await mount(async () => ({
      ...list([note(), note({ id: "note-3", status: "retired" })]),
      truncated: true,
    }));
    // The line comes after the notes and the retired count (document order).
    expect(
      [
        ...container.querySelectorAll(
          "[data-owner-market-note] h3, [data-owner-market-notes-retired], [data-owner-market-notes-truncated]"
        ),
      ].map((element) => element.textContent)
    ).toEqual([
      "Curve inversion returns",
      "1 retired note is not shown.",
      "Older expired and retired notes are not listed.",
    ]);
  });

  it("shows an active note's claims at first, labels all four claim statuses and collapses with a button", async () => {
    const container = await mount(async () => list([note()]));
    const button = container.querySelector<HTMLButtonElement>(
      "button[aria-expanded]"
    );
    const claims = container.querySelector("ol");
    expect(button?.textContent).toBe("Hide claims (4)");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.getAttribute("aria-controls")).toBe(claims?.id);
    expect(button?.type).toBe("button");
    expect(button?.className).toContain("min-h-11");
    expect(claims?.hidden).toBe(false);
    const rows = [...(claims?.querySelectorAll("li") ?? [])].map((row) => ({
      checked: text(row, "[data-claim-checked]"),
      evidence: text(row, "[data-claim-evidence]"),
      label: badgeLabel(row, "[data-slot=badge]"),
      status: row.dataset["claimStatus"],
      text: text(row, "[data-claim-text]"),
      tone: row.querySelector("[data-slot=badge]")?.getAttribute("data-status"),
    }));
    expect(rows).toEqual([
      {
        checked: "Checked 2026-11-06",
        evidence: "Evidence: FRED series T10Y2Y closed at -0.12 on 2026-11-05.",
        label: "Supported",
        status: "supported",
        text: "The 2s10s curve is inverted again.",
        tone: "success",
      },
      {
        checked: "Checked 2026-11-07",
        evidence: "Evidence: VIX closed at 17.4; the reel says above 30.",
        label: "Contradicted",
        status: "contradicted",
        text: "The VIX is above 30.",
        tone: "destructive",
      },
      {
        checked: "Checked 2026-11-06",
        evidence: "Evidence: No public source for dealer desk positioning.",
        label: "Cannot check",
        status: "cannot-check",
        text: "Dealers are short gamma at every desk.",
        tone: "neutral",
      },
      {
        checked: null,
        evidence: null,
        label: "Unverified",
        status: "unverified",
        text: "Credit spreads will widen next week.",
        tone: "warning",
      },
    ]);

    await act(async () => button?.click());
    expect(button?.textContent).toBe("Show claims (4)");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(claims?.hidden).toBe(true);
    await act(async () => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(claims?.hidden).toBe(false);
  });

  it("shows an operator notice on FORBIDDEN", async () => {
    const container = await mount(() => Promise.reject({ code: "FORBIDDEN" }));
    expect(cardState(container)).toBe("forbidden");
    expect(text(container, '[role="status"]')).toBe(
      "Operator access required."
    );
    expect(container.querySelector("button")).toBeNull();
    expect(text(container, "h2")).toBe("Owner market notes");
  });

  it("shows an error with Retry and refreshes on a timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const get = vi
      .fn<() => Promise<MarketNotesListOutput>>()
      .mockRejectedValueOnce(new Error(" Storage down "))
      .mockRejectedValueOnce({ message: " " })
      .mockRejectedValueOnce(null)
      .mockResolvedValue(list([note()]));
    const container = await mount(get);
    expect(cardState(container)).toBe("error");
    expect(text(container, '[role="alert"]')).toBe(
      "Owner market notes unavailable. Storage down"
    );
    expect(text(container, "button")).toBe("Retry");
    await act(async () => container.querySelector("button")?.click());
    expect(text(container, '[role="alert"]')).toBe(
      "Owner market notes unavailable. Request failed."
    );
    await refresh();
    expect(text(container, '[role="alert"]')).toContain("Request failed.");
    await act(async () => container.querySelector("button")?.click());
    expect(cardState(container)).toBe("ready");
    expect(themes(container)).toEqual(["Curve inversion returns"]);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("keeps the last good notes and shows an inline error when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const get = vi
      .fn<() => Promise<MarketNotesListOutput>>()
      .mockResolvedValueOnce(list([note()]))
      .mockRejectedValueOnce(new Error("Storage down"))
      .mockResolvedValueOnce({ ...list(), asOf: "2026-11-11T14:02:30.000Z" })
      .mockRejectedValueOnce(null)
      .mockRejectedValueOnce({ code: "FORBIDDEN" });
    const container = await mount(get);
    expect(
      container.querySelector("[data-owner-market-notes-refresh-error]")
    ).toBeNull();
    await refresh();
    expect(text(container, "[data-owner-market-notes-refresh-error]")).toBe(
      "Refresh failed. Showing notes loaded at 14:00 UTC. Storage down"
    );
    expect(
      container
        .querySelector("[data-owner-market-notes-refresh-error]")
        ?.getAttribute("role")
    ).toBe("alert");
    expect(themes(container)).toEqual(["Curve inversion returns"]);
    expect(container.textContent).not.toContain("notes unavailable");
    await refresh();
    expect(
      container.querySelector("[data-owner-market-notes-refresh-error]")
    ).toBeNull();
    expect(text(container, "[data-owner-market-notes-empty]")).toBe(
      "No owner market notes yet."
    );
    await refresh();
    // The time comes from the last good answer, here the second one.
    expect(text(container, "[data-owner-market-notes-refresh-error]")).toBe(
      "Refresh failed. Showing notes loaded at 14:02 UTC. Request failed."
    );
    expect(text(container, "[data-owner-market-notes-empty]")).toBe(
      "No owner market notes yet."
    );
    // Access removed between refreshes: the notes go away.
    await refresh();
    expect(cardState(container)).toBe("forbidden");
    expect(get).toHaveBeenCalledTimes(5);
  });

  it("drops a slow older answer or failure once a newer refresh answered", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const requests: Deferred[] = [];
    const container = await mount(() => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    });
    await act(async () =>
      requests[0]?.resolve(list([note({ theme: "First answer" })]))
    );
    expect(themes(container)).toEqual(["First answer"]);

    await refresh();
    await refresh();
    expect(requests).toHaveLength(3);
    await act(async () =>
      requests[2]?.resolve(list([note({ theme: "Newest answer" })]))
    );
    expect(themes(container)).toEqual(["Newest answer"]);
    await act(async () =>
      requests[1]?.resolve(list([note({ theme: "Slow older answer" })]))
    );
    expect(themes(container)).toEqual(["Newest answer"]);

    await refresh();
    await refresh();
    expect(requests).toHaveLength(5);
    await act(async () =>
      requests[4]?.resolve(list([note({ theme: "Fifth answer" })]))
    );
    await act(async () => requests[3]?.reject(new Error("Slow older failure")));
    expect(themes(container)).toEqual(["Fifth answer"]);
    expect(
      container.querySelector("[data-owner-market-notes-refresh-error]")
    ).toBeNull();
    expect(cardState(container)).toBe("ready");
  });

  it("keeps each note's open or closed claim list across a refresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const container = await mount(async () => list([note(), staleNote()]));
    const expanded = () =>
      [...container.querySelectorAll("button[aria-expanded]")].map((button) =>
        button.getAttribute("aria-expanded")
      );
    expect(expanded()).toEqual(["true", "false"]);
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      "button[aria-expanded]"
    ))
      await act(async () => button.click());
    expect(expanded()).toEqual(["false", "true"]);
    await refresh();
    expect(expanded()).toEqual(["false", "true"]);
    expect(
      [...container.querySelectorAll("ol")].map((claims) => claims.hidden)
    ).toEqual([true, false]);
  });

  it("ignores an answer that arrives after unmount and stops the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = deferred();
    const get = vi.fn(() => pending.promise);
    const container = await mount(get);
    const root = roots.pop();
    await act(async () => root?.unmount());
    await act(async () => pending.resolve(list([note()])));
    await refresh();
    expect(get).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("creates the browser client once, on first use, and asks for every scope", async () => {
    const listNotes = vi.fn(async () => list());
    runtime.client = {
      marketNotes: { list: listNotes },
    } as unknown as ApiClient;
    const gateway = createBrowserOwnerMarketNotesGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.list();
    await gateway.list();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(listNotes).toHaveBeenCalledTimes(2);
    expect(listNotes).toHaveBeenCalledWith({ scope: "all" });
  });

  it("uses the browser gateway by default", async () => {
    runtime.client = {
      marketNotes: { list: async () => list() },
    } as unknown as ApiClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<OwnerMarketNotesCard />));
    expect(
      container.querySelector("[data-owner-market-notes-empty]")
    ).not.toBeNull();
  });
});
