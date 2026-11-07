// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import CalendarError from "./error.tsx";
import CalendarLoading from "./loading.tsx";
import CalendarPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/calendar-workspace.tsx", () => ({
  CalendarWorkspace: () => <div data-workspace="calendar" />,
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

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

describe("calendar route files", () => {
  it("renders the client workspace", async () => {
    const container = await render(<CalendarPage />);
    expect(metadata).toEqual({ title: "Calendar" });
    expect(
      container.querySelector('[data-workspace="calendar"]')
    ).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<CalendarLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading calendar"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<CalendarError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Calendar unavailable");
  });
});
