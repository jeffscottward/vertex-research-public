// @vitest-environment jsdom
import {
  DEPLOYMENT_NOT_DISPATCHED_REASON,
  type DeploymentRequestOutput,
  type StrategyGetOutput,
  type StrategySummaryOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  DeploymentGateway,
  DeploymentRequestsGateway,
  StrategyLibraryGateway,
} from "./agent-ops-client.tsx";
import {
  limitsFromForm,
  NOT_DISPATCHED_LABEL,
  newRequestHref,
  requestActions,
} from "./deployment-requests-model.ts";
import {
  DeploymentRequestsWorkspace,
  readRequestPanel,
} from "./deployment-requests-workspace.tsx";
import { DeploymentsView } from "./deployments-view.tsx";
import { StrategyDetail } from "./strategy-library-detail.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  return;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  } else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  return;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/deployments");
  return;
});

const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 20; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});
const at = new Date("2026-01-02T03:04:05.000Z");

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return container;
};

const button = (
  label: string,
  scope: ParentNode = document
): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const click = async (element: HTMLElement) => {
  return await act(async () => {
    element.click();
    return await flush();
  });
};

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) => {
  return await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    return await flush();
  });
};

const field = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Missing ${selector}`);
  return found;
};

const lookback = {
  default: 20,
  max: 250,
  min: 5,
  name: "lookback",
  step: 1,
  title: "Lookback bars",
  type: "integer" as const,
};
const side = {
  default: "long",
  name: "side",
  options: ["long", "short"],
  title: "Side",
  type: "choice" as const,
};
const limits = {
  dailyLossLimit: 500,
  maxOrderSize: 1,
  maxOrdersPerMinute: 5,
  maxPosition: 2,
};
const LOCK = {
  brokerSubmissionAllowed: false as const,
  dispatch: {
    reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
    state: "not-dispatched" as const,
  },
  executionAuthorized: false as const,
};

const summary = (
  overrides: Partial<StrategySummaryOutput> = {}
): StrategySummaryOutput => ({
  backtestCount: 0,
  createdAt: at,
  description: null,
  favorite: false,
  id: "s-hmm",
  kind: "python",
  latestBacktest: null,
  name: "HMM forward filter",
  params: [lookback, side],
  presetCount: 1,
  section: null,
  slug: "hmm",
  sourceRef: null,
  status: "researching",
  tags: [],
  updatedAt: at,
  ...overrides,
});

const strategyDetail = (row = summary()): StrategyGetOutput => ({
  backtests: [],
  presets: [
    {
      createdAt: at,
      id: "p-fast",
      name: "fast",
      strategyId: row.id,
      updatedAt: at,
      values: { lookback: 10, side: "short" },
    },
  ],
  strategy: row,
});

const request = (
  overrides: Partial<DeploymentRequestOutput> = {}
): DeploymentRequestOutput => ({
  createdAt: at,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  id: "dr-1",
  limits,
  mode: "paper",
  params: { lookback: 20, side: "long" },
  presetId: null,
  presetName: null,
  requestedAt: at,
  requestedBy: "user-a",
  status: "requested",
  strategyId: "s-hmm",
  strategyName: "HMM forward filter",
  strategySlug: "hmm",
  symbol: "ES",
  timeframe: "5m",
  updatedAt: at,
  ...LOCK,
  ...overrides,
});

const strategiesGateway = (): StrategyLibraryGateway & {
  [K in keyof StrategyLibraryGateway]: ReturnType<typeof vi.fn>;
} => {
  return {
    create: vi.fn(),
    get: vi.fn(async (id: string) =>
      id === "s-jump"
        ? {
            backtests: [],
            presets: [],
            strategy: summary({
              id: "s-jump",
              name: "Jump model",
              params: [],
              slug: "jump",
            }),
          }
        : strategyDetail()
    ),
    list: vi.fn(async () => [
      summary(),
      summary({ id: "s-jump", name: "Jump model", params: [], slug: "jump" }),
    ]),
    removePreset: vi.fn(),
    savePreset: vi.fn(),
    update: vi.fn(),
  } as unknown as StrategyLibraryGateway & {
    [K in keyof StrategyLibraryGateway]: ReturnType<typeof vi.fn>;
  };
};

const requestsGateway = (initial: DeploymentRequestOutput[]) => {
  let rows = [...initial];
  const replace = (next: DeploymentRequestOutput) => {
    rows = [next, ...rows.filter((row) => row.id !== next.id)];
    return next;
  };
  const find = (id: string) => rows.find((row) => row.id === id)!;
  const gateway = {
    approve: vi.fn(async (id: string, _slug: string, note?: string) =>
      replace({
        ...find(id),
        decidedAt: at,
        decidedBy: "user-a",
        decisionNote: note ?? null,
        status: "approved",
      })
    ),
    create: vi.fn(async (input) =>
      replace(
        request({
          id: "dr-new",
          limits: input.limits,
          params: input.params,
          presetId: input.presetId ?? null,
          presetName: input.presetId === "p-fast" ? "fast" : null,
          requestedAt: null,
          status: "draft",
          symbol: input.symbol,
          timeframe: input.timeframe,
        })
      )
    ),
    get: vi.fn(async (id: string) => find(id)),
    list: vi.fn(async () => rows),
    reject: vi.fn(async (id: string, note: string) =>
      replace({
        ...find(id),
        decidedAt: at,
        decidedBy: "user-a",
        decisionNote: note,
        status: "rejected",
      })
    ),
    submit: vi.fn(async (id: string) =>
      replace({ ...find(id), requestedAt: at, status: "requested" })
    ),
    update: vi.fn(async (input) => replace({ ...find(input.id), ...input })),
    withdraw: vi.fn(async (id: string) =>
      replace({ ...find(id), status: "withdrawn" })
    ),
  };
  return gateway as unknown as DeploymentRequestsGateway & {
    [K in keyof DeploymentRequestsGateway]: ReturnType<typeof vi.fn>;
  };
};

describe("deployment request model", () =>
  it("parses limits and allows actions by status", () => {
    expect(
      limitsFromForm({
        dailyLossLimit: "500",
        maxOrderSize: "1",
        maxOrdersPerMinute: "5",
        maxPosition: "2",
      })
    ).toEqual(limits);
    expect(
      limitsFromForm({
        dailyLossLimit: "500",
        maxOrderSize: "",
        maxOrdersPerMinute: "5",
        maxPosition: "2",
      })
    ).toBe("Max order size is required.");
    expect(
      limitsFromForm({
        dailyLossLimit: "500",
        maxOrderSize: "1",
        maxOrdersPerMinute: "2.5",
        maxPosition: "2",
      })
    ).toBe("Max orders / minute must be a whole number.");
    expect(
      limitsFromForm({
        dailyLossLimit: "500",
        maxOrderSize: "3",
        maxOrdersPerMinute: "5",
        maxPosition: "2",
      })
    ).toBe("Max order size must not exceed max position.");
    expect(
      limitsFromForm({
        dailyLossLimit: "0",
        maxOrderSize: "1",
        maxOrdersPerMinute: "5",
        maxPosition: "2",
      })
    ).toBe("Daily loss limit must be greater than 0.");
    expect(requestActions("draft")).toEqual({
      approve: false,
      edit: true,
      reject: false,
      submit: true,
      withdraw: true,
    });
    expect(requestActions("requested")).toEqual({
      approve: true,
      edit: false,
      reject: true,
      submit: false,
      withdraw: true,
    });
    expect(requestActions("approved")).toEqual({
      approve: false,
      edit: false,
      reject: false,
      submit: false,
      withdraw: true,
    });
    expect(requestActions("rejected")).toEqual({
      approve: false,
      edit: false,
      reject: false,
      submit: false,
      withdraw: false,
    });
    expect(readRequestPanel("?view=requests&new=s-hmm")).toEqual({
      strategyId: "s-hmm",
      type: "new",
    });
    return expect(readRequestPanel("?request=dr-1")).toEqual({
      id: "dr-1",
      type: "detail",
    });
  }));

describe("DeploymentRequestsWorkspace", () => {
  it("lists requests with status chips and always shows the not-dispatched chip", async () => {
    const gateway = requestsGateway([
      request(),
      request({ id: "dr-2", status: "approved", symbol: "NQ" }),
    ]);
    const container = await mount(
      <DeploymentRequestsWorkspace
        gateway={gateway}
        strategies={strategiesGateway()}
      />
    );
    expect(
      container.querySelector('[data-dispatch-chip="not-dispatched"]')
        ?.textContent
    ).toBe(NOT_DISPATCHED_LABEL);
    expect(
      [
        ...container.querySelectorAll(
          "[data-request-row] [data-request-status]"
        ),
      ].map((node) => node.textContent)
    ).toEqual(["Requested", "Approved"]);
    await setValue(
      field<HTMLSelectElement>('[aria-label="Status filter"]'),
      "approved"
    );
    expect(gateway.list).toHaveBeenLastCalledWith({ status: "approved" });
    return expect(
      container.querySelector('[data-dispatch-chip="not-dispatched"]')
    ).not.toBeNull();
  });

  it("shows the operator notice instead of the list when the API answers FORBIDDEN", async () => {
    const gateway = requestsGateway([]);
    gateway.list.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "FORBIDDEN" })
    );
    const container = await mount(
      <DeploymentRequestsWorkspace
        gateway={gateway}
        strategies={strategiesGateway()}
      />
    );
    expect(
      container
        .querySelector('[data-operator-access="required"]')
        ?.getAttribute("data-operator-feature")
    ).toBe("deployment-requests");
    return expect(container.querySelector("[data-request-row]")).toBeNull();
  });

  it("creates a draft from a strategy schema, preset and limits, then submits it", async () => {
    const gateway = requestsGateway([]);
    const strategies = strategiesGateway();
    const container = await mount(
      <DeploymentRequestsWorkspace gateway={gateway} strategies={strategies} />
    );
    await click(button("New request"));
    expect(strategies.list).toHaveBeenCalledWith({ sort: "name" });
    await setValue(field<HTMLSelectElement>("#request-strategy"), "s-hmm");
    expect(strategies.get).toHaveBeenCalledWith("s-hmm");
    // Params form generated from the schema with defaults, then the preset's values.
    expect(field<HTMLInputElement>("#request-param-lookback").value).toBe("20");
    expect(field<HTMLSelectElement>("#request-param-side").value).toBe("long");
    await setValue(field<HTMLSelectElement>("#request-preset"), "p-fast");
    expect(field<HTMLInputElement>("#request-param-lookback").value).toBe("10");
    expect(field<HTMLSelectElement>("#request-param-side").value).toBe("short");
    await setValue(field<HTMLInputElement>("#request-symbol"), " mes ");
    await setValue(field<HTMLSelectElement>("#request-timeframe"), "15m");
    await click(button("Save draft"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Max order size is required."
    );
    expect(gateway.create).not.toHaveBeenCalled();
    await setValue(field<HTMLInputElement>("#request-limit-maxOrderSize"), "1");
    await setValue(field<HTMLInputElement>("#request-limit-maxPosition"), "2");
    await setValue(
      field<HTMLInputElement>("#request-limit-maxOrdersPerMinute"),
      "5"
    );
    await setValue(
      field<HTMLInputElement>("#request-limit-dailyLossLimit"),
      "500"
    );
    await click(button("Save draft"));
    expect(gateway.create).toHaveBeenCalledWith({
      limits,
      params: { lookback: 10, side: "short" },
      presetId: "p-fast",
      strategyId: "s-hmm",
      symbol: "mes",
      timeframe: "15m",
    });
    expect(
      container.querySelector('[data-request-detail="dr-new"]')
    ).not.toBeNull();
    expect(window.location.search).toBe("?request=dr-new");
    expect(
      container.querySelector('[data-request-dispatch="not-dispatched"]')
        ?.textContent
    ).toBe(NOT_DISPATCHED_LABEL);
    await click(button("Submit"));
    expect(gateway.submit).toHaveBeenCalledWith("dr-new");
    return expect(
      container.querySelector(
        '[data-request-detail="dr-new"] [data-request-status]'
      )?.textContent
    ).toBe("Requested");
  });

  it("approves only after the strategy slug is typed and keeps the request not dispatched", async () => {
    window.history.replaceState(
      null,
      "",
      "/deployments?view=requests&request=dr-1"
    );
    const gateway = requestsGateway([request()]);
    const container = await mount(
      <DeploymentRequestsWorkspace
        gateway={gateway}
        strategies={strategiesGateway()}
      />
    );
    expect(gateway.get).toHaveBeenCalledWith("dr-1");
    const approve = button("Approve");
    expect(approve.disabled).toBe(true);
    expect(button("Reject").disabled).toBe(true);
    await setValue(field<HTMLInputElement>("#request-confirm-slug"), "hm");
    expect(button("Approve").disabled).toBe(true);
    await setValue(field<HTMLInputElement>("#request-confirm-slug"), "hmm");
    expect(button("Approve").disabled).toBe(false);
    await click(button("Approve"));
    expect(gateway.approve).toHaveBeenCalledWith("dr-1", "hmm", undefined);
    expect(
      container.querySelector(
        '[data-request-detail="dr-1"] [data-request-status]'
      )?.textContent
    ).toBe("Approved");
    expect(
      container.querySelector('[data-request-dispatch="not-dispatched"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-dispatch-chip="not-dispatched"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-request-action="approve"]')
    ).toBeNull();
    await click(button("Withdraw"));
    expect(gateway.withdraw).toHaveBeenCalledWith("dr-1");
    return expect(
      container.querySelector("[data-request-actions] button")
    ).toBeNull();
  });

  it("rejects only with a note", async () => {
    window.history.replaceState(
      null,
      "",
      "/deployments?view=requests&request=dr-1"
    );
    const gateway = requestsGateway([request()]);
    await mount(
      <DeploymentRequestsWorkspace
        gateway={gateway}
        strategies={strategiesGateway()}
      />
    );
    await setValue(
      field<HTMLTextAreaElement>("#request-note"),
      "  limits too wide "
    );
    await click(button("Reject"));
    expect(gateway.reject).toHaveBeenCalledWith("dr-1", "limits too wide");
    return expect(field("[data-request-detail]").textContent).toContain(
      "limits too wide"
    );
  });

  return it("edits a draft and surfaces server conflicts", async () => {
    window.history.replaceState(
      null,
      "",
      "/deployments?view=requests&request=dr-1"
    );
    const gateway = requestsGateway([
      request({ requestedAt: null, status: "draft" }),
    ]);
    gateway.submit.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        code: "CONFLICT",
        message: "Cannot submit a request that is requested",
      })
    );
    const container = await mount(
      <DeploymentRequestsWorkspace
        gateway={gateway}
        strategies={strategiesGateway()}
      />
    );
    await click(button("Submit"));
    expect(
      container.querySelector('[data-request-detail] [role="alert"]')
        ?.textContent
    ).toBe("Cannot submit a request that is requested");
    await click(button("Edit"));
    expect(field<HTMLSelectElement>("#request-strategy").disabled).toBe(true);
    expect(field<HTMLInputElement>("#request-limit-dailyLossLimit").value).toBe(
      "500"
    );
    await setValue(field<HTMLInputElement>("#request-symbol"), "NQ");
    await click(button("Save changes"));
    return expect(gateway.update).toHaveBeenCalledWith({
      id: "dr-1",
      limits,
      params: { lookback: 20, side: "long" },
      presetId: null,
      symbol: "NQ",
      timeframe: "5m",
    });
  });
});

describe("DeploymentsView", () => {
  const monitorGateway = (): DeploymentGateway => ({
    status: vi.fn(async () => {
      throw Object.assign(new Error("x"), { code: "NOT_CONFIGURED" });
    }),
  });

  it("opens the Requests tab with a prefilled form from a strategy library link", async () => {
    window.history.replaceState(null, "", newRequestHref("s-hmm"));
    const strategies = strategiesGateway();
    const container = await mount(
      <DeploymentsView
        monitor={{ gateway: monitorGateway() }}
        requests={{ gateway: requestsGateway([]), strategies }}
      />
    );
    expect(
      container
        .querySelector('[data-view="requests"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    expect(field<HTMLSelectElement>("#request-strategy").value).toBe("s-hmm");
    expect(field<HTMLInputElement>("#request-param-lookback").value).toBe("20");
    await click(button("Monitor"));
    expect(window.location.search).toBe("");
    expect(
      container.querySelector('[data-deployment-state="not-configured"]')
    ).not.toBeNull();
    await click(button("Requests"));
    expect(window.location.search).toBe("?view=requests");
    return expect(
      container.querySelector('[data-dispatch-chip="not-dispatched"]')
    ).not.toBeNull();
  });

  it("renders no view on the server so hydration never swaps the panel", () => {
    window.history.replaceState(null, "", "/deployments?view=requests");
    const html = renderToString(
      <DeploymentsView
        monitor={{ gateway: monitorGateway() }}
        requests={{
          gateway: requestsGateway([]),
          strategies: strategiesGateway(),
        }}
      />
    );
    expect(html).toContain('data-deployments-view="pending"');
    expect(html).not.toContain("Loading deployment status");
    return expect(html).toContain('aria-selected="false"');
  });

  it("sends an Academy strategy to its lesson deploy gate instead of a request", async () => {
    const container = await mount(
      <StrategyDetail
        describeFailure={() => ""}
        detail={strategyDetail(summary({ slug: "dyr-wheel" }))}
        gateway={strategiesGateway()}
        onChanged={async () => undefined}
        onClose={() => undefined}
        onTab={() => undefined}
        tab="overview"
      />
    );
    expect(
      container.querySelector("[data-strategy-request-deployment]")
    ).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-strategy-academy-lesson="dyr-wheel"]'
    )!;
    expect(link.textContent).toBe("Deploy from the Academy lesson");
    return expect(link.getAttribute("href")).toBe("/academy/wheel#deploy");
  });

  return it("links a strategy library detail to a prefilled paper deployment request", async () => {
    const container = await mount(
      <StrategyDetail
        describeFailure={() => ""}
        detail={strategyDetail()}
        gateway={strategiesGateway()}
        onChanged={async () => undefined}
        onClose={() => undefined}
        onTab={() => undefined}
        tab="overview"
      />
    );
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-strategy-request-deployment="s-hmm"]'
    )!;
    expect(link.textContent).toBe("Request paper deployment");
    return expect(link.getAttribute("href")).toBe(
      "/deployments?view=requests&new=s-hmm"
    );
  });
});
