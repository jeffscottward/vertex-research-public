// @vitest-environment jsdom
import {
  OWNER_RISK_CAPS,
  RiskAllocatorInputSchema,
  suggestAllocation,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createBrowserRiskAllocatorGateway,
  createRiskAllocatorGateway,
  type RiskAllocatorGateway,
} from "./risk-allocator-client.ts";
import {
  invalidAmountFields,
  parseAmount,
  type RiskAllocatorForm,
  RiskAllocatorWorkspace,
  toAllocatorInput,
} from "./risk-allocator-workspace.tsx";

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

const localGateway = (): RiskAllocatorGateway => ({
  caps: async () => OWNER_RISK_CAPS,
  suggest: async (input) =>
    suggestAllocation(RiskAllocatorInputSchema.parse(input)),
});

const render = async (gateway: RiskAllocatorGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <RiskAllocatorWorkspace gateway={gateway} initialAsOf="2026-10-22" />
    )
  );
  return container;
};

const setValue = async (container: HTMLElement, id: string, value: string) => {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `#${id}`
  );
  if (element === null) throw new Error(`missing ${id}`);
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const submit = async (container: HTMLElement) =>
  act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );

const baseForm: RiskAllocatorForm = {
  asOf: "2026-10-22",
  copyNameExposure: "",
  copyTotalExposure: "",
  crownCopy: false,
  expiry: "2027-12-17",
  kind: "option",
  nlv: "1,000,000",
  openPremium: "",
  symbol: " msft ",
  unitCost: "5000",
};

describe("toAllocatorInput", () => {
  it("maps the form and adds open premium and copy exposure as positions", () => {
    expect(toAllocatorInput(baseForm)).toMatchObject({
      candidates: [{ crownCopy: false, expiry: "2027-12-17", symbol: "MSFT" }],
      nlv: 1_000_000,
      positions: [],
    });
    const copy = toAllocatorInput({
      ...baseForm,
      copyNameExposure: "40000",
      copyTotalExposure: "100000",
      crownCopy: true,
      kind: "share",
      openPremium: "",
      symbol: "OTHER",
    });
    expect(copy.candidates[0]?.expiry).toBeNull();
    expect(copy.positions).toEqual([
      { crownCopy: true, kind: "share", symbol: "OTHER", value: 40_000 },
      { crownCopy: true, kind: "share", symbol: "OTHRS", value: 60_000 },
    ]);
    expect(
      toAllocatorInput({ ...baseForm, expiry: "", openPremium: "3000" })
    ).toMatchObject({
      candidates: [{ expiry: null }],
      positions: [{ kind: "option", value: 3000 }],
    });
    // The submit handler rejects unparseable text first; this mapping alone treats it as 0.
    expect(
      toAllocatorInput({ ...baseForm, openPremium: "abc" }).positions
    ).toEqual([]);
  });
});

describe("amount validation", () => {
  it("parses plain and comma-grouped amounts and rejects the rest", () => {
    expect(parseAmount("  ")).toBe(0);
    expect(parseAmount("1,500.25")).toBe(1500.25);
    expect(parseAmount(".5")).toBe(0.5);
    for (const bad of ["$1,500", "1.5k", "abc", "-200", "1,5", "1e3", "."])
      expect(parseAmount(bad)).toBeNull();
    expect(parseAmount("9".repeat(400))).toBeNull();
  });

  it("names every unparseable field, copy fields only for a copy leg", () => {
    const bad = {
      ...baseForm,
      copyNameExposure: "x",
      copyTotalExposure: "y",
      kind: "share" as const,
      nlv: "-1",
      openPremium: "abc",
      unitCost: "1.5k",
    };
    expect(invalidAmountFields(bad)).toEqual([
      "Price per share (USD)",
      "Net liquidation value (USD)",
      "Option premium already open in this name",
    ]);
    expect(invalidAmountFields({ ...bad, crownCopy: true })).toHaveLength(5);
    expect(invalidAmountFields(baseForm)).toEqual([]);
  });

  it("shows an error and sends nothing for an unparseable exposure", async () => {
    const suggest = vi.fn<RiskAllocatorGateway["suggest"]>();
    const container = await render({
      caps: async () => OWNER_RISK_CAPS,
      suggest,
    });
    await setValue(container, "risk-openPremium", "$1,500");
    await submit(container);
    expect(suggest).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Enter a number of 0 or more (commas allowed) for: Option premium already open in this name."
    );
  });
});

describe("RiskAllocatorWorkspace", () => {
  it("shows the caps and a LEAPS option size under the options-only rule set", async () => {
    const container = await render(localGateway());
    expect(container.textContent).toContain("Owner risk caps");
    expect(container.textContent).toContain("2% NLV for LEAPS");
    expect(
      container.querySelector('[data-testid="leaps-pending"]')?.textContent
    ).toContain("Pending: 6% NLV for LEAPS");
    await setValue(container, "risk-symbol", "msft");
    await setValue(container, "risk-expiry", "2027-12-17");
    await setValue(container, "risk-unitCost", "5000");
    await setValue(container, "risk-nlv", "1000000");
    await submit(container);
    expect(container.querySelector("[data-rule-set]")?.textContent).toContain(
      "Options only"
    );
    expect(container.textContent).toContain("LEAPS");
    expect(
      container.querySelector('[data-testid="max-units"]')?.textContent
    ).toContain("Max 4 contracts");
    expect(container.textContent).toContain("(binding)");
  });

  it("never sizes shares for a non-Crown name", async () => {
    const container = await render(localGateway());
    await setValue(container, "risk-kind", "share");
    expect(container.querySelector("#risk-expiry")).toBeNull();
    await setValue(container, "risk-symbol", "AAPL");
    await setValue(container, "risk-unitCost", "200");
    await setValue(container, "risk-nlv", "1000000");
    await submit(container);
    expect(
      container.querySelector('[data-testid="max-units"]')?.textContent
    ).toContain("Max 0 shares");
    expect(container.textContent).toContain("Options only:");
    expect(container.querySelector("table")).toBeNull();
  });

  it("uses the copy-book caps for a Crown copy leg", async () => {
    const container = await render(localGateway());
    await setValue(container, "risk-kind", "share");
    await act(async () =>
      container.querySelector<HTMLInputElement>("#risk-crownCopy")?.click()
    );
    await setValue(container, "risk-symbol", "XOM");
    await setValue(container, "risk-unitCost", "100");
    await setValue(container, "risk-nlv", "1000000");
    await setValue(container, "risk-copyNameExposure", "60000");
    await setValue(container, "risk-copyTotalExposure", "100000");
    await submit(container);
    expect(container.querySelector("[data-rule-set]")?.textContent).toContain(
      "Crown copy book"
    );
    expect(container.textContent).toContain("Max 400 shares");
    await setValue(container, "risk-kind", "option");
    expect(container.querySelector("#risk-expiry")).not.toBeNull();
  });

  it("reports caps and suggestion failures", async () => {
    const forbidden = Object.assign(new Error("no"), { code: "FORBIDDEN" });
    const container = await render({
      caps: () => Promise.reject(forbidden),
      suggest: () => Promise.reject(new Error("  ")),
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Operator access required."
    );
    await submit(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Request failed."
    );
    const other = await render({
      caps: async () => OWNER_RISK_CAPS,
      suggest: () => Promise.reject(new Error(" Bad input ")),
    });
    await submit(other);
    expect(other.querySelector('[role="alert"]')?.textContent).toBe(
      "Bad input"
    );
  });

  it("ignores a caps result that arrives after unmount", async () => {
    let resolve: (value: typeof OWNER_RISK_CAPS) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const late = await render({
      caps: () =>
        new Promise((ok) => {
          resolve = ok;
        }),
      suggest: vi.fn(),
    });
    const lateFail = await render({
      caps: () =>
        new Promise((_ok, fail) => {
          reject = fail;
        }),
      suggest: vi.fn(),
    });
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      resolve(OWNER_RISK_CAPS);
      reject(new Error("late"));
    });
    expect(late.textContent).toBe("");
    expect(lateFail.textContent).toBe("");
  });
});

describe("RiskAllocatorWorkspace defaults", () => {
  it("uses the browser gateway and today's date when no props are given", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<RiskAllocatorWorkspace />));
    expect(container.querySelector<HTMLInputElement>("#risk-asOf")?.value).toBe(
      new Date().toLocaleDateString("en-CA")
    );
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("omits the options-only sentence when the caps say so", async () => {
    const container = await render({
      ...localGateway(),
      caps: async () => ({
        ...OWNER_RISK_CAPS,
        leapsPremiumPending: null,
        optionsOnly: false,
      }),
    });
    expect(container.textContent).not.toContain("Options only. ");
    expect(container.querySelector('[data-testid="leaps-pending"]')).toBeNull();
  });
});

describe("risk allocator gateway", () => {
  it("calls the riskAllocator procedures", async () => {
    const caps = vi.fn(async () => OWNER_RISK_CAPS);
    const suggest = vi.fn(async () => ({
      advisoryOnly: true as const,
      rows: [],
    }));
    const client = {
      riskAllocator: { caps, suggest },
    } as unknown as Parameters<typeof createRiskAllocatorGateway>[0];
    const gateway = createRiskAllocatorGateway(client);
    await gateway.caps();
    const input = toAllocatorInput(baseForm);
    await gateway.suggest(input);
    expect(caps).toHaveBeenCalledWith({});
    expect(suggest).toHaveBeenCalledWith(input);
  });

  it("builds a browser client lazily against the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const gateway = createBrowserRiskAllocatorGateway();
    await expect(gateway.caps()).rejects.toBeDefined();
    await expect(
      gateway.suggest(toAllocatorInput(baseForm))
    ).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
