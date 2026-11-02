// @vitest-environment jsdom
import type { TodoItemOutput } from "@darkfactory/api";
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

import {
  isOverdue,
  parseTagText,
  sortTodos,
  type TodoEditInput,
  type TodoFields,
  type TodosGateway,
} from "./todos-client.ts";
import { TodosWorkspace } from "./todos-workspace.tsx";

const defaultGateway = vi.hoisted(() => ({
  list: async () => [],
  create: async () => {
    throw new Error("unused");
  },
  update: async () => {
    throw new Error("unused");
  },
  remove: async () => undefined,
}));

vi.mock("./todos-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./todos-client.ts")>()),
  createBrowserTodosGateway: () => defaultGateway,
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
const at = new Date("2026-10-23T10:00:00.000Z");
const todo = (
  id: string,
  overrides: Partial<TodoItemOutput> = {}
): TodoItemOutput => ({
  createdAt: at,
  dueDate: null,
  id,
  note: null,
  sourceUrl: null,
  status: "open",
  tags: [],
  title: id,
  updatedAt: at,
  ...overrides,
});

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  return await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
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

const mount = async (gateway: TodosGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<TodosWorkspace gateway={gateway} today="2026-10-23" />);
    return await flush();
  });
  return container;
};

const memoryGateway = (initial: TodoItemOutput[]) => {
  let rows = [...initial];
  let next = 0;
  const gateway: TodosGateway = {
    create: vi.fn(async (input: TodoFields) => {
      next += 1;
      const row = todo(`new-${next}`, { ...input });
      rows = [...rows, row];
      return row;
    }),
    list: vi.fn(async () => rows),
    remove: vi.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
    }),
    update: vi.fn(async (id: string, input: TodoEditInput) => {
      const row = { ...rows.find((r) => r.id === id)!, ...input };
      rows = rows.map((r) => (r.id === id ? row : r));
      return row;
    }),
  };
  return gateway;
};

const titles = (container: HTMLElement) =>
  [...container.querySelectorAll("li[data-todo-id] p:first-child")].map(
    (node) => node.textContent
  );

describe("todos helpers", () => {
  it("sorts open first, by due date with none last, newest first", () => {
    const older = new Date("2026-10-01T00:00:00.000Z");
    expect(
      sortTodos([
        todo("done", { dueDate: "2026-10-01", status: "done" }),
        todo("none-old", { createdAt: older }),
        todo("none-new"),
        todo("late", { dueDate: "2026-11-01" }),
        todo("soon", { dueDate: "2026-10-24" }),
      ]).map((row) => row.id)
    ).toEqual(["soon", "late", "none-new", "none-old", "done"]);
  });

  it("parses tag text and flags only open overdue rows", () => {
    expect(parseTagText("#Research, broker research")).toEqual([
      "research",
      "broker",
    ]);
    expect(isOverdue(todo("a", { dueDate: "2026-10-22" }), "2026-10-23")).toBe(
      true
    );
    return expect(
      isOverdue(
        todo("a", { dueDate: "2026-10-22", status: "done" }),
        "2026-10-23"
      )
    ).toBe(false);
  });
});

describe("todos workspace", () => {
  it("adds, edits, marks done, filters by tag and deletes", async () => {
    const gateway = memoryGateway([
      todo("Broker check", { dueDate: "2026-10-20", tags: ["broker"] }),
    ]);
    const container = await mount(gateway);
    expect(container.textContent).toContain("Overdue: 2026-10-20");

    await setValue(
      container.querySelector<HTMLInputElement>("#todo-new-title")!,
      "Paper-search API keys"
    );
    await setValue(
      container.querySelector<HTMLInputElement>("#todo-new-tags")!,
      "Research"
    );
    await setValue(
      container.querySelector<HTMLInputElement>("#todo-new-due")!,
      "2026-10-30"
    );
    await clickButton("Add to-do");
    expect(gateway.create).toHaveBeenCalledWith({
      dueDate: "2026-10-30",
      note: null,
      sourceUrl: null,
      tags: ["research"],
      title: "Paper-search API keys",
    });
    expect(titles(container)).toEqual([
      "Broker check",
      "Paper-search API keys",
    ]);

    await clickButton("#research");
    expect(titles(container)).toEqual(["Paper-search API keys"]);
    await clickButton("All");

    await clickButton("Edit: Broker check");
    await setValue(
      container.querySelector<HTMLInputElement>(
        '[id="todo-Broker check-title"]'
      )!,
      "Broker check v2"
    );
    await clickButton("Save");
    expect(titles(container)).toContain("Broker check v2");

    await clickButton("Mark done: Broker check v2");
    expect(gateway.update).toHaveBeenLastCalledWith("Broker check", {
      status: "done",
    });
    expect(titles(container)).toEqual([
      "Paper-search API keys",
      "Broker check v2",
    ]);

    await clickButton("Delete: Broker check v2");
    await clickButton("Confirm delete: Broker check v2");
    expect(gateway.remove).toHaveBeenCalledWith("Broker check");
    return expect(titles(container)).toEqual(["Paper-search API keys"]);
  });

  it("uses the browser gateway and today's date by default", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<TodosWorkspace />);
      return await flush();
    });
    return expect(container.textContent).toContain("No to-dos. Add one above.");
  });

  it("shows notes and source links, saves all fields and reopens a done row", async () => {
    const gateway = memoryGateway([
      todo("Read paper", {
        note: "Section 3",
        sourceUrl: "https://example.test/p",
        status: "done",
        dueDate: "2026-10-01",
      }),
    ]);
    const container = await mount(gateway);
    expect(container.textContent).toContain("Section 3");
    expect(container.textContent).toContain("Due 2026-10-01");
    expect(
      container.querySelector<HTMLAnchorElement>("li a")?.getAttribute("href")
    ).toBe("https://example.test/p");

    await setValue(
      container.querySelector<HTMLInputElement>("#todo-new-title")!,
      "New"
    );
    await setValue(
      container.querySelector<HTMLTextAreaElement>("#todo-new-note")!,
      "body"
    );
    await setValue(
      container.querySelector<HTMLInputElement>("#todo-new-url")!,
      "https://example.test/n"
    );
    await clickButton("Add to-do");
    expect(gateway.create).toHaveBeenLastCalledWith({
      title: "New",
      note: "body",
      dueDate: null,
      tags: [],
      sourceUrl: "https://example.test/n",
    });

    await clickButton("Edit: New");
    await clickButton("Cancel");
    expect(container.querySelector('[id="todo-new-1-title"]')).toBeNull();

    await clickButton("Reopen: Read paper");
    expect(gateway.update).toHaveBeenLastCalledWith("Read paper", {
      status: "open",
    });
    expect(container.textContent).toContain('Reopened "Read paper"');

    await clickButton("Delete: Read paper");
    await clickButton("Keep");
    return expect(gateway.remove).not.toHaveBeenCalled();
  });

  it("requires a title on add and on save", async () => {
    const gateway = memoryGateway([todo("Keep me")]);
    const container = await mount(gateway);
    await clickButton("Add to-do");
    expect(container.textContent).toContain("Enter a title.");
    await clickButton("Edit: Keep me");
    await setValue(
      container.querySelector<HTMLInputElement>('[id="todo-Keep me-title"]')!,
      "  "
    );
    await clickButton("Save");
    expect(gateway.create).not.toHaveBeenCalled();
    return expect(gateway.update).not.toHaveBeenCalled();
  });

  it("reports failures from add, save, toggle and delete", async () => {
    const gateway = memoryGateway([todo("Row")]);
    const failure = Object.assign(new Error("x"), { code: "FORBIDDEN" });
    vi.mocked(gateway.create).mockRejectedValueOnce(failure);
    vi.mocked(gateway.update)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    vi.mocked(gateway.remove).mockRejectedValueOnce(failure);
    const container = await mount(gateway);
    const status = () =>
      container.querySelector('[role="status"]')?.textContent;

    await setValue(
      container.querySelector<HTMLInputElement>("#todo-new-title")!,
      "x"
    );
    await clickButton("Add to-do");
    expect(status()).toBe("Not permitted for this session.");
    await clickButton("Edit: Row");
    await clickButton("Save");
    expect(status()).toBe("Not permitted for this session.");
    await clickButton("Cancel");
    await clickButton("Mark done: Row");
    expect(status()).toBe("Not permitted for this session.");
    await clickButton("Delete: Row");
    await clickButton("Confirm delete: Row");
    expect(status()).toBe("Not permitted for this session.");
    return expect(titles(container)).toEqual(["Row"]);
  });

  it("hides done rows and explains an empty filter", async () => {
    const gateway = memoryGateway([
      todo("Done one", { status: "done", tags: ["old"] }),
      todo("Open one"),
    ]);
    const container = await mount(gateway);
    await clickButton("#old");
    expect(titles(container)).toEqual(["Done one"]);
    const toggle = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    )!;
    await act(async () => {
      toggle.click();
      return await flush();
    });
    expect(container.textContent).toContain("No to-dos match this filter.");
    await clickButton("All");
    return expect(titles(container)).toEqual(["Open one"]);
  });

  it("drops a tag filter once no row carries that tag", async () => {
    const gateway = memoryGateway([
      todo("Tagged", { tags: ["x"] }),
      todo("Plain"),
    ]);
    const container = await mount(gateway);
    await clickButton("#x");
    expect(titles(container)).toEqual(["Tagged"]);
    await clickButton("Delete: Tagged");
    await clickButton("Confirm delete: Tagged");
    return expect(titles(container)).toEqual(["Plain"]);
  });

  it("shows a retry state when loading fails", async () => {
    const gateway = memoryGateway([]);
    vi.mocked(gateway.list).mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "STORAGE_ERROR" })
    );
    const container = await mount(gateway);
    expect(container.textContent).toContain("To-do storage unavailable (503).");
    await clickButton("Retry");
    return expect(container.textContent).toContain("No to-dos. Add one above.");
  });
});
