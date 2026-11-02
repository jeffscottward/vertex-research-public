// @vitest-environment jsdom
import type { AgentApiKeyOutput } from "@darkfactory/api";
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
  AgentApiKeysSection,
  displayKeyPrefix,
} from "./agent-api-keys-section.tsx";
import type { AgentApiKeysGateway } from "./agent-ops-client.tsx";

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
const at = new Date("2026-01-02T03:04:05.000Z");
const used = new Date("2026-01-03T04:05:06.000Z");
const PLAINTEXT = `vrk_${"Q".repeat(64)}`;

const key = (
  id: string,
  overrides: Partial<AgentApiKeyOutput> = {}
): AgentApiKeyOutput => ({
  id,
  name: `key ${id}`,
  prefix: "vrk_",
  start: "vrk_Ab",
  access: "read",
  enabled: true,
  createdAt: at,
  lastUsedAt: null,
  expiresAt: null,
  ...overrides,
});

const gatewayWith = (
  rows: AgentApiKeyOutput[],
  overrides: Partial<AgentApiKeysGateway> = {}
): AgentApiKeysGateway => ({
  list: vi.fn(async () => rows),
  create: vi.fn(async (name: string) => ({
    apiKey: key("new", { name, start: "vrk_QQ" }),
    key: PLAINTEXT,
  })),
  revoke: vi.fn(async () => undefined),
  ...overrides,
});

const setValue = async (element: HTMLInputElement, value: string) => {
  return await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return await flush();
  });
};

const clickButton = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (button === undefined) throw new Error(`Missing button ${label}`);
  return await act(async () => {
    button.click();
    return await flush();
  });
};

const byLabel = <T extends Element>(label: string): T => {
  const found = document.querySelector<T>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`Missing ${label}`);
  return found;
};

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

describe("agent API keys section", () => {
  it("lists name, prefix, created and last used without any full key", async () => {
    const container = await mount(
      <AgentApiKeysSection
        gateway={gatewayWith([
          key("a"),
          key("b", { lastUsedAt: used, name: null, start: null }),
        ])}
      />
    );
    const rows = [...container.querySelectorAll("tbody tr[data-api-key-id]")];
    expect(rows.map((row) => row.getAttribute("data-api-key-id"))).toEqual([
      "a",
      "b",
    ]);
    expect(rows[0]!.textContent).toContain("key a");
    expect(rows[0]!.textContent).toContain("vrk_Ab…");
    expect(rows[0]!.textContent).toContain("2026-01-02 03:04");
    expect(rows[0]!.textContent).toContain("Never");
    expect(rows[1]!.textContent).toContain("(unnamed)");
    expect(rows[1]!.textContent).toContain("vrk_…");
    expect(rows[1]!.textContent).toContain("2026-01-03 04:05");
    return expect(
      container.querySelector('[aria-label="Full API key"]')
    ).toBeNull();
  });

  it("creates a named key and shows the full key exactly once", async () => {
    const gateway = gatewayWith([]);
    const container = await mount(<AgentApiKeysSection gateway={gateway} />);
    expect(container.textContent).toContain("No API keys.");
    await setValue(byLabel<HTMLInputElement>("API key name"), "  omp-rig ");
    await clickButton("Create key");
    expect(gateway.create).toHaveBeenCalledWith("omp-rig", "read");
    expect(byLabel<HTMLInputElement>("Full API key").value).toBe(PLAINTEXT);
    expect(container.textContent).toContain("shown only once");
    expect(
      container.querySelector('[data-api-key-id="new"]')?.textContent
    ).toContain("vrk_QQ…");
    expect(byLabel<HTMLInputElement>("API key name").value).toBe("");

    await clickButton("Done");
    expect(container.querySelector('[aria-label="Full API key"]')).toBeNull();
    expect(container.innerHTML).not.toContain(PLAINTEXT);
    return expect(gateway.list).toHaveBeenCalledTimes(1);
  });

  it("requires a name before calling the API", async () => {
    const gateway = gatewayWith([]);
    const container = await mount(<AgentApiKeysSection gateway={gateway} />);
    await clickButton("Create key");
    expect(gateway.create).not.toHaveBeenCalled();
    return expect(container.textContent).toContain("Name is required");
  });

  it("revokes only after an explicit confirmation", async () => {
    const gateway = gatewayWith([key("a"), key("b")]);
    const container = await mount(<AgentApiKeysSection gateway={gateway} />);
    await clickButton("Revoke key a");
    expect(gateway.revoke).not.toHaveBeenCalled();
    await clickButton("Confirm revoke key a");
    expect(gateway.revoke).toHaveBeenCalledWith("a");
    expect(
      [...container.querySelectorAll("tbody tr[data-api-key-id]")].map((row) =>
        row.getAttribute("data-api-key-id")
      )
    ).toEqual(["b"]);
    return expect(container.textContent).toContain("Revoked key a");
  });

  it("reports list and create failures", async () => {
    const failing = gatewayWith([], {
      list: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "UNAUTHORIZED" });
      }),
    });
    const container = await mount(<AgentApiKeysSection gateway={failing} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Session expired"
    );

    const rejecting = gatewayWith([], {
      create: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
      }),
    });
    const second = await mount(<AgentApiKeysSection gateway={rejecting} />);
    await setValue(
      second.querySelector<HTMLInputElement>('[aria-label="API key name"]')!,
      "omp"
    );
    const create = [...second.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Create key"
    )!;
    await act(async () => {
      create.click();
      return await flush();
    });
    expect(second.textContent).toContain("Operator access required.");
    return expect(
      second.querySelector('[aria-label="Full API key"]')
    ).toBeNull();
  });

  it("renders nothing for non-operators (the Agent runs workspace shows the notice)", async () => {
    const gateway = gatewayWith([], {
      list: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "FORBIDDEN", status: 403 });
      }),
    });
    const container = await mount(<AgentApiKeysSection gateway={gateway} />);
    expect(container.querySelector('[aria-label="API key name"]')).toBeNull();
    return expect(container.textContent).toBe("");
  });

  return it("formats the prefix column from the stored starting characters", () => {
    expect(displayKeyPrefix({ start: "vrk_Xy", prefix: "vrk_" })).toBe(
      "vrk_Xy…"
    );
    expect(displayKeyPrefix({ start: null, prefix: "vrk_" })).toBe("vrk_…");
    return expect(displayKeyPrefix({ start: null, prefix: null })).toBe("—");
  });
});
