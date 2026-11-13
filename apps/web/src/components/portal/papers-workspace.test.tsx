// @vitest-environment jsdom
import type { ResearchPaperOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PapersGateway } from "./agent-ops-client.tsx";
import { PAPERS_PAGE_SIZE, PapersWorkspace } from "./papers-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/papers");
});

const settle = async () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await settle();
  return container;
};
const button = (container: HTMLElement, text: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text
  );
  if (found === undefined) throw new Error(`Missing button ${text}`);
  return found;
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const setValue = async (element: Element | null, value: string) => {
  const target = element as HTMLInputElement | HTMLSelectElement;
  const proto =
    target instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};

const at = new Date("2026-10-23T00:00:00Z");
const paper = (
  id: string,
  overrides: Partial<ResearchPaperOutput> = {}
): ResearchPaperOutput => ({
  authors: null,
  blockers: null,
  createdAt: at,
  id,
  identifier: null,
  kind: "paper",
  notes: null,
  reportedMetrics: {},
  reproducedMetrics: {},
  sourceUrl: null,
  stage: "queued",
  title: `Paper ${id}`,
  updatedAt: at,
  verdict: "pending",
  year: null,
  ...overrides,
});
const gatewayWith = (papers: ResearchPaperOutput[]): PapersGateway => ({
  add: vi.fn(async (input) => paper("new", { title: input.title })),
  addFromArxiv: vi.fn(),
  list: vi.fn(async () => papers),
  update: vi.fn(),
});
const status = (container: HTMLElement) =>
  container
    .querySelector('[data-testid="papers-status"]')
    ?.textContent?.replace("Status:", "");
const rowIds = (container: HTMLElement) =>
  [...container.querySelectorAll("tbody tr[data-paper-id]")].map((row) =>
    row.getAttribute("data-paper-id")
  );

describe("PapersWorkspace layout", () => {
  it("shows the header, the arXiv input and a closed manual form by default", async () => {
    const container = await render(
      <PapersWorkspace gateway={gatewayWith([paper("p1")])} />
    );
    expect(container.querySelector("h1")?.textContent).toBe("Papers");
    expect(status(container)).toBe("1 paper");
    expect(
      container.querySelector('[aria-label="arXiv ID or URL"]')
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Paper title"]')).toBeNull();
    const toggle = button(container, "Add paper manually");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelector('[data-slot="table-scroll"] table')
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Papers pages"]')).toBeNull();

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[aria-label="Paper title"]')
    ).not.toBeNull();
    await click(toggle);
    expect(container.querySelector('[aria-label="Paper title"]')).toBeNull();
  });

  it("opens and focuses the manual form from the header action", async () => {
    const gateway = gatewayWith([paper("p1"), paper("p2")]);
    const container = await render(<PapersWorkspace gateway={gateway} />);
    expect(status(container)).toBe("2 papers");
    await click(button(container, "Add paper"));
    const title = container.querySelector<HTMLInputElement>(
      '[aria-label="Paper title"]'
    );
    expect(document.activeElement).toBe(title);
    await click(button(container, "Save paper"));
    expect(gateway.add).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Title is required.");
    await setValue(title, "Manual");
    await click(button(container, "Save paper"));
    expect(gateway.add).toHaveBeenCalledWith({
      sourceUrl: null,
      title: "Manual",
    });
    expect(status(container)).toBe("3 papers");
  });

  it("shows loading, unavailable and forbidden header states", async () => {
    const pending: PapersGateway = {
      ...gatewayWith([]),
      list: vi.fn(() => new Promise<ResearchPaperOutput[]>(() => undefined)),
    };
    const loading = await render(<PapersWorkspace gateway={pending} />);
    expect(status(loading)).toBe("Loading");

    const failing: PapersGateway = {
      ...gatewayWith([]),
      list: vi.fn(async () => Promise.reject({ code: "STORAGE_ERROR" })),
    };
    const failed = await render(<PapersWorkspace gateway={failing} />);
    expect(status(failed)).toBe("Unavailable");
    expect(failed.querySelector('[role="alert"]')).not.toBeNull();

    const forbidden: PapersGateway = {
      ...gatewayWith([]),
      list: vi.fn(async () => Promise.reject({ code: "FORBIDDEN" })),
    };
    const denied = await render(<PapersWorkspace gateway={forbidden} />);
    expect(denied.querySelector("h1")?.textContent).toBe("Papers");
    expect(status(denied)).toBeUndefined();
    expect(denied.textContent).not.toContain("Add paper");
  });

  it("filters by stage from ?status= and writes changes to the URL", async () => {
    window.history.replaceState(null, "", "/papers?status=implemented");
    const gateway = gatewayWith([
      paper("p1"),
      paper("p2", { stage: "implemented" }),
    ]);
    const container = await render(
      <PapersWorkspace gateway={gateway} initialStatus="implemented" />
    );
    expect(rowIds(container)).toEqual(["p2"]);
    const filter = container.querySelector('[aria-label="Filter by stage"]');
    await setValue(filter, "backtested");
    expect(container.textContent).toContain("No papers at this stage.");
    expect(window.location.search).toBe("?status=backtested");
    await setValue(filter, "");
    expect(rowIds(container)).toEqual(["p1", "p2"]);
    expect(window.location.search).toBe("");
  });

  it("ignores an unknown ?status= value", async () => {
    const container = await render(
      <PapersWorkspace gateway={gatewayWith([paper("p1")])} initialStatus="x" />
    );
    expect(rowIds(container)).toEqual(["p1"]);
    expect(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Filter by stage"]'
      )?.value
    ).toBe("");
  });

  it("pages long tables", async () => {
    const papers = Array.from({ length: PAPERS_PAGE_SIZE + 2 }, (_, index) =>
      paper(`p${index}`)
    );
    const container = await render(
      <PapersWorkspace gateway={gatewayWith(papers)} />
    );
    expect(rowIds(container)).toHaveLength(PAPERS_PAGE_SIZE);
    const range = () =>
      container.querySelector('[data-testid="papers-page-range"]')?.textContent;
    expect(range()).toBe(`1–${PAPERS_PAGE_SIZE} of ${papers.length}`);
    expect(button(container, "Previous").disabled).toBe(true);
    await click(button(container, "Next"));
    expect(rowIds(container)).toEqual([
      `p${PAPERS_PAGE_SIZE}`,
      `p${PAPERS_PAGE_SIZE + 1}`,
    ]);
    expect(button(container, "Next").disabled).toBe(true);
    await click(button(container, "Previous"));
    expect(range()).toBe(`1–${PAPERS_PAGE_SIZE} of ${papers.length}`);

    // Filtering resets to the first page; a short result has no pager.
    await click(button(container, "Next"));
    await setValue(
      container.querySelector('[aria-label="Filter by stage"]'),
      "queued"
    );
    expect(range()).toBe(`1–${PAPERS_PAGE_SIZE} of ${papers.length}`);
  });

  it("adds from arXiv, reports duplicates and failures, and validates input", async () => {
    const created = paper("ax", { identifier: "2402.05272v3" });
    const gateway: PapersGateway = {
      ...gatewayWith([]),
      addFromArxiv: vi
        .fn()
        .mockResolvedValueOnce({ created: true, paper: created })
        .mockResolvedValueOnce({
          created: false,
          paper: paper("ax", { title: "Untitled" }),
        })
        .mockResolvedValueOnce({ created: false, paper: paper("plain") })
        .mockRejectedValueOnce({ code: "STORAGE_ERROR" }),
    };
    const container = await render(<PapersWorkspace gateway={gateway} />);
    expect(container.textContent).toContain("No papers.");
    const input = container.querySelector('[aria-label="arXiv ID or URL"]');
    const feedback = () =>
      container.querySelector('[role="status"][aria-live="polite"]')
        ?.textContent;
    await click(button(container, "Add from arXiv"));
    expect(feedback()).toBe("arXiv ID or URL is required.");
    await setValue(input, " 2402.05272 ");
    await click(button(container, "Add from arXiv"));
    expect(gateway.addFromArxiv).toHaveBeenCalledWith("2402.05272");
    expect(feedback()).toBe("Added 2402.05272v3 from the arXiv API");
    expect((input as HTMLInputElement).value).toBe("");
    await setValue(input, "2402.05272");
    await click(button(container, "Add from arXiv"));
    expect(feedback()).toBe("Already listed: Untitled");
    expect(rowIds(container)).toEqual(["ax"]);
    await setValue(input, "x");
    await click(button(container, "Add from arXiv"));
    expect(feedback()).toBe("Already listed: Paper plain");
    await setValue(input, "y");
    await click(button(container, "Add from arXiv"));
    expect(feedback()).toContain("503");
    expect((input as HTMLInputElement).value).toBe("y");
  });

  it("reports manual add failures and ignores results while the list is unavailable", async () => {
    const gateway: PapersGateway = {
      ...gatewayWith([]),
      add: vi.fn().mockRejectedValueOnce({ code: "STORAGE_ERROR" }),
      addFromArxiv: vi
        .fn()
        .mockResolvedValueOnce({ created: true, paper: paper("ax") }),
      list: vi
        .fn()
        .mockRejectedValueOnce({ code: "STORAGE_ERROR" })
        .mockResolvedValueOnce([paper("p1")]),
    };
    const container = await render(<PapersWorkspace gateway={gateway} />);
    await setValue(
      container.querySelector('[aria-label="arXiv ID or URL"]'),
      "1"
    );
    await click(button(container, "Add from arXiv"));
    expect(rowIds(container)).toEqual([]);
    expect(status(container)).toBe("Unavailable");

    await click(button(container, "Add paper"));
    await setValue(container.querySelector('[aria-label="Paper title"]'), "T");
    const urlInput = [...document.querySelectorAll("label")]
      .find((label) => /^Source URL/u.test(label.textContent ?? ""))
      ?.querySelector("input") as HTMLInputElement;
    expect(urlInput?.getAttribute("aria-label")).toBeNull();
    expect(urlInput?.closest("label")?.textContent).toContain("Source URL");
    for (const select of container.querySelectorAll("select"))
      expect(select.className).toContain("h-11");
    await setValue(
      [...document.querySelectorAll("label")]
        .find((label) => /^Source URL/u.test(label.textContent ?? ""))
        ?.querySelector("input") as HTMLInputElement,
      "https://domain.test/a"
    );
    await click(button(container, "Save paper"));
    expect(gateway.add).toHaveBeenCalledWith({
      sourceUrl: "https://domain.test/a",
      title: "T",
    });
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Paper title"]')
        ?.value
    ).toBe("T");

    await click(button(container, "Retry"));
    expect(rowIds(container)).toEqual(["p1"]);
  });

  it("shows paper links and metadata, edits every field and handles save errors", async () => {
    const gateway: PapersGateway = {
      ...gatewayWith([
        paper("p1", {
          authors: "A. Author",
          kind: "article",
          notes: "read twice",
          reportedMetrics: { sharpe: 1.1 },
          sourceUrl: "https://domain.test/p1",
          year: 2024,
        }),
        paper("p2"),
      ]),
      update: vi
        .fn()
        .mockRejectedValueOnce({ code: "STORAGE_ERROR" })
        .mockImplementationOnce(async (input) =>
          paper("p1", { notes: input.notes, stage: input.stage })
        ),
    };
    const container = await render(<PapersWorkspace gateway={gateway} />);
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-paper-id="p1"] a'
    );
    expect(link?.href).toBe("https://domain.test/p1");
    expect(container.textContent).toContain("Article · A. Author · 2024");
    expect(container.textContent).toContain("read twice");

    await click(button(container, "Edit"));
    const field = (label: string) =>
      container.querySelector(`[aria-label="Paper p1 ${label}"]`);
    const setArea = async (label: string, value: string) => {
      const area = field(label) as HTMLTextAreaElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set?.call(area, value);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    };
    await setArea("notes", "  ");
    await setArea("blockers", "data");
    await setArea("reported metrics", "not a metric");
    await click(button(container, "Save"));
    expect(gateway.update).not.toHaveBeenCalled();
    await setArea("reported metrics", "sharpe=1");
    await setArea("reproduced metrics", "bad");
    await click(button(container, "Save"));
    expect(gateway.update).not.toHaveBeenCalled();
    await setArea("reproduced metrics", "");
    await setValue(field("stage"), "implemented");
    await setValue(field("verdict"), "promising");
    await click(button(container, "Save"));
    expect(gateway.update).toHaveBeenCalledTimes(1);
    expect(field("notes")).not.toBeNull();
    await setArea("notes", "kept");
    await click(button(container, "Save"));
    expect(gateway.update).toHaveBeenLastCalledWith({
      blockers: "data",
      id: "p1",
      notes: "kept",
      reportedMetrics: { sharpe: 1 },
      reproducedMetrics: {},
      stage: "implemented",
      verdict: "promising",
    });
    expect(field("notes")).toBeNull();
    expect(container.textContent).toContain("Saved Paper p1");

    await click(
      container.querySelector('[aria-label="Edit Paper p2"]') as HTMLElement
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Paper p2 notes"]'
      )?.value
    ).toBe("");
    await click(button(container, "Cancel"));
    expect(container.querySelector('[aria-label="Paper p2 notes"]')).toBeNull();
  });

  it("ignores a list load that settles after the page is gone", async () => {
    // Executor form: the web TypeScript lib has no Promise.withResolvers.
    const settlers: (() => void)[] = [];
    const lists = [
      new Promise<ResearchPaperOutput[]>((resolve) => {
        settlers.push(() => resolve([paper("p1")]));
      }),
      new Promise<ResearchPaperOutput[]>((_resolve, reject) => {
        settlers.push(() => reject({ code: "STORAGE_ERROR" }));
      }),
    ];
    for (const list of lists)
      await render(
        <PapersWorkspace
          gateway={{ ...gatewayWith([]), list: vi.fn(() => list) }}
        />
      );
    for (const root of roots.splice(0)) await act(async () => root.unmount());

    // As after the jsdom teardown, there is no usable `window`. React reads it
    // in every state update, so a late update rejects the load with nobody to
    // catch it.
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    vi.stubGlobal("window", undefined);
    try {
      for (const settler of settlers) settler();
      // Node reports an unhandled rejection after the microtask queue drains.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    } finally {
      vi.unstubAllGlobals();
      process.off("unhandledRejection", record);
    }
    expect(unhandled).toEqual([]);
  });

  it("creates the browser gateway when none is supplied", async () => {
    // No network in a unit test: the request is refused at once, so the load
    // settles before the test ends. The browser client is built here and kept
    // by its module, with this stub: a later test of this file cannot swap it.
    const request = vi.fn(async () =>
      Promise.reject(new TypeError("fetch failed"))
    );
    vi.stubGlobal("fetch", request);
    try {
      const container = await render(<PapersWorkspace />);
      expect(request).toHaveBeenCalledOnce();
      expect(status(container)).toBe("Unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
