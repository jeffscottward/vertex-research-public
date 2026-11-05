// @vitest-environment jsdom
import type {
  VertexOrderPreviewOutput,
  VertexOrdersStatus,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePosition } from "./portfolio-monitor-fixture.ts";
import { PositionsPanel } from "./portfolio-monitor-tables.tsx";
import { usePositionActions } from "./position-actions.tsx";
import {
  actionQuantity,
  actionSide,
  actionsUnavailableReason,
  defaultLimit,
  draftFor,
  estimatedAmount,
  parseOptionContract,
  toPositionOrderInput,
} from "./position-actions-model.ts";
import type { VertexOrdersGateway } from "./vertex-orders-client.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Fictional data only. The gateway is a mock: no order reaches a broker.
const call = fixturePosition({
  id: "2001",
  symbol: "MOCKA",
  secType: "OPT",
  description: "MOCKA 20261218 50 C",
  position: 3,
  last: 2,
});
const shortCall = fixturePosition({
  ...call,
  id: "2002",
  position: -2,
});
const shares = fixturePosition();
const odd = fixturePosition({ id: "2003", secType: "OPT", description: "odd" });
const noMark = fixturePosition({ ...call, id: "2004", last: null });
const put = fixturePosition({
  ...call,
  id: "2005",
  description: "MOCKA 20261218 50 P",
});

const gates = (killSwitch = false): VertexOrdersStatus["gates"] => ({
  ordersEnabled: false,
  mode: "simulated",
  killSwitch,
  optionsOnly: true,
});

const preview = (
  order: VertexOrderPreviewOutput["review"]["order"],
  accepted = true
): VertexOrderPreviewOutput => ({
  gates: gates(),
  review: {
    order,
    contractLabel: "MOCKA 20261218 50 call",
    daysToExpiry: 40,
    premium: 570,
    premiumPctNlv: 0.3,
    netLiquidation: 200_000,
    heldContracts: 3,
    cap: {
      kind: "none",
      label: "No cap: closing sale",
      limitPct: 0,
      limitAmount: 0,
      openPremium: 0,
      afterOrder: 0,
      afterOrderPct: 0,
    },
    accepted,
    reasons: accepted ? [] : ["Kill switch is on: no new orders."],
  },
  confirmToken: accepted ? "token-0123456789abcdef" : null,
  expiresAt: accepted ? "2026-11-04T15:02:00.000Z" : null,
});

const gateway = (killSwitch = false, accepted = true) => {
  const g = {
    status: vi.fn(async () => ({
      gates: gates(killSwitch),
      netLiquidation: 200_000,
      openOrders: [],
    })),
    preview: vi.fn(async (order) => preview(order, accepted)),
    submit: vi.fn(async () => ({
      mode: "simulated" as const,
      state: "Submitted",
      orderRef: "leaps-vertex-x",
      permId: 1,
      message: "mock",
    })),
    cancelPreview: vi.fn(),
    cancelSubmit: vi.fn(),
  };
  return g as typeof g & VertexOrdersGateway;
};

const Harness = ({ g }: Readonly<{ g: VertexOrdersGateway }>) => {
  const actions = usePositionActions(g);
  return (
    <>
      <PositionsPanel
        actions={actions?.cell}
        live
        positions={[call, shortCall, shares, odd, noMark, put]}
      />
      {actions?.dialog}
    </>
  );
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const button = (selector: string): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
};
const byText = (text: string): HTMLButtonElement => {
  const el = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text)
  );
  if (el === undefined) throw new Error(`missing button ${text}`);
  return el;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
  await flush();
};

describe("position action model", () => {
  it("parses the server feed form and OCC symbols; refuses puts and other rows", () => {
    // Exact form built by describePosition in packages/api/src/server/portfolio-monitor.ts.
    expect(parseOptionContract(call)).toEqual({
      symbol: "MOCKA",
      expiry: "20261218",
      strike: 50,
      right: "C",
    });
    expect(
      parseOptionContract({ ...call, description: "MOCKA 20261218 52.5 CALL" })
    ).toMatchObject({ strike: 52.5, right: "C" });
    expect(
      parseOptionContract({
        ...call,
        symbol: "",
        description: "MOCKO 270115C00012500",
      })
    ).toEqual({
      symbol: "MOCKO",
      expiry: "20270115",
      strike: 12.5,
      right: "C",
    });
    expect(parseOptionContract(put)).toBeNull();
    expect(
      parseOptionContract({ ...call, description: "MOCKO 270115P00012500" })
    ).toBeNull();
    expect(parseOptionContract(shares)).toBeNull();
    expect(parseOptionContract(odd)).toBeNull();
    expect(actionsUnavailableReason(shares)).toBe("Options only here");
    expect(actionsUnavailableReason(odd)).toBe("Contract not recognized");
    expect(actionsUnavailableReason(put)).toBe(
      "Puts: not supported by the order gateway"
    );
  });

  it("builds close, buy and sell defaults", () => {
    expect(actionSide("close", 3)).toBe("SELL");
    expect(actionSide("close", -2)).toBe("BUY");
    expect(actionSide("buy", 3)).toBe("BUY");
    expect(actionSide("sell", 3)).toBe("SELL");
    expect(actionQuantity("close", -2)).toBe(2);
    expect(actionQuantity("buy", 3)).toBe(1);
    expect(defaultLimit(2, "SELL", false)).toBe(2);
    expect(defaultLimit(2, "SELL", true)).toBe(1.9);
    expect(defaultLimit(2, "BUY", true)).toBe(2.1);
    expect(defaultLimit(0.005, "SELL", true)).toBe(0.01);
    expect(defaultLimit(null, "BUY", false)).toBeNull();
    expect(defaultLimit(0, "BUY", false)).toBeNull();
    const contract = parseOptionContract(call);
    if (contract === null) throw new Error("contract");
    const draft = draftFor(contract, call, "close", true);
    expect(draft).toMatchObject({ side: "SELL", quantity: 3, limitPrice: 1.9 });
    expect(toPositionOrderInput(draft, 3, 1.9)).toEqual({
      symbol: "MOCKA",
      secType: "OPT",
      expiry: "20261218",
      strike: 50,
      right: "C",
      side: "SELL",
      quantity: 3,
      orderType: "LMT",
      limitPrice: 1.9,
    });
    expect(estimatedAmount(3, 1.9)).toBe(570);
  });
});

describe("position action buttons", () => {
  it("adds an Actions column; Close opens a dialog that Cancel closes without sending", async () => {
    const g = gateway();
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    expect(host.querySelector("th:last-child")?.textContent).toBe("Actions");
    expect(host.textContent).toContain("Options only here");
    await click(
      button('[data-position-id="2001"] [data-position-action="close"]')
    );
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Close MOCKA 20261218 50 call");
    expect(dialog?.textContent).toContain("SELL");
    expect(dialog?.textContent).toContain("$570.00");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(byText("Cancel"));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(g.preview).not.toHaveBeenCalled();
    expect(g.submit).not.toHaveBeenCalled();
  });

  it("sends only after review and an explicit confirm", async () => {
    const g = gateway();
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    await click(
      button('[data-position-id="2002"] [data-position-action="close"]')
    );
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("BUY");
    await click(byText("Review order"));
    expect(g.preview).toHaveBeenCalledWith(
      expect.objectContaining({ side: "BUY", quantity: 2, limitPrice: 2.1 })
    );
    expect(g.submit).not.toHaveBeenCalled();
    await click(byText("Confirm: send BUY (simulated)"));
    expect(g.submit).toHaveBeenCalledWith({
      order: expect.objectContaining({ side: "BUY", quantity: 2 }),
      confirmToken: "token-0123456789abcdef",
      confirm: true,
    });
    expect(host.textContent).toContain("Order Submitted (simulated): mock");
    await click(button('[role="dialog"] button'));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("edits quantity, limit and marketable; shows refusals; Escape closes", async () => {
    const g = gateway(false, false);
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    await click(
      button('[data-position-id="2001"] [data-position-action="buy"]')
    );
    const inputs = host.querySelectorAll<HTMLInputElement>(
      '[role="dialog"] input'
    );
    const [qty, limit, marketable] = [...inputs];
    if (qty === undefined || limit === undefined || marketable === undefined)
      throw new Error("inputs missing");
    expect(limit.value).toBe("2");
    await click(marketable);
    expect(limit.value).toBe("2.1");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setter?.call(qty, "0");
      qty.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(byText("Review order").disabled).toBe(true);
    await act(async () => {
      setter?.call(qty, "2");
      qty.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(limit, "3");
      limit.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byText("Review order"));
    expect(g.preview).toHaveBeenCalledWith(
      expect.objectContaining({ side: "BUY", quantity: 2, limitPrice: 3 })
    );
    expect(host.textContent).toContain("Kill switch is on");
    expect(host.textContent).not.toContain("Confirm:");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows a live buy confirm and an empty limit without a mark", async () => {
    const g = gateway();
    g.preview.mockImplementationOnce(async (order) => ({
      ...preview(order),
      gates: { ...gates(), ordersEnabled: true, mode: "live" },
    }));
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    expect(host.textContent).toContain("Contract not recognized");
    await click(
      button('[data-position-id="2004"] [data-position-action="buy"]')
    );
    const limit = host.querySelectorAll<HTMLInputElement>(
      '[role="dialog"] input'
    )[1];
    expect(limit?.value).toBe("");
    expect(host.querySelector("h2")?.textContent).toBe(
      "Buy MOCKA 20261218 50 call"
    );
    expect(byText("Review order").disabled).toBe(true);
    await click(button('[role="dialog"] input[type="checkbox"]'));
    expect(limit?.value).toBe("");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setter?.call(limit, "1.5");
      limit?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byText("Review order"));
    expect(host.textContent).toContain("LIVE IBKR");
    expect(byText("Confirm: send BUY to IBKR")).toBeDefined();
  });

  it("shows a preview error", async () => {
    const g = gateway();
    g.preview.mockRejectedValueOnce(new Error("Rate limit"));
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    await click(
      button('[data-position-id="2001"] [data-position-action="sell"]')
    );
    await click(byText("Review order"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Rate limit"
    );
  });

  it("disables every button when the kill switch is on or the gates are unknown", async () => {
    const g = gateway(true);
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    const buttons = host.querySelectorAll<HTMLButtonElement>(
      "[data-position-action]"
    );
    expect(buttons.length).toBe(9);
    expect(host.textContent).toContain(
      "Puts: not supported by the order gateway"
    );
    for (const b of buttons) expect(b.disabled).toBe(true);
    expect(host.innerHTML).toContain("Kill switch on: no new orders");
    act(() => root.unmount());
    root = createRoot(host);
    const failing = gateway();
    failing.status.mockRejectedValueOnce(new Error("down"));
    await act(async () => root.render(<Harness g={failing} />));
    await flush();
    expect(host.innerHTML).toContain("Order gates unknown");
  });

  it("renders nothing extra without a gateway", async () => {
    const NoGateway = () => {
      const actions = usePositionActions(undefined);
      return <span>{actions === null ? "none" : "some"}</span>;
    };
    await act(async () => root.render(<NoGateway />));
    expect(host.textContent).toBe("none");
  });
});
