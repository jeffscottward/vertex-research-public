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
  NODE_DISARMED_NOTE,
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
  approvedOrder: null,
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
  canDecide: true,
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

const unauthorized = (): Error =>
  Object.assign(new Error("Authentication required"), {
    code: "UNAUTHORIZED",
  });

// Radix gives focus back in a timer after the dialog has unmounted.
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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
      `Node state unknown: the node status could not be read (checked 10:30 ET)${NODE_DISARMED_NOTE}`,
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
      `Node running, disarmed (checked 10:30 ET)${NODE_DISARMED_NOTE}`,
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
      "Exit rule": EXIT_RULE_WORDS.owner_standing_rule_v1,
      Expiry: "2026-12-18",
      Limit: "debit 2.35",
      "Market notes": "Breadth thrust: bullish (unverified)Rates: neutral",
      "Max loss": "$470.00 (0.47% of account)",
      "Pre-check": `Dry pre-check (web final gate; positions, kill switch and options-only gate not included): allow. Not a clearance to send.Max loss 0.47% is within 2%JEV stance used by the check: bullish (the JEV read is fresh)${ENGINE_POLICY_LINE}`,
      Quantity: "2 (sized from the plan's risk per position)",
      Quote: "IBKR live, as of 2026-11-11 10:30 ET",
      "Signal facts": "VIX 19.5 on 2026-11-11",
      State: "Proposed by the generator, not decided",
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
      "Yahoo, 15 min delayed, indicative, as of 2026-11-11 10:30 ET"
    );
    expect(row.textContent).toContain("no limit: no quote");
    expect(row.textContent).toContain("0 (the account value is not available)");
    expect(row.textContent).toContain(
      "not available: the account value is not available"
    );
    expect(row.textContent).toContain(
      "Dry pre-check (web final gate): not run, because there is no sized order to check."
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
      "No live IBKR quote: the price shown is a Yahoo snapshot, delayed 15 minutes",
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
    expect(rejected.textContent).toContain("Rejected by the owner (recorded)");
    expect(rejected.textContent).toContain("Decision noteEarnings next week.");
    expect(rejected.querySelector("button")).toBeNull();
    expect(texts(container, "[data-golive-group] > h3")).toEqual([
      "Entry signal today",
      "Model holds, account does not (late entry not tested, cannot be approved)",
      "Exit proposals under the owner exit rule (you close the position)",
    ]);
    const exit = one(
      container,
      "[data-golive-group='golive-group-exit'] [data-golive-draft='exit']"
    );
    expect(exit.textContent).toContain(
      "Exit reasonProposal to close: losing position, 3 trading days before expiry"
    );
  });

  it("confirms the exact order, records the approval and reloads the queue", async () => {
    const gateway = gatewayOf(
      queue(),
      queue({ drafts: [draft({ decidedAt: AT, state: "approved" })] })
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(document, "[role='dialog']");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      one(
        document,
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
    expect(document.querySelector("[role='dialog']")).toBeNull();
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
    await click(button(one(document, "[role='dialog']"), "Cancel"));
    expect(document.querySelector("[role='dialog']")).toBeNull();

    await click(button(container, "Reject SPY 2026-12-18"));
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      );
    });
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.reject).not.toHaveBeenCalled();
    expect(gateway.queue).toHaveBeenCalledTimes(1);
  });

  it("needs a note to reject, then records the rejection and reloads", async () => {
    const gateway = gatewayOf(queue(), queue({ drafts: [] }));
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    const dialog = one(document, "[data-golive-dialog='reject']");
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
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("keeps the dialog open and shows the API error when a decision fails", async () => {
    const gateway = gatewayOf(queue());
    gateway.approve.mockRejectedValueOnce(
      new Error("The sized order changed. Reload the queue.")
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(document, "[role='dialog']");
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
    const dialog = one(document, "[role='dialog']");
    await click(button(dialog, "Record approval"));
    expect(button(dialog, "Record approval").disabled).toBe(true);
    expect(button(dialog, "Cancel").disabled).toBe(true);
    expect(button(container, "Reject SPY 2026-12-18").disabled).toBe(true);
    expect(button(container, "Reload queue").disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
  });

  it.each(["approve", "reject"] as const)(
    "keeps the queue and says only the owner decides when %s is forbidden",
    async (action) => {
      const gateway = gatewayOf(queue({ drafts: [draft(), lateDraft()] }));
      gateway[action].mockRejectedValueOnce(forbidden());
      const container = await mount(gateway);
      if (action === "approve") {
        await click(button(container, "Approve SPY 2026-12-18"));
        await click(button(document, "Record approval"));
      } else {
        await click(button(container, "Reject SPY 2026-12-18"));
        await type(one(document, "textarea") as HTMLTextAreaElement, "No.");
        await click(button(document, "Record rejection"));
      }
      expect(gateway[action]).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[role='dialog']")).toBeNull();
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

  it("links the notice to the Vertex orders tab of the Portfolio page", async () => {
    const container = await mount(gatewayOf(queue()));
    const notice = one(container, "[data-golive-notice]");
    expect(notice.textContent).toBe(NO_ORDERS_NOTICE);
    expect(notice.textContent).toContain("use the Vertex orders tab");
    expect(notice.textContent).not.toContain("Orders & stops");
    expect(notice.textContent).not.toContain("Portfolio > Orders");
    const link = one(notice, "a");
    expect(link.textContent).toBe("Portfolio");
    expect(link.getAttribute("href")).toBe("/portfolio?tab=orders");
  });

  it("says next to the node badge that a disarmed node does not stop an order", async () => {
    const container = await mount(gatewayOf(queue()));
    expect(
      one(container, "[data-golive-status='node'] [data-golive-node-note]")
        .textContent
    ).toBe(
      "A disarmed node does not stop an order placed on the Portfolio order screen; only the kill switch does."
    );
  });

  it("shows the stored approved order apart from live sizing that has changed since", async () => {
    // Approved: 2 spreads at 2.35. The live sizing has moved to 3 spreads at 2.50.
    const moved = { ...ORDER, limitPrice: 2.5, quantity: 3 };
    const container = await mount(
      gatewayOf(
        queue({
          drafts: [
            draft({
              approvedOrder: ORDER,
              decidedAt: AT,
              decidedBy: "owner",
              order: moved,
              sizing: {
                budget: 2000,
                limitPrice: 2.5,
                maxLoss: 750,
                maxLossPctNlv: 0.75,
                maxLossPerSpread: 250,
                quantity: 3,
                reason: "sized",
              },
              state: "approved",
            }),
          ],
        })
      )
    );
    const row = one(container, "[data-golive-draft='draft-spy']");
    const facts = Object.fromEntries(
      [...row.querySelectorAll("dl > div")].map((field) => [
        one(field, "dt").textContent,
        one(field, "dd").textContent,
      ])
    );
    expect(facts["Approved order (recorded 2026-11-11 10:30 ET)"]).toBe(
      "BUY 1 SPY 2026-12-18 450.00 callSELL 1 SPY 2026-12-18 455.00 callQuantity: 2Limit: debit 2.35"
    );
    expect(
      facts[
        "Current indicative sizing (recomputed now; not the approved order)"
      ]
    ).toBe(
      "limit debit 2.50; quantity 3 (sized from the plan's risk per position); max loss $750.00 (0.75% of account)"
    );
    // The live numbers have no bare label that could be read as the approved order.
    expect(Object.keys(facts)).not.toContain("Limit");
    expect(Object.keys(facts)).not.toContain("Quantity");
    expect(Object.keys(facts)).not.toContain("Max loss");
    expect(one(row, "[data-golive-approved-order]").textContent).not.toContain(
      "2.50"
    );
  });

  it("says when an approval has no stored order instead of showing the live sizing as approved", async () => {
    const container = await mount(
      gatewayOf(
        queue({ drafts: [draft({ decidedAt: AT, state: "approved" })] })
      )
    );
    expect(
      one(container, "[data-golive-approved-order='missing']").textContent
    ).toBe(
      "Not stored with this approval, so the approved order cannot be shown."
    );
  });

  it("sends one request when Record approval is clicked twice", async () => {
    const gateway = gatewayOf(queue(), queue());
    let finish: (value: GoLiveDraftOutput) => void = () => undefined;
    gateway.approve.mockReturnValueOnce(
      new Promise<GoLiveDraftOutput>((resolve) => {
        finish = resolve;
      })
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const record = button(document, "Record approval");
    // Both clicks arrive before React has rendered the disabled button.
    await act(async () => {
      record.click();
      record.click();
    });
    expect(gateway.approve).toHaveBeenCalledTimes(1);
    await act(async () => finish(draft({ state: "approved" })));
    expect(gateway.approve).toHaveBeenCalledTimes(1);
    expect(gateway.queue).toHaveBeenCalledTimes(2);
  });

  it("sends one request when Record rejection is clicked twice", async () => {
    const gateway = gatewayOf(queue());
    gateway.reject.mockReturnValueOnce(new Promise(() => undefined));
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    await type(one(document, "textarea") as HTMLTextAreaElement, "No.");
    const record = button(document, "Record rejection");
    await act(async () => {
      record.click();
      record.click();
    });
    expect(gateway.reject).toHaveBeenCalledTimes(1);
  });

  it("shows the approved draft the server returned when the reload after it fails", async () => {
    const gateway = gatewayOf(queue(), new Error("Network down."));
    gateway.approve.mockResolvedValueOnce(
      draft({
        approvedOrder: ORDER,
        decidedAt: AT,
        decidedBy: "owner",
        state: "approved",
      })
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(one(container, "[data-golive-reload-error]").textContent).toBe(
      "Reload failed; showing the last loaded queue. Network down."
    );
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(row.getAttribute("data-golive-draft-state")).toBe("approved");
    expect(row.textContent).toContain(
      "Approved (recorded). Not sent: this page sends no orders."
    );
    expect(row.textContent).toContain(
      "Approved order (recorded 2026-11-11 10:30 ET)"
    );
    // No button is left that could record the same decision again.
    expect(row.querySelector("button")).toBeNull();
  });

  it("shows the rejected draft the server returned when the reload after it fails", async () => {
    const gateway = gatewayOf(queue(), new Error("Network down."));
    gateway.reject.mockResolvedValueOnce(
      draft({ decidedAt: AT, decisionNote: "No.", state: "rejected" })
    );
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    await type(one(document, "textarea") as HTMLTextAreaElement, "No.");
    await click(button(document, "Record rejection"));
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(row.getAttribute("data-golive-draft-state")).toBe("rejected");
    expect(row.querySelector("button")).toBeNull();
  });

  it("hides Approve and Reject and says once that only the owner decides when canDecide is false", async () => {
    const container = await mount(
      gatewayOf(queue({ canDecide: false, drafts: [draft(), lateDraft()] }))
    );
    expect(container.querySelector("[data-golive-action]")).toBeNull();
    expect(container.querySelector("[data-golive-actions]")).toBeNull();
    expect(texts(container, "button")).toEqual(["Reload queue"]);
    expect(texts(container, "[data-golive-cannot-decide]")).toEqual([
      "Only the owner can approve or reject a draft.",
    ]);
    expect(
      container.textContent?.split(
        "Only the owner can approve or reject a draft."
      )
    ).toHaveLength(2);
    // The drafts themselves are still listed.
    expect(container.querySelectorAll("[data-golive-draft]")).toHaveLength(2);
  });

  it("does not show the owner-only sentence when canDecide is true", async () => {
    const container = await mount(gatewayOf(queue()));
    expect(container.querySelector("[data-golive-cannot-decide]")).toBeNull();
  });

  it("says plainly that the session has ended when the queue is UNAUTHORIZED", async () => {
    const container = await mount(gatewayOf(unauthorized()));
    expect(one(container, "[role='alert']").textContent).toBe(
      "Order drafts unavailable. You are signed out: the session has ended. Sign in again."
    );
    expect(container.textContent).not.toContain("UNAUTHORIZED");
    expect(container.textContent).not.toContain("Operator access required");
  });

  it("says plainly that the session has ended when a decision is UNAUTHORIZED", async () => {
    const gateway = gatewayOf(queue());
    gateway.approve.mockRejectedValueOnce(unauthorized());
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(one(document, "[data-golive-dialog-error]").textContent).toBe(
      "You are signed out: the session has ended. Sign in again. Nothing was recorded."
    );
    expect(document.body.textContent).not.toContain("UNAUTHORIZED");
    expect(gateway.queue).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog, reloads and puts server blocker codes in words on CONFLICT", async () => {
    const gateway = gatewayOf(
      queue(),
      queue({ drafts: [draft({ notApprovable: ["PRECHECK_DENIED"] })] })
    );
    gateway.approve.mockRejectedValueOnce(
      Object.assign(new Error("Draft cannot be approved: PRECHECK_DENIED"), {
        code: "CONFLICT",
      })
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(one(container, "[data-golive-conflict]").textContent).toBe(
      "The decision was not recorded. The draft cannot be approved: the dry pre-check (web final gate) denied the order."
    );
    expect(document.body.textContent).not.toContain("PRECHECK_DENIED");
    // The reloaded row now carries the blocker and Approve is disabled.
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(button(row, "Approve SPY 2026-12-18").disabled).toBe(true);
    expect(texts(row, "[data-golive-blockers] li")).toEqual([
      "The dry pre-check (web final gate) denied the order",
    ]);
    // Opening a decision again clears the message.
    await click(button(container, "Reject SPY 2026-12-18"));
    expect(container.querySelector("[data-golive-conflict]")).toBeNull();
  });

  it("makes the page inert and Reload unusable while the dialog is open", async () => {
    const gateway = gatewayOf(queue());
    const container = await mount(gateway);
    const page = one(container, "[data-golive-page]");
    expect(page.hasAttribute("inert")).toBe(false);
    await click(button(container, "Approve SPY 2026-12-18"));
    expect(page.hasAttribute("inert")).toBe(true);
    const dialog = one(document, "[role='dialog']");
    expect(page.contains(dialog)).toBe(false);
    expect(button(container, "Reload queue").disabled).toBe(true);
    await click(button(container, "Reload queue"));
    expect(gateway.queue).toHaveBeenCalledTimes(1);
    await click(button(dialog, "Cancel"));
    expect(page.hasAttribute("inert")).toBe(false);
    expect(button(container, "Reload queue").disabled).toBe(false);
  });

  it("names the dialog, describes it with the not-sent sentence and returns focus on Cancel", async () => {
    const container = await mount(gatewayOf(queue()));
    const approve = button(container, "Approve SPY 2026-12-18");
    approve.focus();
    await click(approve);
    const dialog = one(document, "[role='dialog']");
    expect(
      one(
        document,
        `#${CSS.escape(dialog.getAttribute("aria-describedby") ?? "")}`
      ).textContent
    ).toBe(APPROVAL_NOT_SENT_SENTENCE);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await click(button(dialog, "Cancel"));
    await settle();
    expect(document.activeElement).toBe(
      button(container, "Approve SPY 2026-12-18")
    );
  });

  it("moves focus to the draft row when the decision removed the button that opened the dialog", async () => {
    const gateway = gatewayOf(
      queue(),
      queue({ drafts: [draft({ decidedAt: AT, state: "approved" })] })
    );
    gateway.approve.mockResolvedValueOnce(
      draft({ decidedAt: AT, state: "approved" })
    );
    const container = await mount(gateway);
    const approve = button(container, "Approve SPY 2026-12-18");
    approve.focus();
    await click(approve);
    await click(button(document, "Record approval"));
    await settle();
    expect(document.activeElement).toBe(
      one(container, "[data-golive-draft='draft-spy']")
    );
  });

  it("opens the reject dialog on the note and links the missing-note error to it", async () => {
    const container = await mount(gatewayOf(queue()));
    await click(button(container, "Reject SPY 2026-12-18"));
    const dialog = one(document, "[data-golive-dialog='reject']");
    const note = one(dialog, "textarea") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(note);
    expect(note.hasAttribute("aria-describedby")).toBe(false);
    expect(one(dialog, "[data-golive-not-sent]").textContent).toBe(
      "This records your rejection with the note. It changes no order."
    );
    await click(button(dialog, "Record rejection"));
    const error = one(dialog, "[role='alert']");
    expect(error.textContent).toBe(REJECT_NOTE_REQUIRED);
    expect(note.getAttribute("aria-describedby")).toBe(error.id);
    await type(note, "No.");
    expect(note.hasAttribute("aria-describedby")).toBe(false);
  });

  it("renders equal lines without a duplicate React key", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const twoEqualLegs = {
        ...ORDER,
        legs: [ORDER.legs[0], ORDER.legs[0]].filter((leg) => leg !== undefined),
      };
      const container = await mount(
        gatewayOf(
          queue({
            drafts: [
              draft({
                order: twoEqualLegs,
                preCheck: {
                  enginePolicy: "not_evaluated_not_in_web_order_path",
                  webFinalGate: {
                    decision: "allow",
                    jevStance: null,
                    jevState: "none",
                    maxLoss: 470,
                    maxLossPct: 0.47,
                    reasons: ["Same reason", "Same reason"],
                    structure: "debit-vertical",
                  },
                },
                signalFacts: ["VIX 19.5", "VIX 19.5"],
              }),
            ],
          })
        )
      );
      await click(button(container, "Approve SPY 2026-12-18"));
      expect(texts(document, "[aria-label='Order legs'] li")).toHaveLength(2);
      expect(
        errors.mock.calls.filter((call) => String(call[0]).includes("same key"))
      ).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("lists an entry draft without an entry basis under Other drafts with Approve disabled", async () => {
    const container = await mount(
      gatewayOf(queue({ drafts: [draft({ entryBasis: null })] }))
    );
    expect(texts(container, "[data-golive-group] > h3")).toEqual([
      "Entry signal today",
      "Model holds, account does not (late entry not tested, cannot be approved)",
      "Other drafts (cannot be approved)",
    ]);
    const row = one(
      container,
      "[data-golive-group='golive-group-other'] [data-golive-draft='draft-spy']"
    );
    expect(button(row, "Approve SPY 2026-12-18").disabled).toBe(true);
    expect(texts(row, "[data-golive-blockers] li")).toEqual([
      "The draft has no entry basis recorded, so it is not tied to a tested entry",
    ]);
  });

  it("keeps Approve disabled under the cannot-be-approved heading even when the server lists no blocker", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          drafts: [draft({ entryBasis: "model_holds_account_does_not" })],
        })
      )
    );
    const row = one(
      container,
      "[data-golive-group='golive-group-model-holds'] [data-golive-draft='draft-spy']"
    );
    expect(button(row, "Approve SPY 2026-12-18").disabled).toBe(true);
    expect(texts(row, "[data-golive-blockers] li")).toEqual([
      "Late entry is not in the backtest",
    ]);
  });

  it("renders a plan link only for an https URL, with noreferrer noopener", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          plan: plan({
            evidenceUrl: "javascript:alert(1)",
            ownerMessageUrl: "https://discord.com/channels/1/2/3",
          }),
        })
      )
    );
    const links = [
      ...one(container, "[data-golive-plan='approved']").querySelectorAll("a"),
    ];
    expect(links.map((link) => link.textContent)).toEqual(["Owner message"]);
    expect(links[0]?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(container.innerHTML).not.toContain("javascript:");
  });

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
