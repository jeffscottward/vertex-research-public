// @vitest-environment jsdom
import type { GoLiveQueueOutput, VertexOrdersStatus } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  DraftsAndOrders,
  type DraftsAndOrdersGateway,
} from "./drafts-and-orders.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const render = async (
  gateway: DraftsAndOrdersGateway
): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DraftsAndOrders gateway={gateway} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
};

const QUEUE = {
  drafts: [
    {
      approvedRoom: null,
      expiry: "20261218",
      id: "d1",
      longStrike: 500,
      notApprovable: [],
      send: null,
      shortStrike: 490,
      sizing: { maxLoss: 950 },
      state: "proposed",
      structure: "putDebitVertical",
      symbol: "QQQ",
    },
  ],
} as unknown as GoLiveQueueOutput;

const ORDERS = {
  gates: { mode: "live" },
  openOrders: [
    {
      cancellable: true,
      expiry: null,
      limitPrice: 1,
      orderRef: "r",
      orderType: "LMT",
      permId: 1,
      quantity: 1,
      right: null,
      secType: "STK",
      side: "SELL",
      status: "PreSubmitted",
      strike: null,
      symbol: "SPY",
    },
  ],
} as unknown as VertexOrdersStatus;

describe("DraftsAndOrders", () => {
  it("lists open drafts with a link and working orders", async () => {
    const view = await render({
      drafts: async () => QUEUE,
      orders: async () => ORDERS,
    });
    expect(view.textContent).toContain(
      "1 open draft. 1 working order at IBKR."
    );
    expect(
      view.querySelector('a[href="/drafts#draft-d1"]')?.textContent
    ).toContain("QQQ");
    expect(view.textContent).toContain("max loss $950");
    expect(view.textContent).toContain("waiting for: Your Approve");
    expect(view.textContent).toContain("SELL 1 SPY STK @ 1 · PreSubmitted");
    expect(view.querySelector('a[href="/drafts"]')).not.toBeNull();
  });

  it("shows a definite empty state", async () => {
    const view = await render({
      drafts: async () => ({ drafts: [] }) as unknown as GoLiveQueueOutput,
      orders: async () =>
        ({
          gates: { mode: "live" },
          openOrders: [],
        }) as unknown as VertexOrdersStatus,
    });
    expect(view.textContent).toContain(
      "No drafts. No working orders at IBKR. Checked "
    );
    expect(view.querySelector("[data-drafts-list]")).toBeNull();
  });

  it("says only the owner reads IBKR orders when the server refuses the read", async () => {
    const view = await render({
      drafts: async () => ({ drafts: [] }) as unknown as GoLiveQueueOutput,
      orders: async () => {
        throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
      },
    });
    expect(view.textContent).toContain(
      "No drafts. IBKR orders: only the owner can read them."
    );
  });

  it("lists no orders in simulated mode and says IBKR was not read", async () => {
    const view = await render({
      drafts: async () => ({ drafts: [] }) as unknown as GoLiveQueueOutput,
      orders: async () =>
        ({
          ...ORDERS,
          gates: { mode: "simulated" },
        }) as unknown as VertexOrdersStatus,
    });
    expect(view.textContent).toContain(
      "IBKR orders not read: the order screen runs in simulated mode."
    );
    expect(view.querySelector("[data-orders-list]")).toBeNull();
  });

  it("shows unknown when a feed fails", async () => {
    const view = await render({
      drafts: async () => {
        throw new Error("down");
      },
      orders: async () => {
        throw new Error("not ready");
      },
    });
    expect(view.textContent).toContain("Drafts not loaded");
    expect(view.textContent).toContain("Working IBKR orders not loaded");
  });

  it("ignores a late answer after unmount", async () => {
    let finish: (value: GoLiveQueueOutput) => void = () => undefined;
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DraftsAndOrders
          gateway={{
            drafts: () => new Promise((resolve) => (finish = resolve)),
            orders: async () => ORDERS,
          }}
        />
      );
    });
    expect(container.textContent).toContain("Checking drafts");
    act(() => root?.unmount());
    root = null;
    await act(async () => finish(QUEUE));
  });
});
