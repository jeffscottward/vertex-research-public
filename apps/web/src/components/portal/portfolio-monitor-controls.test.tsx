// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { TabPanel, TabStrip } from "./portfolio-monitor-controls.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const TABS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const Harness = () => {
  const [value, setValue] = useState<TabId>("one");
  return (
    <>
      <TabStrip
        idPrefix="t"
        label="Test sections"
        onChange={setValue}
        tabs={TABS}
        value={value}
      />
      <TabPanel id={value} idPrefix="t">
        {value}
      </TabPanel>
    </>
  );
};

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const tab = (label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("[role=tab]"),
  ].find((node) => node.textContent === label);
  if (found === undefined) throw new Error(`Missing tab ${label}`);
  return found;
};

describe("TabStrip", () =>
  it("moves between tabs with clicks and the keyboard", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<Harness />));
    const list = document.querySelector("[aria-label='Test sections']");
    if (list === null) throw new Error("Missing tablist");
    const key = (name: string) =>
      act(async () => {
        list.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: name })
        );
      });
    const selected = () =>
      document.querySelector("[aria-selected=true]")?.textContent;
    await key("ArrowLeft");
    expect(selected()).toBe("Three");
    expect(document.activeElement).toBe(tab("Three"));
    await key("ArrowRight");
    expect(selected()).toBe("One");
    await key("ArrowRight");
    expect(selected()).toBe("Two");
    await key("ArrowLeft");
    expect(selected()).toBe("One");
    await key("End");
    expect(selected()).toBe("Three");
    await key("Home");
    expect(selected()).toBe("One");
    await key("a");
    expect(selected()).toBe("One");
    expect(tab("One").tabIndex).toBe(0);
    expect(tab("Two").tabIndex).toBe(-1);
    await act(async () => tab("Two").click());
    expect(selected()).toBe("Two");
    return expect(document.querySelector("[role=tabpanel]")?.textContent).toBe(
      "two"
    );
  }));
