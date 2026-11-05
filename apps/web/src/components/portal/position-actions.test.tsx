// @vitest-environment jsdom
import type {
  VertexComboInput,
  VertexComboPreviewOutput,
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
  comboDraft,
  comboLimit,
  defaultLimit,
  draftFor,
  estimatedAmount,
  parseOptionContract,
  shareContract,
  spreadGroup,
  toComboInput,
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
  symbol: "MOCKB",
  description: "MOCKB 20261218 50 C",
  position: -2,
});
const shares = fixturePosition();
const odd = fixturePosition({ id: "2003", secType: "OPT", description: "odd" });
const noMark = fixturePosition({
  ...call,
  id: "2004",
  symbol: "MOCKC",
  description: "MOCKC 20261218 50 C",
  last: null,
});
const put = fixturePosition({
  ...call,
  id: "2005",
  symbol: "MOCKD",
  description: "MOCKD 20261218 50 P",
});
// A vertical spread (long 50 call, short 60 call) closes as one combo.
const spreadLong = fixturePosition({
  ...call,
  id: "2006",
  symbol: "MOCKS",
  description: "MOCKS 20261218 50 C",
  position: 2,
  last: 3,
});
const spreadShort = fixturePosition({
  ...call,
  id: "2007",
  symbol: "MOCKS",
  description: "MOCKS 20261218 60 C",
  position: -2,
  last: 1,
});
// A spread with a leg that cannot be parsed gets no buttons at all.
const brokenLong = fixturePosition({
  ...call,
  id: "2008",
  symbol: "MOCKU",
  description: "MOCKU 20261218 50 C",
});
const brokenShort = fixturePosition({
  ...call,
  id: "2009",
  symbol: "MOCKU",
  description: "weird",
  position: -1,
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
    comboPreview: vi.fn(
      async (order: VertexComboInput): Promise<VertexComboPreviewOutput> => ({
        gates: gates(),
        review: {
          order,
          label: "MOCKS combo",
          netAmount: order.limitPrice * order.quantity * 100,
          accepted,
          reasons: accepted ? [] : ["Leg does not close the held 0 exactly."],
        },
        confirmToken: accepted ? "token-combo-0123456789" : null,
        expiresAt: accepted ? "2026-11-04T15:02:00.000Z" : null,
      })
    ),
    comboSubmit: vi.fn(async () => ({
      mode: "simulated" as const,
      state: "submitted",
      orderRef: "vertex-c",
      permId: 2,
      message: "combo mock",
    })),
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
        positions={[
          call,
          shortCall,
          shares,
          odd,
          noMark,
          put,
          spreadLong,
          spreadShort,
          brokenLong,
          brokenShort,
        ]}
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
  it("parses the server feed form and OCC symbols; refuses other rows", () => {
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
    expect(parseOptionContract(put)).toMatchObject({ right: "P" });
    expect(
      parseOptionContract({ ...call, description: "MOCKO 270115P00012500" })
    ).toMatchObject({ right: "P", strike: 12.5 });
    expect(parseOptionContract(shares)).toBeNull();
    expect(parseOptionContract(odd)).toBeNull();
    expect(actionsUnavailableReason({ secType: "FUT" })).toBe(
      "Not supported here (FUT)"
    );
    expect(actionsUnavailableReason({ secType: " " })).toBe(
      "Not supported here (unknown)"
    );
    expect(shareContract(shares)).toEqual({
      symbol: "ALPHA",
      expiry: "",
      strike: 0,
      right: "",
    });
    expect(shareContract(call)).toBeNull();
    // Structured IBKR fields win over an unrecognized description.
    expect(
      parseOptionContract({
        ...odd,
        symbol: "SOXX",
        option: { expiry: "20261120", strike: 240, right: "P" },
      })
    ).toEqual({ symbol: "SOXX", expiry: "20261120", strike: 240, right: "P" });
    expect(
      parseOptionContract({
        ...odd,
        option: { expiry: "", strike: 240, right: "P" },
      })
    ).toBeNull();
    expect(estimatedAmount(10, 9.5, 1)).toBe(95);
    expect(actionsUnavailableReason(odd)).toBe("Contract not recognized");
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

describe("spread (combo) model", () => {
  it("groups spread legs and builds a full close", () => {
    const all = [call, spreadLong, spreadShort, brokenLong, brokenShort];
    expect(spreadGroup(call, all)).toBeNull();
    expect(spreadGroup(brokenLong, all)).toBe("unparsed");
    const group = spreadGroup(spreadShort, all);
    if (group === null || group === "unparsed") throw new Error("group");
    expect(group.map((p) => p.id)).toEqual(["2006", "2007"]);
    const ratio = comboDraft(
      "MOCKS",
      [
        { ...spreadLong, position: 4 },
        { ...spreadShort, position: -2 },
      ],
      false
    );
    expect(ratio).toMatchObject({
      symbol: "MOCKS",
      quantity: 2,
      limitPrice: -5,
    });
    expect(ratio.legs.map((leg) => [leg.side, leg.ratio])).toEqual([
      ["SELL", 2],
      ["BUY", 1],
    ]);
    expect(comboLimit(ratio.legs, true)).toBe(-4.75);
    expect(
      comboLimit(
        [{ ...ratio.legs[0], mark: null } as (typeof ratio.legs)[0]],
        false
      )
    ).toBeNull();
    expect(toComboInput(ratio, -4.75)).toEqual({
      symbol: "MOCKS",
      quantity: 2,
      limitPrice: -4.75,
      legs: [
        { expiry: "20261218", strike: 50, right: "C", side: "SELL", ratio: 2 },
        { expiry: "20261218", strike: 60, right: "C", side: "BUY", ratio: 1 },
      ],
    });
  });
});

describe("spread close dialog", () => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  const type = async (input: HTMLInputElement | undefined, value: string) => {
    await act(async () => {
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("spread rows: Buy/Sell disabled, Close sends ONE combo after review and confirm", async () => {
    const g = gateway();
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    expect(
      button('[data-position-id="2006"] [data-position-action="sell"]').disabled
    ).toBe(true);
    expect(
      button('[data-position-id="2007"] [data-position-action="buy"]').title
    ).toBe("Part of a spread: use Close (one combo order)");
    expect(
      host.querySelector('[data-position-id="2009"]')?.textContent
    ).toContain("Contract not recognized");
    await click(
      button('[data-position-id="2007"] [data-position-action="close"]')
    );
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe(
      "Close MOCKS spread (one combo order)"
    );
    expect(dialog?.textContent).toContain("20261218 60 call");
    // Marketable by default: net -2.00 at the marks -> -1.90 credit per combo, x2 combos.
    expect(dialog?.textContent).toContain("Estimated net credit: $380.00");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(byText("Review order"));
    expect(g.comboPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "MOCKS",
        quantity: 2,
        limitPrice: -1.9,
      })
    );
    expect(g.comboSubmit).not.toHaveBeenCalled();
    await click(byText("Confirm: send combo (simulated)"));
    expect(g.comboSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmToken: "token-combo-0123456789",
        confirm: true,
      })
    );
    expect(host.textContent).toContain(
      "Order submitted (simulated): combo mock"
    );
    await click(button('[role="dialog"] button'));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("edits the net limit, shows refusals, errors and live mode; Escape closes", async () => {
    const g = gateway(false, false);
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    await click(
      button('[data-position-id="2006"] [data-position-action="close"]')
    );
    const inputs = host.querySelectorAll<HTMLInputElement>(
      '[role="dialog"] input'
    );
    const [limit, marketable] = [...inputs];
    await click(marketable as HTMLInputElement);
    expect(limit?.value).toBe("-2");
    await type(limit, "");
    expect(host.textContent).toContain("Enter a net limit.");
    expect(byText("Review order").disabled).toBe(true);
    await type(limit, "0.5");
    expect(host.textContent).toContain("Estimated net debit: $100.00");
    await click(byText("Review order"));
    expect(host.textContent).toContain("does not close the held 0 exactly");
    expect(host.textContent).not.toContain("Confirm:");
    g.comboPreview.mockRejectedValueOnce(new Error("Rate limit"));
    await type(limit, "0.6");
    await click(byText("Review order"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Rate limit"
    );
    g.comboPreview.mockImplementationOnce(async (order) => ({
      gates: { ...gates(), ordersEnabled: true, mode: "live" },
      review: { order, label: "x", netAmount: 1, accepted: true, reasons: [] },
      confirmToken: "token-combo-live-0123",
      expiresAt: "x",
    }));
    await click(byText("Review order"));
    expect(host.textContent).toContain("LIVE IBKR");
    expect(byText("Confirm: send combo to IBKR")).toBeDefined();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a spread with a missing mark starts with an empty limit", async () => {
    const g = gateway();
    const NoMark = () => {
      const actions = usePositionActions(g);
      return (
        <>
          <PositionsPanel
            actions={actions?.cell}
            live
            positions={[
              spreadLong,
              {
                ...spreadShort,
                last: null,
                description: "MOCKS 20261218 60 P",
              },
            ]}
          />
          {actions?.dialog}
        </>
      );
    };
    await act(async () => root.render(<NoMark />));
    await flush();
    await click(
      button('[data-position-id="2006"] [data-position-action="close"]')
    );
    const [limit, marketable] = [
      ...host.querySelectorAll<HTMLInputElement>('[role="dialog"] input'),
    ];
    expect(limit?.value).toBe("");
    expect(host.textContent).toContain("20261218 60 put");
    await click(marketable as HTMLInputElement);
    expect(limit?.value).toBe("");
    await click(button('[role="dialog"] button'));
    // A single put opens the single-order dialog.
  });

  it("a share row has a Close that sends a share close after review", async () => {
    const g = gateway();
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    expect(
      host.querySelectorAll('[data-position-id="1001"] [data-position-action]')
    ).toHaveLength(1);
    await click(
      button('[data-position-id="1001"] [data-position-action="close"]')
    );
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("Close ALPHA shares");
    expect(dialog?.textContent).toContain("Held shares");
    // 100 shares, mark 60, marketable 1% -> 59.40 x 100 = $5,940.00.
    expect(dialog?.textContent).toContain("$5,940.00");
    const [, , marketable] = [
      ...host.querySelectorAll<HTMLInputElement>('[role="dialog"] input'),
    ];
    await click(marketable as HTMLInputElement);
    await click(marketable as HTMLInputElement);
    await click(byText("Review order"));
    expect(g.preview).toHaveBeenCalledWith({
      symbol: "ALPHA",
      secType: "STK",
      expiry: "",
      strike: 0,
      right: "",
      side: "SELL",
      quantity: 100,
      orderType: "LMT",
      limitPrice: 59.4,
    });
  });

  it("a single put row opens the order dialog", async () => {
    const g = gateway();
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    await click(
      button('[data-position-id="2005"] [data-position-action="close"]')
    );
    expect(host.querySelector('[role="dialog"] h2')?.textContent).toBe(
      "Close MOCKD 20261218 50 put"
    );
  });
});

describe("position action buttons", () => {
  it("adds an Actions column; Close opens a dialog that Cancel closes without sending", async () => {
    const g = gateway();
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    expect(host.querySelector("th:last-child")?.textContent).toBe("Actions");
    expect(
      button('[data-position-id="1001"] [data-position-action="close"]')
    ).toBeDefined();
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
      "Buy MOCKC 20261218 50 call"
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

  it("kill switch on or gates unknown: Close stays enabled, Buy and Sell are disabled", async () => {
    const g = gateway(true);
    await act(async () => root.render(<Harness g={g} />));
    await flush();
    const buttons = [
      ...host.querySelectorAll<HTMLButtonElement>("[data-position-action]"),
    ];
    expect(buttons.length).toBe(19);
    for (const b of buttons)
      expect(b.disabled).toBe(b.dataset["positionAction"] !== "close");
    expect(host.innerHTML).toContain("Kill switch on: Close only");
    // A close still opens its dialog with the kill switch on.
    await click(
      button('[data-position-id="2001"] [data-position-action="close"]')
    );
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    const failing = gateway();
    failing.status.mockRejectedValueOnce(new Error("down"));
    await act(async () => root.render(<Harness g={failing} />));
    await flush();
    expect(host.innerHTML).toContain("Order gates unknown");
    expect(
      button('[data-position-id="2007"] [data-position-action="close"]')
        .disabled
    ).toBe(false);
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
