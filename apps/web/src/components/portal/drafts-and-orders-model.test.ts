import type {
  GoLiveDraftOutput,
  GoLiveQueueOutput,
  VertexOrdersStatus,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  checkedText,
  draftRows,
  moneyText,
  orderRows,
  summaryText,
  waitingFor,
} from "./drafts-and-orders-model.ts";

const AT = new Date("2026-11-20T15:30:00.000Z");

const draft = (overrides: Partial<GoLiveDraftOutput>): GoLiveDraftOutput =>
  ({
    approvedRoom: null,
    expiry: "20261218",
    id: "d1",
    longStrike: 500,
    notApprovable: [],
    send: null,
    shortStrike: 490,
    sizing: { maxLoss: null } as unknown as GoLiveDraftOutput["sizing"],
    state: "proposed",
    structure: "putDebitVertical",
    symbol: "QQQ",
    ...overrides,
  }) as GoLiveDraftOutput;

const queue = (drafts: GoLiveDraftOutput[]): GoLiveQueueOutput =>
  ({ drafts }) as GoLiveQueueOutput;

const ORDER: VertexOrdersStatus["openOrders"][number] = {
  cancellable: true,
  expiry: "20261218",
  limitPrice: 9.5,
  orderRef: "ref",
  orderType: "LMT",
  permId: 7,
  quantity: 1,
  right: "P",
  secType: "OPT",
  side: "BUY",
  status: "Submitted",
  strike: 500,
  symbol: "QQQ",
};

describe("waitingFor", () => {
  it("names the next step for each state", () => {
    expect(waitingFor(draft({}))).toBe("Your Approve");
    expect(waitingFor(draft({ notApprovable: ["PLAN_NOT_APPROVED"] }))).toBe(
      "Cannot be approved now (see the draft)"
    );
    expect(waitingFor(draft({ send: "not_sent", state: "approved" }))).toBe(
      "Arm, then Send approved order"
    );
    expect(waitingFor(draft({ send: null, state: "approved" }))).toBe(
      "Send state not shown"
    );
    expect(waitingFor(draft({ state: "rejected" }))).toBe("Nothing");
  });
});

describe("draftRows", () => {
  it("keeps open drafts, links each one and takes the approved room first", () => {
    const rows = draftRows(
      queue([
        draft({
          id: "a",
          sizing: { maxLoss: 900 } as GoLiveDraftOutput["sizing"],
        }),
        draft({
          approvedRoom: { maxLoss: 800, maxLossPctNlv: null },
          id: "b",
          send: "sent",
          state: "approved",
        }),
        draft({ id: "c" }),
        draft({ id: "d", state: "expired" }),
      ])
    );
    expect(rows.map((row) => [row.id, row.maxLoss, row.href])).toEqual([
      ["a", 900, "/drafts#draft-a"],
      ["b", 800, "/drafts#draft-b"],
      ["c", null, "/drafts#draft-c"],
    ]);
    expect(rows[0]?.label).toContain("QQQ");
  });
});

describe("orderRows and texts", () => {
  it("labels working orders", () => {
    expect(orderRows({ openOrders: [ORDER] } as VertexOrdersStatus)).toEqual([
      {
        key: "7-ref",
        label: "BUY 1 QQQ OPT 20261218 500 P @ 9.5",
        status: "Submitted",
      },
    ]);
    expect(
      orderRows({
        openOrders: [
          {
            ...ORDER,
            expiry: null,
            limitPrice: null,
            right: null,
            strike: null,
          },
        ],
      } as VertexOrdersStatus)[0]?.label
    ).toBe("BUY 1 QQQ OPT LMT");
  });

  it("formats money and the summary", () => {
    expect(moneyText(null)).toBe("unknown");
    expect(moneyText(1234.4)).toBe("$1,234");
    const at = checkedText(AT);
    expect(summaryText({ checkedAt: AT, drafts: [], orders: [] })).toBe(
      `No drafts. No working orders at IBKR. Checked ${at}.`
    );
    expect(summaryText({ checkedAt: AT, drafts: null, orders: null })).toBe(
      `Drafts unknown (the draft list did not load). Working IBKR orders unknown (the order feed is not ready). Checked ${at}.`
    );
    const row = draftRows(queue([draft({})]));
    const order = orderRows({
      openOrders: [ORDER, ORDER],
    } as VertexOrdersStatus);
    expect(summaryText({ checkedAt: AT, drafts: row, orders: order })).toBe(
      `1 open draft. 2 working orders at IBKR. Checked ${at}.`
    );
    expect(
      summaryText({
        checkedAt: AT,
        drafts: [...row, ...row],
        orders: order.slice(1),
      })
    ).toContain("2 open drafts. 1 working order at IBKR.");
  });
});
