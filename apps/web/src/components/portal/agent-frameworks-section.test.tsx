// @vitest-environment jsdom
import type { AgentFrameworkOutput } from "@darkfactory/api";
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

import type { AgentFrameworksGateway } from "./agent-frameworks-client.ts";
import { AgentFrameworksSection } from "./agent-frameworks-section.tsx";

const defaultGateway = vi.hoisted(() => ({
  frameworks: async () => {
    throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
  },
}));

vi.mock("./agent-frameworks-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-frameworks-client.ts")>()),
  createBrowserAgentFrameworksGateway: () => defaultGateway,
}));

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = false;
});

const sheet = (
  overrides: Partial<AgentFrameworkOutput> = {}
): AgentFrameworkOutput => ({
  benchName: "vibe_trading",
  code: ["services/vibe-trading/driver/vt_driver.py"],
  dataSources: [
    { name: "Web search", note: "Present-day results.", pointInTime: "no" },
  ],
  guards: ["No shell."],
  id: "vibe_trading",
  license: "MIT",
  links: [{ href: "https://github.com/HKUDS/Vibe-Trading", label: "GitHub" }],
  name: "Vibe-Trading",
  stages: [{ name: "bull_advocate", summary: "The long case." }],
  status: "external",
  summary: "Runs in its own clone.",
  toolsAllowed: ["get_market_data", "quantlib_call"],
  toolsExcluded: ["bash", "trading_*"],
  version: "0.1.18 (commit 66eb576)",
  ...overrides,
});

const render = async (gateway?: AgentFrameworksGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      gateway === undefined ? (
        <AgentFrameworksSection />
      ) : (
        <AgentFrameworksSection gateway={gateway} />
      )
    )
  );
  return container;
};

describe("frameworks section", () => {
  it("renders one sheet per framework", async () => {
    const container = await render({
      frameworks: async () => [
        sheet(),
        sheet({
          benchName: null,
          dataSources: [
            {
              name: "Caller context",
              note: "Fetches nothing.",
              pointInTime: "caller",
            },
          ],
          id: "tradingagents",
          name: "TradingAgents",
          status: "reimplemented",
          toolsAllowed: [],
          toolsExcluded: [],
          version: "Not pinned",
        }),
      ],
    });
    const sheets = container.querySelectorAll("article");
    expect(sheets).toHaveLength(2);
    const vibe = sheets[0];
    expect(vibe?.getAttribute("aria-labelledby")).toBe(
      "framework-vibe_trading"
    );
    expect(vibe?.querySelector("h3")?.textContent).toBe("Vibe-Trading");
    expect(vibe?.textContent).toContain(
      "Runs upstream unmodified · Version 0.1.18 (commit 66eb576) · Bench arm vibe_trading:provider:model"
    );
    expect(vibe?.textContent).toContain("Not point in time");
    expect(vibe?.textContent).toContain("Tools allowed (2)");
    expect(vibe?.textContent).toContain("bash, trading_*");
    const link = vibe?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/HKUDS/Vibe-Trading"
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    const desks = sheets[1];
    expect(desks?.textContent).toContain(
      "Re-implemented in Vertex · Version Not pinned · Not in the bench command"
    );
    expect(desks?.textContent).toContain("Point in time: as supplied");
    expect(desks?.textContent).not.toContain("Tools allowed");
  });

  it("wraps long code paths inside one-column sheets on a phone", async () => {
    const container = await render({ frameworks: async () => [sheet()] });
    const classes = (element: Element | null | undefined) =>
      element?.className.split(" ") ?? [];
    const sheetElement = container.querySelector("article");
    // A grid without a column template grows to the longest unbroken path; one column cannot.
    expect(classes(sheetElement?.parentElement)).toContain("grid-cols-1");
    expect(classes(sheetElement)).toEqual(
      expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]"])
    );
    const code = [
      ...(sheetElement?.querySelectorAll("span.font-mono") ?? []),
    ].find(
      (element) =>
        element.textContent === "services/vibe-trading/driver/vt_driver.py"
    );
    expect(classes(code)).toContain("break-all");
  });

  it("shows loading, then an error with a retry", async () => {
    let attempts = 0;
    let release: (() => void) | undefined;
    const container = await render({
      frameworks: () => {
        attempts += 1;
        if (attempts === 1)
          return Promise.reject(
            Object.assign(new Error("down"), { code: "STORAGE_ERROR" })
          );
        return new Promise((resolve) => {
          release = () => resolve([sheet()]);
        });
      },
    });
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Model run storage unavailable (503). Retry."
    );
    const retry = container.querySelector("button");
    await act(async () => retry?.click());
    expect(container.querySelector("[role='status']")?.textContent).toBe(
      "Loading the frameworks"
    );
    await act(async () => release?.());
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("renders nothing without operator access (browser gateway)", async () => {
    const container = await render();
    expect(container.querySelector("section")).toBeNull();
  });
});
