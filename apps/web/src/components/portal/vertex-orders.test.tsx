// @vitest-environment jsdom
import type {
  ApiClient,
  VertexOrderPreviewOutput,
  VertexOrdersStatus,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ client: null as ApiClient | null }));
vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn(() => runtime.client),
}));

import { toOrderInput, VertexOrders } from "./vertex-orders.tsx";
import {
  createBrowserVertexOrdersGateway,
  orderErrorMessage,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Fictional mock data only.
const gates: VertexOrderPreviewOutput["gates"] = {
  ordersEnabled: false,
  mode: "simulated",
  killSwitch: false,
  optionsOnly: true,
};
const option = {
  permId: 11,
  symbol: "MOCKB",
  secType: "OPT",
  expiry: "20261218",
  strike: 50,
  right: "C",
  side: "BUY",
  quantity: 1,
  orderType: "LMT",
  limitPrice: 2.5,
  status: "Submitted",
  orderRef: "mock-seed",
  cancellable: true,
};
const status = (
  over: Partial<VertexOrdersStatus> = {}
): VertexOrdersStatus => ({
  gates,
  netLiquidation: 200_000,
  openOrders: [
    option,
    {
      ...option,
      permId: 12,
      secType: "STK",
      limitPrice: null,
      cancellable: false,
    },
  ],
  ...over,
});
const order = toOrderInput({
  symbol: " mockd ",
  expiry: "2028-01-21",
  strike: "100",
  right: "C",
  side: "BUY",
  quantity: "2",
  limitPrice: "10",
});
const review = (
  accepted: boolean,
  pct: number | null = 1
): VertexOrderPreviewOutput => ({
  gates,
  review: {
    order,
    contractLabel: "MOCKD 20280121 100 call",
    daysToExpiry: 456,
    premium: 2000,
    premiumPctNlv: pct,
    netLiquidation: 200_000,
    heldContracts: 0,
    cap: {
      kind: "leaps",
      label: "LEAPS cap 6% NLV per name",
      limitPct: 6,
      limitAmount: 12_000,
      openPremium: 0,
      afterOrder: 2000,
      afterOrderPct: 1,
    },
    accepted,
    reasons: accepted ? [] : ["Premium cap: too much"],
  },
  confirmToken: accepted ? "token-1234567890abcdef" : null,
  expiresAt: accepted ? "2026-10-22T15:02:00.000Z" : null,
});

let root: Root;
let host: HTMLDivElement;
const gateway = () =>
  ({
    status: vi.fn(async () => status()),
    preview: vi.fn(async () => review(true)),
    submit: vi.fn(async () => ({
      mode: "simulated" as const,
      state: "submitted",
      orderRef: "vertex-1",
      permId: 9,
      message: "Simulated",
    })),
    cancelPreview: vi.fn(async () => ({
      gates,
      order: option,
      confirmToken: "token-cancel-1234567",
      expiresAt: "x",
    })),
    cancelSubmit: vi.fn(async () => ({
      mode: "simulated" as const,
      state: "cancelled",
      orderRef: "mock-seed",
      permId: 11,
      message: "Simulated",
    })),
    comboPreview: vi.fn(),
    comboSubmit: vi.fn(),
  }) satisfies Record<keyof VertexOrdersGateway, unknown>;

const render = async (g: ReturnType<typeof gateway>) => {
  await act(async () =>
    root.render(<VertexOrders gateway={g as unknown as VertexOrdersGateway} />)
  );
};
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text)
  ) as HTMLButtonElement;
const click = async (text: string) => {
  await act(async () => button(text).click());
};
const type = async (id: string, value: string) => {
  const input = host.querySelector(`#${id}`) as
    | HTMLInputElement
    | HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value"
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(
      new Event(input.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      })
    );
  });
};
const fillAndReview = async () => {
  await type("order-symbol", "mockd");
  await type("order-expiry", "2028-01-21");
  await type("order-strike", "100");
  await type("order-side", "BUY");
  await type("order-quantity", "2");
  await type("order-limitPrice", "10");
  await act(async () =>
    (host.querySelector("form") as HTMLFormElement).requestSubmit()
  );
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("VertexOrders screen", () => {
  it("shows the disabled banner and needs a review step before Send order", async () => {
    const g = gateway();
    await render(g);
    expect(host.textContent).toContain("Orders disabled");
    expect(host.textContent).toContain("Not cancellable here");
    expect(button("Send order")).toBeUndefined();
    await fillAndReview();
    expect(g.preview).toHaveBeenCalledWith(order);
    expect(host.textContent).toContain("Passes all order rules");
    expect(host.textContent).toContain("LEAPS cap 6% NLV per name");
    expect(g.submit).not.toHaveBeenCalled();
    await click("Send order (simulated)");
    expect(g.submit).toHaveBeenCalledWith({
      order,
      confirmToken: "token-1234567890abcdef",
      confirm: true,
    });
    expect(host.textContent).toContain("Order submitted (simulated)");
  });

  it("shows rule reasons and no send button for a rejected order; Back returns to the form", async () => {
    const g = gateway();
    g.preview.mockResolvedValueOnce(review(false, null));
    await render(g);
    await fillAndReview();
    expect(host.textContent).toContain("Premium cap: too much");
    expect(host.textContent).toContain("unknown");
    expect(button("Send order")).toBeUndefined();
    await click("Back");
    expect(host.querySelector("form")).not.toBeNull();
  });

  it("cancels one order after a separate confirm", async () => {
    const g = gateway();
    await render(g);
    await click("Cancel…");
    expect(g.cancelPreview).toHaveBeenCalledWith({ permId: 11 });
    expect(g.cancelSubmit).not.toHaveBeenCalled();
    await click("Back");
    expect(host.textContent).not.toContain("Review cancel");
    await click("Cancel…");
    await click("Send cancel (simulated)");
    expect(g.cancelSubmit).toHaveBeenCalledWith({
      permId: 11,
      confirmToken: "token-cancel-1234567",
      confirm: true,
    });
    expect(host.textContent).toContain("Cancel cancelled (simulated)");
  });

  it("shows live mode, the kill switch, empty lists and server errors", async () => {
    const g = gateway();
    const live = {
      ...gates,
      ordersEnabled: true,
      mode: "live" as const,
      killSwitch: true,
    };
    g.status.mockResolvedValue(
      status({ gates: live, openOrders: [], netLiquidation: null })
    );
    g.preview.mockResolvedValueOnce({ ...review(true), gates: live });
    g.submit.mockRejectedValueOnce(new Error("Kill switch is on"));
    await render(g);
    // Live mode (owner approval 2026-11-05): puts and the vertical ticket are offered here too.
    expect(host.querySelector("#order-right")).not.toBeNull();
    expect(host.textContent).toContain("Vertical spread · defined risk");
    g.cancelPreview.mockResolvedValueOnce({
      gates: live,
      order: option,
      confirmToken: "t".repeat(20),
      expiresAt: "x",
    });
    await render(g);
    expect(host.textContent).toContain("Live orders: IBKR");
    expect(host.textContent).toContain("Kill switch on");
    expect(host.textContent).toContain("No open orders.");
    expect(host.textContent).toContain("Net liquidation unknown");
    await fillAndReview();
    await click("Send order to IBKR");
    expect(host.textContent).toContain("Kill switch is on");
    g.status.mockResolvedValue(status({ gates: live }));
    await render(gateway());
    const g2 = gateway();
    g2.status.mockResolvedValue(status({ gates: live }));
    g2.cancelPreview.mockResolvedValueOnce({
      gates: live,
      order: option,
      confirmToken: "t".repeat(20),
      expiresAt: "x",
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(g2);
    await click("Cancel…");
    expect(button("Send cancel to IBKR")).toBeDefined();
  });

  it("shows a status load failure", async () => {
    const g = gateway();
    g.status.mockRejectedValueOnce({ message: "Forbidden" });
    await render(g);
    expect(host.textContent).toContain("Forbidden");
  });
});

describe("vertex orders client", () => {
  it("creates one API client lazily and forwards each call", async () => {
    const calls: string[] = [];
    const forward = (name: string) => async () => {
      calls.push(name);
      return name;
    };
    runtime.client = {
      vertexOrders: {
        status: forward("status"),
        preview: forward("preview"),
        submit: forward("submit"),
        cancelPreview: forward("cancelPreview"),
        cancelSubmit: forward("cancelSubmit"),
        comboPreview: forward("comboPreview"),
        comboSubmit: forward("comboSubmit"),
      },
    } as unknown as ApiClient;
    const g = createBrowserVertexOrdersGateway();
    await g.status({});
    await g.preview(order);
    await g.submit({ order, confirmToken: "x".repeat(20), confirm: true });
    await g.cancelPreview({ permId: 1 });
    await g.cancelSubmit({
      permId: 1,
      confirmToken: "x".repeat(20),
      confirm: true,
    });
    const combo = {
      symbol: "MOCKS",
      quantity: 1,
      limitPrice: -1,
      legs: [
        {
          expiry: "20280121",
          strike: 100,
          right: "C" as const,
          side: "SELL" as const,
          ratio: 1,
        },
        {
          expiry: "20280121",
          strike: 120,
          right: "C" as const,
          side: "BUY" as const,
          ratio: 1,
        },
      ],
    };
    await g.comboPreview(combo);
    await g.comboSubmit({
      order: combo,
      confirmToken: "x".repeat(20),
      confirm: true,
    });
    expect(calls).toEqual([
      "status",
      "preview",
      "submit",
      "cancelPreview",
      "cancelSubmit",
      "comboPreview",
      "comboSubmit",
    ]);
  });

  it("reads the server message or falls back", () => {
    expect(orderErrorMessage({ message: "Rate limited" })).toBe("Rate limited");
    expect(orderErrorMessage({ message: " " })).toBe("Request failed");
    expect(orderErrorMessage(null)).toBe("Request failed");
  });

  it("paper mode offers puts and the vertical ticket, and shows the final gate", async () => {
    const g = gateway();
    g.preview.mockResolvedValueOnce({
      ...review(true),
      review: {
        ...review(true).review,
        finalGate: {
          decision: "allow",
          jevStance: "NEUTRAL",
          jevState: "fresh",
          maxLoss: 2000,
          maxLossPct: 1,
          reasons: [],
          structure: "long-option",
        },
      },
    });
    await render(g);
    expect(host.textContent).toContain("Vertical spread · defined risk");
    await type("order-right", "P");
    await fillAndReview();
    expect(g.preview).toHaveBeenCalledWith({ ...order, right: "P" });
    expect(host.textContent).toContain("Final JEV gate");
    expect(host.textContent).toContain("Long option");
  });
});
