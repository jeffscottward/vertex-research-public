// @vitest-environment jsdom
import type { OpenbbInsiderClustersOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { InsiderClustersGateway } from "./insider-clusters-client.ts";
import {
  coverageText,
  InsiderClustersWorkspace,
  valueText,
} from "./insider-clusters-workspace.tsx";

const browserClusters = vi.hoisted(() => vi.fn());
vi.mock("./insider-clusters-client.ts", () => ({
  createBrowserInsiderClustersGateway: () => ({ clusters: browserClusters }),
}));

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
  browserClusters.mockReset();
  document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

type Coverage = OpenbbInsiderClustersOutput["coverage"];
const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({
  incompleteDays: [],
  lastOkAt: "2026-10-13T14:00:00.000Z",
  lastRunAt: "2026-10-13T14:00:00.000Z",
  lastStatus: "ok",
  newestCompleteDay: "2026-10-12",
  overdue: false,
  ...overrides,
});

const URL_A =
  "https://www.sec.gov/Archives/edgar/data/1/000000000126000001.txt";

const output = (
  overrides: Partial<OpenbbInsiderClustersOutput> = {}
): OpenbbInsiderClustersOutput => ({
  clusters: [
    {
      filings: [
        {
          acceptedAt: "2026-10-10T20:01:00.000Z",
          accessionNumber: "0000000001-26-000001",
          owners: [
            { cik: "0000000011", name: "Jane <b>Roe</b>", title: "CEO" },
            { cik: "0000000012", name: "John Doe", title: null },
          ],
          plan10b51: true,
          shares: 1000,
          url: URL_A,
          value: 25_000,
          valueIncomplete: false,
        },
        {
          acceptedAt: "2026-10-11T20:01:00.000Z",
          accessionNumber: "0000000001-26-000002",
          owners: [{ cik: "0000000013", name: "Ann Lee", title: "Director" }],
          plan10b51: false,
          shares: 500,
          url: URL_A,
          value: 10_000,
          valueIncomplete: true,
        },
        {
          acceptedAt: "2026-10-12T20:01:00.000Z",
          accessionNumber: "0000000001-26-000003",
          owners: [{ cik: "0000000014", name: "Bo Kim", title: null }],
          plan10b51: null,
          shares: 200,
          url: URL_A,
          value: 4000,
          valueIncomplete: false,
        },
      ],
      firstAcceptedAt: "2026-10-10T20:01:00.000Z",
      issuerCik: "0000000001",
      issuerName: "Acme Corp",
      issuerSymbol: "ACME",
      lastAcceptedAt: "2026-10-12T20:01:00.000Z",
      persons: 4,
      shares: 1700,
      value: 39_000,
      valueIncomplete: true,
    },
    {
      filings: [],
      firstAcceptedAt: "2026-10-10T20:01:00.000Z",
      issuerCik: "0000000002",
      issuerName: null,
      issuerSymbol: null,
      lastAcceptedAt: "2026-10-12T20:01:00.000Z",
      persons: 3,
      shares: 10,
      value: 100,
      valueIncomplete: false,
    },
  ],
  coverage: coverage(),
  days: 7,
  delay: "Form 4 is due within 2 business days",
  receivedAt: "2026-10-13T15:00:00.000Z",
  source: "SEC EDGAR Form 4",
  ...overrides,
});

const render = async (
  props: Parameters<typeof InsiderClustersWorkspace>[0]
) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<InsiderClustersWorkspace {...props} />);
    await flush();
  });
  return host;
};

const gatewayOf = (
  clusters: InsiderClustersGateway["clusters"]
): InsiderClustersGateway => ({ clusters });

const buttonNamed = (host: HTMLElement, text: string) => {
  const button = [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text)
  );
  if (button === undefined) throw new Error(`no button ${text}`);
  return button;
};

describe("coverage and value text", () => {
  it("describes each coverage state", () => {
    expect(coverageText(coverage())).toBe(
      "Form 4: index complete through 2026-10-12"
    );
    expect(coverageText(coverage({ newestCompleteDay: null }))).toBe(
      "Form 4: index complete through —"
    );
    expect(coverageText(coverage({ overdue: true }))).toBe(
      "Form 4: overdue · last good run 2026-10-13 14:00 UTC"
    );
    expect(coverageText(coverage({ lastOkAt: null, overdue: true }))).toBe(
      "Form 4: overdue · no good run yet"
    );
  });
  it("marks incomplete values as a lower bound", () => {
    expect(valueText(1000, true)).toBe("≥ $1,000");
    expect(valueText(1000, false)).toBe("$1,000");
  });
});

describe("InsiderClustersWorkspace", () => {
  it("renders clusters, expands filings as plain text and collapses", async () => {
    const clusters = vi.fn(async () => output());
    const host = await render({ gateway: gatewayOf(clusters) });
    expect(clusters).toHaveBeenCalledWith({ days: 7 });
    expect(host.textContent).toContain("Insider cluster buys");
    expect(host.textContent).toContain(
      "Form 4: index complete through 2026-10-12"
    );
    expect(host.textContent).toContain("SEC EDGAR Form 4");
    expect(host.textContent).toContain("2 clusters");
    expect(host.textContent).toContain("≥ $39,000");
    expect(host.textContent).toContain("CIK 0000000002");
    const toggle = buttonNamed(host, "Acme Corp");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Jane <b>Roe</b>");
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toContain("Yes");
    expect(host.textContent).toContain("No");
    const link = host.querySelector<HTMLAnchorElement>(`a[href="${URL_A}"]`);
    expect(link?.rel).toBe("noreferrer");
    expect(link?.target).toBe("_blank");
    expect(link?.textContent).toBe("EDGAR filing");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("Jane");
    expect(window.location.search).toBe("");
  });

  it("shows the empty state and one cluster", async () => {
    const host = await render({
      gateway: gatewayOf(async () =>
        output({
          clusters: [],
          coverage: coverage({ overdue: true }),
          days: 14,
        })
      ),
      initial: { days: 14 },
    });
    expect(host.textContent).toContain("No cluster buys in the last 14 days.");
    expect(host.textContent).toContain("Form 4: overdue");
    expect(window.location.search).toBe("?days=14");
    const single = await render({
      gateway: gatewayOf(async () =>
        output({ clusters: output().clusters.slice(1) })
      ),
    });
    expect(single.textContent).toContain("1 cluster");
  });

  it("shows loading, then an error with retry, and refreshes", async () => {
    let fail = true;
    const clusters = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return output();
    });
    const host = await render({ gateway: gatewayOf(clusters) });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain("Load failed");
    fail = false;
    await act(async () => {
      buttonNamed(host, "Try again").click();
      await flush();
    });
    expect(host.textContent).toContain("Acme Corp");
    await act(async () => {
      buttonNamed(host, "Refresh").click();
      await flush();
    });
    expect(clusters).toHaveBeenCalledTimes(3);
  });

  it("changes the window, updates the URL and ignores stale answers", async () => {
    let releaseFirst: (value: OpenbbInsiderClustersOutput) => void = () =>
      undefined;
    const clusters = vi.fn(
      (settings: { days: number }) =>
        new Promise<OpenbbInsiderClustersOutput>((resolve) => {
          if (settings.days === 7) releaseFirst = resolve;
          else resolve(output({ clusters: [], days: 30 }));
        })
    );
    const host = await render({ gateway: gatewayOf(clusters) });
    expect(host.textContent).toContain("Loading cluster buys");
    const select = host.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "30";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(window.location.search).toBe("?days=30");
    await act(async () => {
      releaseFirst(output());
      await flush();
    });
    expect(host.textContent).toContain("No cluster buys in the last 30 days.");
  });

  it("uses the browser gateway by default", async () => {
    browserClusters.mockResolvedValue(output({ clusters: [] }));
    await render({});
    expect(browserClusters).toHaveBeenCalledWith({ days: 7 });
  });
});
