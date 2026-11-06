// @vitest-environment jsdom
import { Gauge as icon } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { labSidebarHref } from "./lab-frame.tsx";
import { LabEntryView, LabIndex } from "./lab-views.tsx";
import { defineLabEntries } from "./registry.ts";
import { mountLab, unmountLab } from "./test-support.tsx";

const entries = defineLabEntries([
  {
    group: "Overview",
    id: "todos",
    render: (params) => (
      <p data-probe="">symbol={params.get("symbol") ?? "none"}</p>
    ),
    route: "/todos",
    title: "Todos",
  },
  {
    group: "Settings",
    id: "settings-profile",
    render: () => <p>profile</p>,
    title: "Profile",
  },
]);

afterEach(unmountLab);

describe("LabIndex", () => {
  it("lists every entry by group in the dark frame", async () => {
    const host = await mountLab(<LabIndex entries={entries} search="" />);
    expect(host.querySelector("h1")?.textContent).toBe("UI lab");
    expect(
      [...host.querySelectorAll("[data-lab-group]")].map((group) =>
        group.getAttribute("data-lab-group")
      )
    ).toEqual(["Overview", "Settings"]);
    expect(
      host.querySelector('[data-lab-entry="todos"]')?.getAttribute("href")
    ).toBe("/lab/todos");
    expect(host.textContent).toContain("settings-profile");
    expect(
      host.querySelector("[data-lab-frame]")?.getAttribute("data-theme")
    ).toBe("default-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "default-dark"
    );
    expect(host.textContent).toContain("Demo data");
    expect(host.querySelector("[data-lab-count]")?.textContent).toContain(
      "2 portal pages"
    );
  });

  it("keeps the light theme on entry links and offers dark", async () => {
    document.documentElement.setAttribute("data-theme", "system");
    const host = await mountLab(
      <LabIndex entries={entries} search="theme=light" />
    );
    expect(
      host.querySelector('[data-lab-entry="todos"]')?.getAttribute("href")
    ).toBe("/lab/todos?theme=light");
    const toggle = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Dark"
    );
    expect(toggle?.getAttribute("href")).toBe("/lab?theme=dark");
    await unmountLab();
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
  });

  it("uses the real registry by default", async () => {
    const host = await mountLab(<LabIndex search="" />);
    expect(host.querySelector('[data-lab-entry="charts"]')).not.toBeNull();
  });
});

describe("LabEntryView", () => {
  it("renders the entry with its query params and marks the sidebar route", async () => {
    document.documentElement.removeAttribute("data-theme");
    const host = await mountLab(
      <LabEntryView entries={entries} id="todos" search="symbol=NVDA" />
    );
    expect(host.querySelector("[data-probe]")?.textContent).toBe("symbol=NVDA");
    expect(
      host.querySelector('[data-slot="portal-page-title"]')?.textContent
    ).toBe("Todos");
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Todos"
    );
    const toggle = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Light"
    );
    expect(toggle?.getAttribute("href")).toBe(
      "/lab/todos?symbol=NVDA&theme=light"
    );
    await unmountLab();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("shows a plain message for an unknown entry", async () => {
    const host = await mountLab(
      <LabEntryView entries={entries} id="nope" search="theme=light" />
    );
    expect(host.textContent).toContain("Unknown lab entry");
    expect(
      host.querySelector("[data-lab-frame]")?.getAttribute("data-theme")
    ).toBe("default-light");
  });

  it("uses the real registry by default", async () => {
    const host = await mountLab(<LabEntryView id="nope" search="" />);
    expect(host.textContent).toContain("Unknown lab entry");
  });
});

describe("labSidebarHref", () => {
  it("links sidebar items to lab entries only", () => {
    expect(labSidebarHref(entries, { href: "/todos", icon, label: "T" })).toBe(
      "/lab/todos"
    );
    expect(
      labSidebarHref(entries, { href: "/charts", icon, label: "C" })
    ).toBeNull();
  });
});
