// @vitest-environment jsdom
import type {
  ApiClient,
  GoLiveDraftOutput,
  GoLivePlanOutput,
  GoLiveQueueOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as unknown,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  createBrowserGoLiveDraftsGateway,
  GoLiveDraftQueue,
  type GoLiveDraftsGateway,
} from "./golive-draft-queue.tsx";
import {
  APPROVAL_NOT_SENT_SENTENCE,
  ENGINE_POLICY_LINE,
  EXIT_RULE_WORDS,
  NO_ORDERS_NOTICE,
  REJECT_NOTE_REQUIRED,
} from "./golive-draft-queue-model.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
});

// 15:30Z on 2026-11-11 is 10:30 in New York.
const AT = new Date("2026-11-11T15:30:00.000Z");

const ORDER = {
  legs: [
    {
      expiry: "20261218",
      ratio: 1,
      right: "C" as const,
      side: "BUY" as const,
      strike: 450,
    },
    {
      expiry: "20261218",
      ratio: 1,
      right: "C" as const,
      side: "SELL" as const,
      strike: 455,
    },
  ],
  limitPrice: 2.35,
  quantity: 2,
  symbol: "SPY",
};

const draft = (
  overrides: Partial<GoLiveDraftOutput> = {}
): GoLiveDraftOutput => ({
  createdAt: AT,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  entryBasis: "signal_today",
  exitReason: null,
  exitRule: "owner_standing_rule_v1",
  expiry: "20261218",
  id: "draft-spy",
  kind: "entry",
  longStrike: 450,
  nodeBadgeAtDecision: null,
  notApprovable: [],
  notes: [
    { id: "n1", stance: "bullish", theme: "Breadth thrust", verified: false },
    { id: "n2", stance: "neutral", theme: "Rates", verified: true },
  ],
  order: ORDER,
  parentDraftId: null,
  planId: "plan-1",
  planVersion: 3,
  preCheck: {
    enginePolicy: "not_evaluated_not_in_web_order_path",
    webFinalGate: {
      decision: "allow",
      jevStance: "BULLISH",
      jevState: "fresh",
      maxLoss: 470,
      maxLossPct: 0.47,
      reasons: ["Max loss 0.47% is within 2%"],
      structure: "debit-vertical",
    },
  },
  quote: {
    asOf: AT,
    longAsk: 5,
    longBid: 4.9,
    shortAsk: 2.7,
    shortBid: 2.6,
    source: "ibkr_live",
  },
  shortStrike: 455,
  signalFacts: ["VIX 19.5 on 2026-11-11"],
  sizing: {
    budget: 2000,
    limitPrice: 2.35,
    maxLoss: 470,
    maxLossPctNlv: 0.47,
    maxLossPerSpread: 235,
    quantity: 2,
    reason: "sized",
  },
  sleeveKey: "trend",
  state: "proposed",
  structure: "callDebitVertical",
  symbol: "SPY",
  tradingDay: "2026-11-11",
  updatedAt: AT,
  ...overrides,
});

const lateDraft = (): GoLiveDraftOutput =>
  draft({
    entryBasis: "model_holds_account_does_not",
    id: "draft-qqq",
    notApprovable: ["LATE_ENTRY_NOT_TESTED", "NO_LIVE_IBKR_QUOTE"],
    notes: [],
    order: null,
    preCheck: {
      enginePolicy: "not_evaluated_not_in_web_order_path",
      webFinalGate: null,
    },
    quote: {
      asOf: AT,
      longAsk: 5,
      longBid: 4.9,
      shortAsk: 2.7,
      shortBid: 2.6,
      source: "yahoo_delayed_snapshot",
    },
    signalFacts: [],
    sizing: {
      budget: null,
      limitPrice: null,
      maxLoss: null,
      maxLossPctNlv: null,
      maxLossPerSpread: null,
      quantity: 0,
      reason: "nlv_unavailable",
    },
    symbol: "QQQ",
  });

const plan = (overrides: Partial<GoLivePlanOutput> = {}): GoLivePlanOutput => ({
  approvalBasis: "owner_delegation",
  approvedAt: AT,
  approvedBy: "owner",
  createdAt: AT,
  evidenceUrl: "https://example.com/evidence",
  exitRule: "owner_standing_rule_v1",
  id: "plan-1",
  limits: {
    maxPositions: 6,
    nameRiskCapPct: 2,
    openRiskCapPct: 8,
    positionRiskPct: 2,
  },
  name: "Go-live allocation",
  ownerMessageUrl: "https://discord.com/channels/1/2/3",
  retiredAt: null,
  sleeves: [
    {
      anchorDelta: 0.5,
      budgetPct: 4,
      definitionNote: "Entry rule always true.",
      definitionVariant: "always_on_entry",
      dteMin: 20,
      dteTarget: 35,
      key: "trend",
      name: "Trend verticals",
      runKey: "trend-v1",
      structure: "callDebitVertical",
      symbols: ["SPY", "QQQ"],
      widthSigma: 1,
    },
  ],
  status: "approved",
  updatedAt: AT,
  version: 3,
  ...overrides,
});

const queue = (
  overrides: Partial<GoLiveQueueOutput> = {}
): GoLiveQueueOutput => ({
  account: { asOf: AT, netLiquidation: 100_000, unavailableReason: null },
  drafts: [draft()],
  generatedAt: AT,
  marketNotes: "attached",
  node: { armedAt: null, badge: "running-disarmed", checkedAt: AT },
  plan: plan(),
  sendsOrders: false,
  tradingDay: "2026-11-11",
  ...overrides,
});

type GatewayMock = {
  [Key in keyof GoLiveDraftsGateway]: Mock<GoLiveDraftsGateway[Key]>;
};

const gatewayOf = (
  ...results: readonly (GoLiveQueueOutput | Error)[]
): GatewayMock => {
  const queueMock = vi.fn<GoLiveDraftsGateway["queue"]>();
  for (const result of results)
    if (result instanceof Error) queueMock.mockRejectedValueOnce(result);
    else queueMock.mockResolvedValueOnce(result);
  return {
    approve: vi.fn<GoLiveDraftsGateway["approve"]>(async () => draft()),
    queue: queueMock,
    reject: vi.fn<GoLiveDraftsGateway["reject"]>(async () => draft()),
  };
};

const forbidden = (): Error =>
  Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });

const mount = async (gateway?: GoLiveDraftsGateway): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      gateway === undefined ? (
        <GoLiveDraftQueue />
      ) : (
        <GoLiveDraftQueue gateway={gateway} />
      )
    )
  );
  return container;
};

const one = (root: ParentNode, selector: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}`);
  return found;
};

const button = (root: ParentNode, name: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent) === name
  );
  if (found === undefined) throw new Error(`No button named ${name}`);
  return found;
};

const click = (element: HTMLElement): Promise<void> =>
  act(async () => element.click());

const type = (field: HTMLTextAreaElement, value: string): Promise<void> =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

const texts = (root: ParentNode, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((node) => node.textContent ?? "");

describe("GoLiveDraftQueue", () => {
  it("shows the no-orders notice and a loading status before the queue answers", async () => {
    const gateway = gatewayOf();
    gateway.queue.mockReturnValue(new Promise(() => undefined));
    const container = await mount(gateway);
    expect(one(container, "[data-golive-notice]").textContent).toBe(
      NO_ORDERS_NOTICE
    );
    const status = one(container, "[role='status']");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Loading order drafts…");
  });

  it("shows the operator denial notice when the queue is forbidden", async () => {
    const container = await mount(gatewayOf(forbidden()));
    expect(container.textContent).toContain("Operator access required");
    expect(container.textContent).toContain(
      "The go-live order draft queue (plan record and order drafts) is limited to operators."
    );
    expect(one(container, "[data-golive-notice]").textContent).toBe(
      NO_ORDERS_NOTICE
    );
    expect(container.querySelector("[data-golive-group]")).toBeNull();
  });

  it("shows an API error in plain words and retries", async () => {
    const gateway = gatewayOf(new Error("Queue store is down."), queue());
    const container = await mount(gateway);
    expect(one(container, "[role='alert']").textContent).toBe(
      "Order drafts unavailable. Queue store is down."
    );
    await click(button(container, "Retry now"));
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(
      container.querySelector("[data-golive-plan='approved']")
    ).not.toBeNull();
  });

  it("says when there is no plan, no account value and no entry signal", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          account: {
            asOf: null,
            netLiquidation: null,
            unavailableReason: "portfolio monitor did not answer",
          },
          drafts: [],
          generatedAt: null,
          marketNotes: "feature_not_deployed",
          node: { armedAt: null, badge: "unknown", checkedAt: AT },
          plan: null,
        })
      )
    );
    expect(one(container, "[data-golive-plan='none']").textContent).toBe(
      "No plan record"
    );
    expect(texts(container, "[data-golive-status]")).toEqual([
      "Account value not available: portfolio monitor did not answer",
      "Node state not readable (checked 10:30 ET)",
      "Generator has not reported for 2026-11-11",
      "Market notes: the feature is not deployed",
    ]);
    expect(container.textContent).not.toContain("$0");
    expect(texts(container, "[data-golive-group] > h3")).toEqual([
      "Entry signal today",
      "Model holds, account does not (late entry not tested, cannot be approved)",
    ]);
    expect(one(container, "#golive-group-entry-signal + p").textContent).toBe(
      "No entry signal today under the plan's entry rule."
    );
    expect(one(container, "#golive-group-model-holds + p").textContent).toBe(
      "No draft in this group."
    );
  });

  it("shows a plan approved by delegation with both links, its limits and sleeves", async () => {
    const container = await mount(gatewayOf(queue()));
    const block = one(container, "[data-golive-plan='approved']");
    expect(block.textContent).toContain("Go-live allocation (version 3)");
    expect(one(block, "[data-golive-plan-status]").textContent).toBe(
      "Plan approved by delegation (the owner delegated the allocation choice)"
    );
    expect(
      [...block.querySelectorAll("a")].map((link) => [
        link.textContent,
        link.getAttribute("href"),
      ])
    ).toEqual([
      ["Owner message", "https://discord.com/channels/1/2/3"],
      ["Evidence", "https://example.com/evidence"],
    ]);
    expect(block.textContent).toContain("Risk per position2% of the account");
    expect(block.textContent).toContain("Open risk cap8% of the account");
    expect(block.textContent).toContain("Per-name cap2% of the account");
    expect(block.textContent).toContain("Max positions6");
    const sleeve = one(block, "[data-golive-sleeve='trend']").textContent;
    expect(sleeve).toContain("Trend verticals");
    expect(sleeve).toContain("Budget4% of the account");
    expect(sleeve).toContain("Call debit vertical (bull call spread)");
    expect(sleeve).toContain("SPY, QQQ");
    expect(sleeve).toContain("Entry rule always true.");
    expect(texts(container, "[data-golive-status]")).toEqual([
      "Account value: $100,000 as of 10:30 ET",
      "Node running, disarmed (checked 10:30 ET)",
      "Generator ran at 10:30 ET: 1 draft",
      "Market notes: attached to the drafts",
    ]);
  });

  it("shows a proposed plan without links", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          plan: plan({
            approvalBasis: null,
            evidenceUrl: null,
            ownerMessageUrl: null,
            status: "proposed",
          }),
        })
      )
    );
    const block = one(container, "[data-golive-plan='proposed']");
    expect(one(block, "[data-golive-plan-status]").textContent).toBe(
      "Plan not approved"
    );
    expect(block.querySelector("a")).toBeNull();
  });

  it("shows only the link a plan has", async () => {
    const container = await mount(
      gatewayOf(queue({ plan: plan({ evidenceUrl: null }) }))
    );
    expect(texts(one(container, "[data-golive-plan='approved']"), "a")).toEqual(
      ["Owner message"]
    );
  });

  it("lists every fact of an approvable draft", async () => {
    const container = await mount(gatewayOf(queue()));
    const row = one(
      container,
      "[data-golive-group='golive-group-entry-signal'] [data-golive-draft='draft-spy']"
    );
    expect(one(row, "h4").textContent).toBe(
      "SPY Call debit vertical (bull call spread)"
    );
    const facts = Object.fromEntries(
      [...row.querySelectorAll("dl > div")].map((field) => [
        one(field, "dt").textContent,
        one(field, "dd").textContent,
      ])
    );
    expect(facts).toEqual({
      "Exit rule": EXIT_RULE_WORDS,
      Expiry: "2026-12-18",
      Limit: "debit 2.35",
      "Market notes": "Breadth thrust: bullish (unverified)Rates: neutral",
      "Max loss": "$470.00 (0.47% of account)",
      "Pre-check": `Web final gate: allowMax loss 0.47% is within 2%${ENGINE_POLICY_LINE}`,
      Quantity: "2 (sized from the plan's risk per position)",
      Quote: "IBKR live, as of 10:30 ET",
      "Signal facts": "VIX 19.5 on 2026-11-11",
      State: "Proposed",
      Strikes: "long 450.00 / short 455.00",
    });
    const approve = button(row, "Approve SPY 2026-12-18");
    expect(approve.textContent).toBe("Approve");
    expect(approve.disabled).toBe(false);
    expect(approve.hasAttribute("aria-describedby")).toBe(false);
    expect(row.querySelector("[data-golive-blockers]")).toBeNull();
  });

  it("lists a late-entry draft with Approve disabled and the reasons next to it", async () => {
    const container = await mount(gatewayOf(queue({ drafts: [lateDraft()] })));
    expect(one(container, "#golive-group-entry-signal + p").textContent).toBe(
      "No entry signal today under the plan's entry rule."
    );
    const row = one(
      container,
      "[data-golive-group='golive-group-model-holds'] [data-golive-draft='draft-qqq']"
    );
    expect(row.textContent).toContain(
      "Yahoo, 15 min delayed, indicative, as of 10:30 ET"
    );
    expect(row.textContent).toContain("no limit: no quote");
    expect(row.textContent).toContain("0 (the account value is not available)");
    expect(row.textContent).toContain(
      "not available: the account value is not available"
    );
    expect(row.textContent).toContain(
      "Web final gate: not run (no sized order to check)"
    );
    expect(row.textContent).toContain(ENGINE_POLICY_LINE);
    expect(row.textContent).toContain("None reported");
    expect(row.textContent).toContain("None attached");
    const approve = button(row, "Approve QQQ 2026-12-18");
    expect(approve.disabled).toBe(true);
    const blockers = one(row, "[data-golive-blockers]");
    expect(approve.getAttribute("aria-describedby")).toBe(blockers.id);
    expect(texts(blockers, "li")).toEqual([
      "Late entry is not in the backtest",
      "No live IBKR quote: the price shown is delayed",
    ]);
    expect(button(row, "Reject QQQ 2026-12-18").disabled).toBe(false);
  });

  it("shows decided drafts in words without buttons, and exit drafts in their own group", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          drafts: [
            draft({
              decidedAt: AT,
              decidedBy: "owner",
              id: "approved",
              nodeBadgeAtDecision: "running-disarmed",
              state: "approved",
            }),
            draft({
              decidedAt: AT,
              decidedBy: "owner",
              decisionNote: "Earnings next week.",
              id: "rejected",
              state: "rejected",
            }),
            draft({
              entryBasis: null,
              exitReason: "loser_3_trading_days_before_expiry",
              id: "exit",
              kind: "exit",
            }),
          ],
        })
      )
    );
    const approved = one(container, "[data-golive-draft='approved']");
    expect(approved.textContent).toContain(
      "Approved (recorded). Not sent: this page sends no orders."
    );
    expect(approved.textContent).toContain(
      "Decided 2026-11-11 10:30 ET by owner"
    );
    expect(approved.querySelector("button")).toBeNull();
    const rejected = one(container, "[data-golive-draft='rejected']");
    expect(rejected.textContent).toContain("Rejected");
    expect(rejected.textContent).toContain("Decision noteEarnings next week.");
    expect(rejected.querySelector("button")).toBeNull();
    expect(texts(container, "[data-golive-group] > h3")).toEqual([
      "Entry signal today",
      "Model holds, account does not (late entry not tested, cannot be approved)",
      "Exit rule",
    ]);
    const exit = one(
      container,
      "[data-golive-group='golive-group-exit'] [data-golive-draft='exit']"
    );
    expect(exit.textContent).toContain(
      "Exit reasonLoser: closes 3 trading days before expiry"
    );
  });

  it("confirms the exact order, records the approval and reloads the queue", async () => {
    const gateway = gatewayOf(
      queue(),
      queue({ drafts: [draft({ decidedAt: AT, state: "approved" })] })
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(container, "[role='dialog']");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      one(
        container,
        `#${CSS.escape(dialog.getAttribute("aria-labelledby") ?? "")}`
      ).textContent
    ).toBe("Approve SPY 2026-12-18 Call debit vertical (bull call spread)");
    expect(document.activeElement).toBe(button(dialog, "Cancel"));
    expect(texts(dialog, "[aria-label='Order legs'] li")).toEqual([
      "BUY 1 SPY 2026-12-18 450.00 call",
      "SELL 1 SPY 2026-12-18 455.00 call",
    ]);
    const order = one(dialog, "[data-golive-order]").textContent;
    expect(order).toContain("Quantity2");
    expect(order).toContain("Limitdebit 2.35");
    expect(order).toContain("Max loss$470.00 (0.47% of account)");
    expect(one(dialog, "[data-golive-not-sent]").textContent).toBe(
      APPROVAL_NOT_SENT_SENTENCE
    );
    expect(dialog.querySelector("textarea")).toBeNull();
    expect(gateway.approve).not.toHaveBeenCalled();

    await click(button(dialog, "Record approval"));
    expect(gateway.approve).toHaveBeenCalledTimes(1);
    expect(gateway.approve).toHaveBeenCalledWith({
      confirm: true,
      id: "draft-spy",
      order: ORDER,
    });
    expect(gateway.reject).not.toHaveBeenCalled();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(
      one(container, "[data-golive-draft='draft-spy']").getAttribute(
        "data-golive-draft-state"
      )
    ).toBe("approved");
  });

  it("closes the dialog on Cancel and on Escape without recording anything", async () => {
    const gateway = gatewayOf(queue());
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(one(container, "[role='dialog']"), "Cancel"));
    expect(container.querySelector("[role='dialog']")).toBeNull();

    await click(button(container, "Reject SPY 2026-12-18"));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.reject).not.toHaveBeenCalled();
    expect(gateway.queue).toHaveBeenCalledTimes(1);
  });

  it("needs a note to reject, then records the rejection and reloads", async () => {
    const gateway = gatewayOf(queue(), queue({ drafts: [] }));
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    const dialog = one(container, "[data-golive-dialog='reject']");
    const note = one(dialog, "textarea") as HTMLTextAreaElement;
    expect(one(dialog, `label[for='${note.id}']`).textContent).toBe(
      "Note (required)"
    );
    expect(note.required).toBe(true);
    expect(dialog.querySelector("[data-golive-order]")).toBeNull();

    await type(note, "   ");
    await click(button(dialog, "Record rejection"));
    expect(one(dialog, "[role='alert']").textContent).toBe(
      REJECT_NOTE_REQUIRED
    );
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(gateway.reject).not.toHaveBeenCalled();

    await type(note, "  Earnings next week.  ");
    expect(dialog.querySelector("[role='alert']")).toBeNull();
    await click(button(dialog, "Record rejection"));
    expect(gateway.reject).toHaveBeenCalledWith({
      id: "draft-spy",
      note: "Earnings next week.",
    });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("keeps the dialog open and shows the API error when a decision fails", async () => {
    const gateway = gatewayOf(queue());
    gateway.approve.mockRejectedValueOnce(
      new Error("The sized order changed. Reload the queue.")
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(container, "[role='dialog']");
    await click(button(dialog, "Record approval"));
    expect(one(dialog, "[role='alert']").textContent).toBe(
      "The sized order changed. Reload the queue."
    );
    expect(gateway.queue).toHaveBeenCalledTimes(1);
    expect(button(dialog, "Record approval").disabled).toBe(false);
  });

  it("disables the controls and ignores Escape while a decision is being recorded", async () => {
    const gateway = gatewayOf(queue());
    gateway.approve.mockReturnValueOnce(new Promise(() => undefined));
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(container, "[role='dialog']");
    await click(button(dialog, "Record approval"));
    expect(button(dialog, "Record approval").disabled).toBe(true);
    expect(button(dialog, "Cancel").disabled).toBe(true);
    expect(button(container, "Reject SPY 2026-12-18").disabled).toBe(true);
    expect(button(container, "Reload queue").disabled).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
  });

  it.each(["approve", "reject"] as const)(
    "keeps the queue and says only the owner decides when %s is forbidden",
    async (action) => {
      const gateway = gatewayOf(queue({ drafts: [draft(), lateDraft()] }));
      gateway[action].mockRejectedValueOnce(forbidden());
      const container = await mount(gateway);
      if (action === "approve") {
        await click(button(container, "Approve SPY 2026-12-18"));
        await click(button(container, "Record approval"));
      } else {
        await click(button(container, "Reject SPY 2026-12-18"));
        await type(one(container, "textarea") as HTMLTextAreaElement, "No.");
        await click(button(container, "Record rejection"));
      }
      expect(gateway[action]).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[role='dialog']")).toBeNull();
      expect(container.textContent).not.toContain("Operator access required");
      expect(gateway.queue).toHaveBeenCalledTimes(1);
      const row = one(container, "[data-golive-draft='draft-spy']");
      const alert = one(row, "[data-golive-owner-only]");
      expect(alert.getAttribute("role")).toBe("alert");
      expect(alert.textContent).toBe(
        "Only the owner can approve or reject a draft."
      );
      expect(texts(container, "[data-golive-owner-only]")).toHaveLength(1);
      expect(
        one(container, "[data-golive-draft='draft-qqq']").querySelector(
          "[data-golive-owner-only]"
        )
      ).toBeNull();

      // Opening a decision again clears the message.
      await click(button(container, "Reject SPY 2026-12-18"));
      expect(container.querySelector("[data-golive-owner-only]")).toBeNull();
    }
  );

  it("keeps the last loaded queue when a reload fails", async () => {
    const gateway = gatewayOf(queue(), new Error("Network down."), queue());
    const container = await mount(gateway);
    await click(button(container, "Reload queue"));
    expect(one(container, "[role='alert']").textContent).toBe(
      "Reload failed; showing the last loaded queue. Network down."
    );
    expect(
      container.querySelector("[data-golive-draft='draft-spy']")
    ).not.toBeNull();
    await click(button(container, "Reload queue"));
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("createBrowserGoLiveDraftsGateway", () => {
  it("connects once to the page origin and forwards each call", async () => {
    const api = {
      approve: vi.fn(async () => draft({ state: "approved" })),
      queue: vi.fn(async () => queue()),
      reject: vi.fn(async () => draft({ state: "rejected" })),
    };
    runtime.client = { goLiveDrafts: api };
    const gateway = createBrowserGoLiveDraftsGateway();
    expect(runtime.origins).toEqual([]);

    await expect(gateway.queue()).resolves.toEqual(queue());
    expect(api.queue).toHaveBeenCalledWith({});
    const approval = { confirm: true as const, id: "draft-spy", order: ORDER };
    await expect(gateway.approve(approval)).resolves.toMatchObject({
      state: "approved",
    });
    expect(api.approve).toHaveBeenCalledWith(approval);
    const rejection = { id: "draft-spy", note: "No." };
    await expect(gateway.reject(rejection)).resolves.toMatchObject({
      state: "rejected",
    });
    expect(api.reject).toHaveBeenCalledWith(rejection);
    expect(runtime.origins).toEqual([window.location.origin]);
  });

  it("is what the queue uses when no gateway is supplied", async () => {
    const api = { queue: vi.fn(async () => queue({ plan: null })) };
    runtime.client = { goLiveDrafts: api };
    const container = await mount();
    expect(api.queue).toHaveBeenCalledTimes(1);
    expect(one(container, "[data-golive-plan='none']").textContent).toBe(
      "No plan record"
    );
  });
});
