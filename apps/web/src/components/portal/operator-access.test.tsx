// @vitest-environment jsdom
import { act, type ReactElement } from "react";
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

import {
  describeAgentOpsFailure,
  isOperatorAccessDenied,
  type AgentOpsGateway,
  type PapersGateway,
} from "./agent-ops-client.tsx";
import { AgentRunsWorkspace } from "./agent-runs-workspace.tsx";
import { MissionControl } from "./mission-control.tsx";
import { PapersWorkspace } from "./papers-workspace.tsx";

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
  return document.body.replaceChildren();
});

const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 20; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});

const forbidden = () =>
  Object.assign(new Error("Operator access required"), {
    code: "FORBIDDEN",
    status: 403,
  });

const deniedAgentGateway = (): AgentOpsGateway => ({
  summary: vi.fn(async () => {
    throw forbidden();
  }),
  listTasks: vi.fn(async () => {
    throw forbidden();
  }),
  getTask: vi.fn(async () => {
    throw forbidden();
  }),
  createTask: vi.fn(async () => {
    throw forbidden();
  }),
  updateTask: vi.fn(async () => {
    throw forbidden();
  }),
  appendEvent: vi.fn(async () => {
    throw forbidden();
  }),
});

const deniedPapersGateway = (): PapersGateway => ({
  list: vi.fn(async () => {
    throw forbidden();
  }),
  add: vi.fn(async () => {
    throw forbidden();
  }),
  update: vi.fn(async () => {
    throw forbidden();
  }),
  addFromArxiv: vi.fn(async () => {
    throw forbidden();
  }),
});

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

const expectOperatorState = (container: HTMLElement) => {
  const notice = container.querySelector('[data-operator-access="required"]');
  expect(notice).not.toBeNull();
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.textContent).toContain("Operator access required");
  return expect(container.querySelector('[role="alert"]')).toBeNull();
};

describe("operator access required state", () => {
  it("classifies only FORBIDDEN as operator denial", () => {
    expect(isOperatorAccessDenied(forbidden())).toBe(true);
    expect(
      isOperatorAccessDenied(
        Object.assign(new Error("x"), { code: "UNAUTHORIZED" })
      )
    ).toBe(false);
    expect(isOperatorAccessDenied(new Error("network"))).toBe(false);
    return expect(describeAgentOpsFailure(forbidden())).toBe(
      "Operator access required."
    );
  });

  it("Mission control shows the operator notice instead of an error", async () => {
    const container = await mount(
      <MissionControl gateway={deniedAgentGateway()} />
    );
    expectOperatorState(container);
    return expect(container.textContent).not.toContain("Retry");
  });

  it("Agent runs shows the operator notice and no create form", async () => {
    const container = await mount(
      <AgentRunsWorkspace gateway={deniedAgentGateway()} initialTaskId={null} />
    );
    expectOperatorState(container);
    return expect(
      container.querySelector('[aria-label="New task title"]')
    ).toBeNull();
  });

  it("Papers shows the operator notice and no add form", async () => {
    const container = await mount(
      <PapersWorkspace gateway={deniedPapersGateway()} />
    );
    expectOperatorState(container);
    return expect(
      container.querySelector('[aria-label="Paper title"]')
    ).toBeNull();
  });

  return it("keeps the ordinary error state for non-403 failures", async () => {
    const gateway: PapersGateway = {
      ...deniedPapersGateway(),
      list: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "STORAGE_ERROR" });
      }),
    };
    const container = await mount(<PapersWorkspace gateway={gateway} />);
    expect(
      container.querySelector('[data-operator-access="required"]')
    ).toBeNull();
    return expect(
      container.querySelector('[role="alert"]')?.textContent
    ).toContain("migrations 0015 and 0017");
  });
});
