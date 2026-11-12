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
  APPROVED_ORDER_NOT_SHOWN,
  CURRENT_PRECHECK_LABEL,
  CURRENT_QUOTE_LABEL,
  CURRENT_SIZING_LABEL,
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
  approvedRoom: null,
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
  revision: 3,
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

const coded = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const forbidden = (message = "Forbidden"): Error => coded("FORBIDDEN", message);

/** A promise the test settles by hand, for an answer that arrives late. */
const deferred = <Value,>(): Readonly<{
  promise: Promise<Value>;
  reject: (error: unknown) => void;
  resolve: (value: Value) => void;
}> => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
};

/** A value a newer server could answer and this build does not know. */
const future = <Value,>(raw: string): Value => raw as unknown as Value;

const unauthorized = (): Error =>
  coded("UNAUTHORIZED", "Authentication required");

// Radix gives focus back in a timer after the dialog has unmounted.
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// The page clock of the tests: the time the queue on screen was loaded.
const mount = async (
  gateway?: GoLiveDraftsGateway,
  clock: () => Date = () => AT
): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      gateway === undefined ? (
        <GoLiveDraftQueue />
      ) : (
        <GoLiveDraftQueue clock={clock} gateway={gateway} />
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

/**
 * Reload and a row button clicked before React has rendered the reload: the one way a queue
 * answer can arrive behind an open dialog (the row buttons are disabled once the load shows).
 */
const reloadThenOpen = (container: HTMLElement, name: string): Promise<void> =>
  act(async () => {
    button(container, "Reload queue").click();
    button(container, name).click();
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

  it("shows a failed load in plain words, never the browser's text, and retries", async () => {
    const gateway = gatewayOf(new TypeError("Failed to fetch"), queue());
    const container = await mount(gateway);
    expect(one(container, "[role='alert']").textContent).toBe(
      "Order drafts unavailable. No answer came back from the server (network failure or timeout). A load only reads: it recorded nothing."
    );
    expect(container.textContent).not.toContain("Failed to fetch");
    await click(button(container, "Retry now"));
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(
      container.querySelector("[data-golive-plan='approved']")
    ).not.toBeNull();
  });

  it("shows the server detail of a storage error after the plain sentence", async () => {
    const container = await mount(
      gatewayOf(
        coded(
          "STORAGE_ERROR",
          "Draft d1 has equal strikes. Write the plan again with scripts/golive/seed-plan.ts"
        )
      )
    );
    expect(one(container, "[role='alert']").textContent).toBe(
      "Order drafts unavailable. The draft store could not be read. Server detail: Draft d1 has equal strikes. Write the plan again with scripts/golive/seed-plan.ts. A load only reads: it recorded nothing."
    );
    expect(container.textContent).not.toContain("STORAGE_ERROR");
  });

  it.each([
    ["BAD_REQUEST", "Input validation failed"],
    ["NOT_FOUND", "Record not found"],
    ["INTERNAL_SERVER_ERROR", "Internal server error"],
  ])(
    "does not show the raw text of a %s when the queue fails to load",
    async (code, message) => {
      const container = await mount(gatewayOf(coded(code, message)));
      const text = one(container, "[role='alert']").textContent ?? "";
      expect(text.startsWith("Order drafts unavailable. The server ")).toBe(
        true
      );
      expect(text).not.toContain(message);
      expect(text.endsWith(" A load only reads: it recorded nothing.")).toBe(
        true
      );
    }
  );

  it("names a missing plan record as the cause of the empty groups, and never says there is no signal", async () => {
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
      "No plan record: no proposed or approved plan is stored"
    );
    expect(texts(container, "[data-golive-status]")).toEqual([
      "Account value not available: portfolio monitor did not answer",
      `Node state unknown: the node status could not be read or was incomplete (checked 2026-11-11 10:30 ET)${NODE_DISARMED_NOTE}`,
      "The generator has not reported for 2026-11-11: it has not run yet, or its run was refused (the journal of vertex-golive-drafts.service on the rig says which).",
      "Market notes: the feature is not deployed",
    ]);
    expect(container.textContent).not.toContain("$0");
    expect(texts(container, "[data-golive-group] > h3")).toEqual([
      "Entry signal for 2026-11-11",
      "Model holds, account does not (late entry not tested, cannot be approved)",
    ]);
    expect(one(container, "#golive-group-entry-signal + p").textContent).toBe(
      "No plan record is stored, so there is no entry rule to draft from for 2026-11-11."
    );
    expect(one(container, "#golive-group-model-holds + p").textContent).toBe(
      "No plan record is stored, so there is no model position to compare with the account for 2026-11-11."
    );
    expect(container.textContent).not.toContain("No entry signal");
  });

  it("says the entry signals are not known when the generator has not reported", async () => {
    const container = await mount(
      gatewayOf(queue({ drafts: [], generatedAt: null }))
    );
    expect(one(container, "#golive-group-entry-signal + p").textContent).toBe(
      "The generator has not reported for 2026-11-11, so entry signals are not known."
    );
    expect(one(container, "#golive-group-model-holds + p").textContent).toBe(
      "The generator has not reported for 2026-11-11, so it is not known whether the model holds a position the account does not."
    );
    expect(container.textContent).not.toContain("No entry signal");
    expect(container.textContent).not.toContain("No draft in this group");
  });

  it("says there is no entry signal only when the generator reported and wants none", async () => {
    const container = await mount(gatewayOf(queue({ drafts: [] })));
    expect(one(container, "#golive-group-entry-signal + p").textContent).toBe(
      "No entry signal for 2026-11-11 under the plan's entry rule: the generator ran at 2026-11-11 10:30 ET and reported no entry draft."
    );
    expect(one(container, "#golive-group-model-holds + p").textContent).toBe(
      "No late entry for 2026-11-11: the generator ran at 2026-11-11 10:30 ET and reported no position that the model holds and the account does not."
    );
    expect(one(container, "[data-golive-status='generator']").textContent).toBe(
      "Generator ran at 2026-11-11 10:30 ET. 0 drafts are listed for 2026-11-11, counting decided and expired drafts."
    );
  });

  it("puts the draft groups under one Drafts heading that names the order session day", async () => {
    const container = await mount(gatewayOf(queue()));
    const section = one(
      container,
      "section[aria-labelledby='golive-drafts-title']"
    );
    expect(one(section, "h2").textContent).toBe(
      "Drafts for 2026-11-11 (the order session day)"
    );
    expect(section.querySelectorAll("[data-golive-group] > h3")).toHaveLength(
      2
    );
    expect(container.querySelectorAll("[data-golive-group]")).toHaveLength(2);
    // The session day is never called "today" in the plan, the status row or the drafts. (The
    // notice says "today" about the live order screen, which is about the present day.)
    for (const part of container.querySelectorAll("section"))
      expect(part.textContent).not.toMatch(/\btoday\b/iu);
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
      "Account value: $100,000 as of 2026-11-11 10:30 ET",
      `Node running, disarmed (checked 2026-11-11 10:30 ET)${NODE_DISARMED_NOTE}`,
      "Generator ran at 2026-11-11 10:30 ET. 1 draft is listed for 2026-11-11, counting decided and expired drafts.",
      "Market notes: attached to the drafts",
    ]);
  });

  it("shows a proposed plan without links and does not offer Approve under it", async () => {
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
      "Plan proposed, not approved: no owner approval is recorded for it"
    );
    expect(block.querySelector("a")).toBeNull();
    // The server listed no blocker: the page still gates Approve on the plan status it shows.
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(button(row, "Approve SPY 2026-12-18").disabled).toBe(true);
    expect(texts(row, "[data-golive-blockers] li")).toEqual([
      "The plan is not approved: it is proposed",
    ]);
    expect(button(row, "Reject SPY 2026-12-18").disabled).toBe(false);
  });

  it("does not offer Approve for a draft of another plan version", async () => {
    const container = await mount(
      gatewayOf(queue({ drafts: [draft({ planVersion: 2 })] }))
    );
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(button(row, "Approve SPY 2026-12-18").disabled).toBe(true);
    expect(texts(row, "[data-golive-blockers] li")).toEqual([
      "The plan is not approved for this draft: it was drafted for plan plan-1 version 2, and the plan in force is plan-1 version 3",
    ]);
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
      Limit: "$2.35 debit per spread",
      "Market notes": "Breadth thrust: bullish (unverified)Rates: neutral",
      "Max loss": "$470.00 (0.47% of account)",
      "Pre-check": `Dry pre-check (web final gate; positions, kill switch and options-only gate not included): allow. Not a clearance to send.Max loss 0.47% is within 2%JEV stance used by the check: bullish (the JEV read is fresh)${ENGINE_POLICY_LINE}`,
      Quantity: "2 spreads (sized from the plan's risk per position)",
      Quote: "IBKR live, as of 2026-11-11 10:30 ET",
      "Signal facts": "VIX 19.5 on 2026-11-11",
      State: "Proposed by the generator, not decided",
      Strikes: "long $450.00 / short $455.00",
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
      "No entry signal for 2026-11-11 under the plan's entry rule: the generator ran at 2026-11-11 10:30 ET and reported no entry draft."
    );
    const row = one(
      container,
      "[data-golive-group='golive-group-model-holds'] [data-golive-draft='draft-qqq']"
    );
    expect(row.textContent).toContain(
      "Yahoo, 15 min delayed, indicative, as of 2026-11-11 10:30 ET"
    );
    // The quote of this draft is fine: the account value is what is missing.
    expect(row.textContent).toContain(
      "Limitno limit: the account value is not available"
    );
    expect(row.textContent).not.toContain("no usable quote");
    expect(row.textContent).toContain(
      "0 spreads (the account value is not available)"
    );
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
      "Approved (recorded). This page did not send it: it sends no orders."
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
      "Entry signal for 2026-11-11",
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
      "BUY 1 SPY 2026-12-18 $450.00 call",
      "SELL 1 SPY 2026-12-18 $455.00 call",
    ]);
    const order = one(dialog, "[data-golive-order]").textContent;
    expect(order).toContain("Quantity2 spreads");
    expect(order).toContain("Limit$2.35 debit per spread");
    expect(order).toContain("Max loss$470.00 (0.47% of account)");
    expect(one(dialog, "[data-golive-not-sent]").textContent).toBe(
      "This records your approval. It does not send the order. No Vertex screen can open a vertical spread on the live account today."
    );
    expect(dialog.querySelector("textarea")).toBeNull();
    expect(gateway.approve).not.toHaveBeenCalled();

    await click(button(dialog, "Record approval"));
    expect(gateway.approve).toHaveBeenCalledTimes(1);
    expect(gateway.approve).toHaveBeenCalledWith({
      confirm: true,
      id: "draft-spy",
      order: ORDER,
      revision: 3,
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

  it("keeps the dialog open on an invalid request and links the error to the Record button", async () => {
    const gateway = gatewayOf(queue());
    gateway.approve.mockRejectedValueOnce(
      coded("BAD_REQUEST", "Input validation failed: order")
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(document, "[role='dialog']");
    await click(button(dialog, "Record approval"));
    const error = one(dialog, "[data-golive-dialog-error]");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "The server refused this approval as an invalid request. Nothing was recorded."
    );
    expect(dialog.textContent).not.toContain("Input validation failed");
    expect(gateway.queue).toHaveBeenCalledTimes(1);
    const record = button(dialog, "Record approval");
    expect(record.disabled).toBe(false);
    expect(record.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("links a server error in the reject dialog to the note and to the Record button", async () => {
    const gateway = gatewayOf(queue());
    gateway.reject.mockRejectedValueOnce(unauthorized());
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    const dialog = one(document, "[data-golive-dialog='reject']");
    const note = one(dialog, "textarea") as HTMLTextAreaElement;
    await type(note, "No.");
    await click(button(dialog, "Record rejection"));
    const error = one(dialog, "[data-golive-dialog-error]");
    expect(note.getAttribute("aria-describedby")).toBe(error.id);
    expect(
      button(dialog, "Record rejection").getAttribute("aria-describedby")
    ).toBe(error.id);
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
    "closes the dialog, reloads and says only the owner decides when %s is refused to a non-owner",
    async (action) => {
      const gateway = gatewayOf(
        queue({ drafts: [draft(), lateDraft()] }),
        queue({ canDecide: false, drafts: [draft(), lateDraft()] })
      );
      gateway[action].mockRejectedValueOnce(
        forbidden("Owner (admin) access required")
      );
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
      expect(gateway.queue).toHaveBeenCalledTimes(2);
      const notice = one(container, "[data-golive-decision-notice]");
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice.textContent).toBe(
        "Only the owner can approve or reject a draft. Nothing was recorded."
      );
      // The reloaded queue says this caller cannot decide: no button is left.
      expect(container.querySelector("[data-golive-action]")).toBeNull();
      expect(container.querySelectorAll("[data-golive-draft]")).toHaveLength(2);
    }
  );

  it("shows the operator notice when a decision is refused because operator access was lost", async () => {
    const gateway = gatewayOf(queue(), forbidden("Operator access required"));
    gateway.approve.mockRejectedValueOnce(
      forbidden("Operator access required")
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Operator access required");
    expect(container.textContent).not.toContain("Only the owner");
    expect(container.querySelector("[data-golive-draft]")).toBeNull();
  });

  it("names both causes when a refused decision does not say which access is missing", async () => {
    const gateway = gatewayOf(queue(), queue());
    gateway.approve.mockRejectedValueOnce(forbidden());
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "The server refused this session: either only the owner can approve or reject a draft, or operator access was lost. Nothing was recorded."
    );
  });

  it("says no Vertex screen can open a vertical on the live account, and links the live order screen", async () => {
    const container = await mount(gatewayOf(queue()));
    const notice = one(container, "[data-golive-notice]");
    expect(notice.textContent).toBe(NO_ORDERS_NOTICE);
    expect(notice.textContent).toBe(
      "This page sends no orders. Approve records your decision and places nothing. No Vertex screen can open a vertical spread on the live account today: the live order screen (Portfolio, Vertex orders tab) has no vertical ticket and takes single option orders only (buy to open, sell to close). Placing a vertical by hand at IBKR is outside Vertex and its checks."
    );
    // The owner is not told to place an approved vertical on a Vertex screen.
    expect(notice.textContent).not.toMatch(/to place|use the|yourself/iu);
    expect(notice.textContent).not.toContain("Orders & stops");
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

  it("shows the stored approved order and the node badge read at approval, apart from the current values", async () => {
    // Approved: 2 spreads at 2.35. The live sizing has moved to 3 spreads at 2.50.
    const moved = { ...ORDER, limitPrice: 2.5, quantity: 3 };
    const container = await mount(
      gatewayOf(
        queue({
          drafts: [
            draft({
              approvedOrder: ORDER,
              // The room the approval holds is the approved order's, not the moved sizing's.
              approvedRoom: { maxLoss: 470, maxLossPctNlv: 0.47 },
              decidedAt: AT,
              decidedBy: "owner",
              nodeBadgeAtDecision: "running-disarmed",
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
      "BUY 1 SPY 2026-12-18 $450.00 callSELL 1 SPY 2026-12-18 $455.00 callQuantity: 2 spreadsLimit: $2.35 debit per spreadNode badge read at approval: Node running, disarmedRisk room held by this approval: $470.00 max loss (0.47% of account value)"
    );
    expect(one(row, "[data-golive-node-at-approval]").textContent).toBe(
      "Node badge read at approval: Node running, disarmed"
    );
    expect(one(row, "[data-golive-approved-room]").textContent).toBe(
      "Risk room held by this approval: $470.00 max loss (0.47% of account value)"
    );
    expect(facts[CURRENT_SIZING_LABEL]).toBe(
      "limit $2.50 debit per spread; quantity 3 spreads (sized from the plan's risk per position); max loss $750.00 (0.75% of account)"
    );
    // No live number has a bare label that could be read as part of the approved order.
    for (const bare of ["Limit", "Quantity", "Max loss", "Quote", "Pre-check"])
      expect(Object.keys(facts)).not.toContain(bare);
    expect(facts[CURRENT_QUOTE_LABEL]).toBe(
      "IBKR live, as of 2026-11-11 10:30 ET"
    );
    expect(facts[CURRENT_PRECHECK_LABEL]).toContain("Dry pre-check");
    expect(one(row, "[data-golive-approved-order]").textContent).not.toContain(
      "2.50"
    );
    // A list is never nested in a phrase element.
    expect(container.querySelector("span ul, p ul")).toBeNull();
  });

  it("says the answer carries no approved order instead of showing the live sizing as approved", async () => {
    const container = await mount(
      gatewayOf(
        queue({ drafts: [draft({ decidedAt: AT, state: "approved" })] })
      )
    );
    const missing = one(container, "[data-golive-approved-order='missing']");
    expect(missing.textContent).toBe(APPROVED_ORDER_NOT_SHOWN);
    expect(missing.textContent).not.toMatch(/not stored/iu);
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
      "Reload failed; showing the queue loaded 2026-11-11 10:30 ET. No answer came back from the server (network failure or timeout). A load only reads: it recorded nothing."
    );
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(row.getAttribute("data-golive-draft-state")).toBe("approved");
    expect(row.textContent).toContain(
      "Approved (recorded). This page did not send it: it sends no orders."
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
      "Order drafts unavailable. You are signed out: the session has ended. Sign in again. A load only reads: it recorded nothing."
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
      coded("CONFLICT", "Draft cannot be approved: PRECHECK_DENIED")
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "The server refused this approval: the dry pre-check (web final gate) denied the order. This attempt recorded nothing. The queue was read again: the draft is still proposed, so no decision is recorded for it."
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
    expect(container.querySelector("[data-golive-decision-notice]")).toBeNull();
  });

  it("does not say 'not recorded' when a CONFLICT follows a decision that was already recorded", async () => {
    // The first rejection was stored and its answer was lost; the retry gets CONFLICT.
    const rejected = draft({
      decidedAt: AT,
      decidedBy: "owner",
      decisionNote: "No.",
      state: "rejected",
    });
    const gateway = gatewayOf(queue(), queue({ drafts: [rejected] }));
    gateway.reject.mockRejectedValueOnce(
      coded("CONFLICT", "The draft is no longer proposed")
    );
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    await type(one(document, "textarea") as HTMLTextAreaElement, "No.");
    await click(button(document, "Record rejection"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    const notice = one(container, "[data-golive-decision-notice]").textContent;
    expect(notice).toBe(
      "The server refused this rejection: the draft was already decided or expired, or its order or plan changed after this page loaded it. This attempt recorded nothing. The queue was read again: the draft is already decided. Its state is: Rejected by the owner (recorded). Decided 2026-11-11 10:30 ET by owner."
    );
    expect(notice).not.toContain("The decision was not recorded");
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(row.getAttribute("data-golive-draft-state")).toBe("rejected");
    expect(row.querySelector("button")).toBeNull();
  });

  it("closes the dialog when the store fails after the rejection was stored, so it cannot be recorded twice", async () => {
    const rejected = draft({
      decidedAt: AT,
      decidedBy: "owner",
      decisionNote: "No.",
      state: "rejected",
    });
    const gateway = gatewayOf(queue(), queue({ drafts: [rejected] }));
    gateway.reject.mockRejectedValueOnce(
      coded(
        "STORAGE_ERROR",
        "The rejection of draft draft-spy was stored. Draft d2 has equal strikes."
      )
    );
    const container = await mount(gateway);
    await click(button(container, "Reject SPY 2026-12-18"));
    await type(one(document, "textarea") as HTMLTextAreaElement, "No.");
    await click(button(document, "Record rejection"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.reject).toHaveBeenCalledTimes(1);
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "The server answered that this rejection was stored and that its store failed afterwards. Server detail: The rejection of draft draft-spy was stored. Draft d2 has equal strikes. The queue was read again: the draft is already decided. Its state is: Rejected by the owner (recorded). Decided 2026-11-11 10:30 ET by owner."
    );
    expect(
      [...document.querySelectorAll("button")].map((node) => node.textContent)
    ).not.toContain("Record rejection");
  });

  it("says the result is not known when no answer comes back, and does not say that nothing is recorded", async () => {
    const gateway = gatewayOf(queue(), queue());
    gateway.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    const notice = one(container, "[data-golive-decision-notice]").textContent;
    // The request may still be running on the server when the reload reads "proposed".
    expect(notice).toBe(
      "No answer came back for this approval (network failure or timeout), so it is not known whether it was recorded. The queue was read again: the draft is still proposed in this read; the request may still complete. Reload before you decide again."
    );
    expect(notice).not.toContain("no decision is recorded");
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });

  it("removes the decision notice when a later reload succeeds, so it never contradicts the row", async () => {
    const approved = draft({
      approvedOrder: ORDER,
      decidedAt: AT,
      decidedBy: "owner",
      state: "approved",
    });
    // The approval did land after the first reload read "proposed".
    const gateway = gatewayOf(
      queue(),
      queue(),
      new TypeError("Failed to fetch"),
      queue({ drafts: [approved] })
    );
    gateway.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(
      one(container, "[data-golive-decision-notice]").textContent
    ).toContain("still proposed in this read");

    // A failed reload read nothing new: the notice still describes the rows on screen.
    await click(button(container, "Reload queue"));
    expect(
      container.querySelector("[data-golive-decision-notice]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-golive-reload-error]")
    ).not.toBeNull();

    await click(button(container, "Reload queue"));
    expect(container.querySelector("[data-golive-decision-notice]")).toBeNull();
    expect(container.textContent).not.toContain("still proposed");
    expect(
      one(container, "[data-golive-draft='draft-spy']").getAttribute(
        "data-golive-draft-state"
      )
    ).toBe("approved");
  });

  it("says the rows may be out of date when the reload after an unknown result fails too", async () => {
    const gateway = gatewayOf(queue(), new TypeError("Failed to fetch"));
    gateway.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "No answer came back for this approval (network failure or timeout), so it is not known whether it was recorded. The queue could not be read again, so the rows below may be out of date. Reload the queue before you decide again."
    );
  });

  it("closes the dialog and reloads when the draft is no longer in the queue of the order session day", async () => {
    // The session day rolled over: the reloaded queue is the next day's and has no such draft.
    const gateway = gatewayOf(
      queue(),
      queue({ drafts: [], tradingDay: "2026-11-12" })
    );
    gateway.approve.mockRejectedValueOnce(
      coded("NOT_FOUND", "Draft is not in the queue of trading day 2026-11-12")
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "The server did not find this draft in the queue of the order session day, so this approval recorded nothing. The queue was read again: this draft is not in the queue of 2026-11-12."
    );
  });

  it("makes the whole page, the notice link included, inert while the dialog is open", async () => {
    const gateway = gatewayOf(queue());
    const container = await mount(gateway);
    const page = one(container, "[data-golive-draft-queue]");
    expect(page.hasAttribute("inert")).toBe(false);
    await click(button(container, "Approve SPY 2026-12-18"));
    expect(page.hasAttribute("inert")).toBe(true);
    expect(page.contains(one(container, "[data-golive-notice] a"))).toBe(true);
    const dialog = one(document, "[role='dialog']");
    expect(page.contains(dialog)).toBe(false);
    expect(button(container, "Reload queue").disabled).toBe(true);
    await click(button(container, "Reload queue"));
    expect(gateway.queue).toHaveBeenCalledTimes(1);
    await click(button(dialog, "Cancel"));
    expect(page.hasAttribute("inert")).toBe(false);
    expect(button(container, "Reload queue").disabled).toBe(false);
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const container = await mount(gatewayOf(queue()));
    await click(button(container, "Approve SPY 2026-12-18"));
    const dialog = one(document, "[role='dialog']");
    const stops = [...dialog.querySelectorAll("button")];
    const first = stops[0];
    const last = stops.at(-1);
    if (first === undefined || last === undefined || first === last)
      throw new Error("the dialog has at least two buttons");
    const press = (from: HTMLElement, shiftKey: boolean): Promise<void> =>
      act(async () => {
        from.focus();
        from.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Tab",
            shiftKey,
          })
        );
      });
    await press(last, false);
    expect(document.activeElement).toBe(first);
    await press(first, true);
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
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
      "Entry signal for 2026-11-11",
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
    const gateway = gatewayOf(
      queue(),
      new TypeError("Failed to fetch"),
      queue()
    );
    const container = await mount(gateway);
    await click(button(container, "Reload queue"));
    expect(one(container, "[data-golive-reload-error]").textContent).toBe(
      "Reload failed; showing the queue loaded 2026-11-11 10:30 ET. No answer came back from the server (network failure or timeout). A load only reads: it recorded nothing."
    );
    expect(
      container.querySelector("[data-golive-draft='draft-spy']")
    ).not.toBeNull();
    await click(button(container, "Reload queue"));
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("says the page does not refresh, when it was loaded, and shows Loading… while a reload runs", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    let now = AT;
    const container = await mount(gateway, () => now);
    expect(one(container, "[data-golive-loaded]").textContent).toBe(
      "This page does not refresh on its own. Loaded 2026-11-11 10:30 ET."
    );
    expect(container.querySelector("[data-golive-loading]")).toBeNull();
    const reload = button(container, "Reload queue");
    expect(reload.disabled).toBe(false);

    await click(reload);
    expect(reload.disabled).toBe(true);
    const loading = one(container, "[data-golive-loading]");
    expect(loading.textContent).toBe("Loading…");
    expect(loading.getAttribute("role")).toBe("status");
    await click(reload);
    expect(gateway.queue).toHaveBeenCalledTimes(2);

    now = new Date("2026-11-11T16:05:00.000Z");
    await act(async () => slow.resolve(queue()));
    expect(reload.disabled).toBe(false);
    expect(container.querySelector("[data-golive-loading]")).toBeNull();
    expect(one(container, "[data-golive-loaded]").textContent).toBe(
      "This page does not refresh on its own. Loaded 2026-11-11 11:05 ET."
    );
  });

  it("disables Retry and shows Loading… while the retry runs", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(new TypeError("Failed to fetch"));
    gateway.queue.mockReturnValueOnce(slow.promise);
    const container = await mount(gateway);
    const retry = button(container, "Retry now");
    expect(retry.disabled).toBe(false);
    await click(retry);
    expect(retry.disabled).toBe(true);
    expect(one(container, "[data-golive-loading]").textContent).toBe(
      "Loading…"
    );
    await click(retry);
    expect(gateway.queue).toHaveBeenCalledTimes(2);
    await act(async () => slow.resolve(queue()));
    expect(
      container.querySelector("[data-golive-draft='draft-spy']")
    ).not.toBeNull();
  });

  it("ignores an older queue answer that arrives after a decision", async () => {
    const approved = draft({
      approvedOrder: ORDER,
      decidedAt: AT,
      decidedBy: "owner",
      state: "approved",
    });
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    gateway.queue.mockResolvedValueOnce(queue({ drafts: [approved] }));
    gateway.approve.mockResolvedValueOnce(approved);
    const container = await mount(gateway);
    // A reload is still running when the owner approves.
    await reloadThenOpen(container, "Approve SPY 2026-12-18");
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    await click(button(document, "Record approval"));
    expect(gateway.queue).toHaveBeenCalledTimes(3);
    const state = (): string | null =>
      one(container, "[data-golive-draft='draft-spy']").getAttribute(
        "data-golive-draft-state"
      );
    expect(state()).toBe("approved");
    // The older reload was abandoned when the newer load started.
    expect(gateway.queue.mock.calls[1]?.[0].signal.aborted).toBe(true);

    // Its answer still says "proposed": it must not bring the buttons back.
    await act(async () => slow.resolve(queue()));
    expect(state()).toBe("approved");
    expect(container.querySelector("[data-golive-action]")).toBeNull();
    expect(container.querySelector("[data-golive-loading]")).toBeNull();
  });

  it("ignores an older queue answer that arrives after a failed reload kept the returned draft", async () => {
    const approved = draft({
      approvedOrder: ORDER,
      decidedAt: AT,
      state: "approved",
    });
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    gateway.queue.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    gateway.approve.mockResolvedValueOnce(approved);
    const container = await mount(gateway);
    await reloadThenOpen(container, "Approve SPY 2026-12-18");
    await click(button(document, "Record approval"));
    await act(async () => slow.resolve(queue()));
    const row = one(container, "[data-golive-draft='draft-spy']");
    expect(row.getAttribute("data-golive-draft-state")).toBe("approved");
    expect(row.querySelector("button")).toBeNull();
  });

  it("sends the revision of the draft the dialog shows with the approval", async () => {
    const gateway = gatewayOf(
      queue({ drafts: [draft({ revision: 7 })] }),
      queue({ drafts: [draft({ revision: 8, state: "approved" })] })
    );
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    expect(gateway.approve).toHaveBeenCalledWith({
      confirm: true,
      id: "draft-spy",
      order: ORDER,
      revision: 7,
    });
  });

  it("shows no risk room on a draft that is not approved, and says so when an approved draft comes without it", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          drafts: [
            draft(),
            draft({
              approvedOrder: ORDER,
              decidedAt: AT,
              id: "approved",
              state: "approved",
            }),
            draft({
              approvedOrder: ORDER,
              approvedRoom: { maxLoss: 470, maxLossPctNlv: null },
              decidedAt: AT,
              id: "no-percent",
              state: "approved",
            }),
          ],
        })
      )
    );
    expect(
      one(container, "[data-golive-draft='draft-spy']").textContent
    ).not.toContain("Risk room");
    expect(
      one(
        container,
        "[data-golive-draft='approved'] [data-golive-approved-room]"
      ).textContent
    ).toBe("Risk room held by this approval: the server did not send it");
    expect(
      one(
        container,
        "[data-golive-draft='no-percent'] [data-golive-approved-room]"
      ).textContent
    ).toBe(
      "Risk room held by this approval: $470.00 max loss (% of account value not available: the account value is not available)"
    );
  });

  it("disables Approve and Reject on every row while a load runs", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    const container = await mount(gateway);
    const approve = button(container, "Approve SPY 2026-12-18");
    const reject = button(container, "Reject SPY 2026-12-18");
    expect([approve.disabled, reject.disabled]).toEqual([false, false]);
    await click(button(container, "Reload queue"));
    expect([approve.disabled, reject.disabled]).toEqual([true, true]);
    await click(approve);
    await click(reject);
    expect(document.querySelector("[role='dialog']")).toBeNull();
    await act(async () => slow.resolve(queue()));
    expect([
      button(container, "Approve SPY 2026-12-18").disabled,
      button(container, "Reject SPY 2026-12-18").disabled,
    ]).toEqual([false, false]);
  });

  it("keeps the dialog and sends the order it shows when a queue answer behind it has the same draft and order", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    gateway.queue.mockResolvedValue(queue());
    const container = await mount(gateway);
    await reloadThenOpen(container, "Approve SPY 2026-12-18");
    // The same order in new objects, as every read builds it.
    await act(async () =>
      slow.resolve(
        queue({
          drafts: [
            draft({
              order: { ...ORDER, legs: ORDER.legs.map((leg) => ({ ...leg })) },
            }),
          ],
        })
      )
    );
    await settle();
    const dialog = one(document, "[role='dialog']");
    expect(container.querySelector("[data-golive-decision-notice]")).toBeNull();
    await click(button(dialog, "Record approval"));
    expect(gateway.approve).toHaveBeenCalledWith({
      confirm: true,
      id: "draft-spy",
      order: ORDER,
      revision: 3,
    });
  });

  it.each([
    [
      "is no longer proposed",
      draft({ state: "expired" }),
      "A newer read of the queue shows that the draft is no longer proposed (Expired: the generator no longer wants this draft). The open dialog was closed and nothing was recorded.",
    ],
    [
      "has a blocker",
      draft({ notApprovable: ["PRECHECK_DENIED"] }),
      "A newer read of the queue shows that the draft can no longer be approved: the dry pre-check (web final gate) denied the order. The open dialog was closed and nothing was recorded.",
    ],
    [
      "was refreshed to another revision with the same order",
      draft({ revision: 4 }),
      "A newer read of the queue shows that the draft was refreshed after the dialog opened (it is now revision 4; the dialog showed revision 3). The open dialog was closed and nothing was recorded.",
    ],
    [
      "carries another order than the dialog shows",
      draft({
        order: { ...ORDER, limitPrice: 2.5, quantity: 3 },
        sizing: { ...draft().sizing, limitPrice: 2.5, quantity: 3 },
      }),
      "A newer read of the queue shows that the order of the draft changed and is no longer the order the dialog showed. The open dialog was closed and nothing was recorded.",
    ],
  ])(
    "closes the approve dialog when a queue answer behind it says the draft %s",
    async (_name, fresh, notice) => {
      const slow = deferred<GoLiveQueueOutput>();
      const gateway = gatewayOf(queue());
      gateway.queue.mockReturnValueOnce(slow.promise);
      const container = await mount(gateway);
      await reloadThenOpen(container, "Approve SPY 2026-12-18");
      expect(document.querySelector("[role='dialog']")).not.toBeNull();
      await act(async () => slow.resolve(queue({ drafts: [fresh] })));
      await settle();
      expect(document.querySelector("[role='dialog']")).toBeNull();
      expect(gateway.approve).not.toHaveBeenCalled();
      const shown = one(container, "[data-golive-decision-notice]");
      expect(shown.getAttribute("role")).toBe("alert");
      expect(shown.textContent).toBe(notice);
    }
  );

  it("closes the dialog when a queue answer behind it no longer lists the draft", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    const container = await mount(gateway);
    await reloadThenOpen(container, "Reject SPY 2026-12-18");
    await act(async () => slow.resolve(queue({ drafts: [] })));
    await settle();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.reject).not.toHaveBeenCalled();
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "A newer read of the queue shows that the draft is no longer in the queue. The open dialog was closed and nothing was recorded."
    );
  });

  it("keeps the reject dialog when a queue answer behind it only adds a blocker to approval", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    const container = await mount(gateway);
    await reloadThenOpen(container, "Reject SPY 2026-12-18");
    await act(async () =>
      slow.resolve(
        queue({ drafts: [draft({ notApprovable: ["PRECHECK_DENIED"] })] })
      )
    );
    await settle();
    expect(
      document.querySelector("[data-golive-dialog='reject']")
    ).not.toBeNull();
    expect(container.querySelector("[data-golive-decision-notice]")).toBeNull();
  });

  it("closes the dialog with the owner-only sentence when a queue answer behind it says the caller cannot decide", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf(queue());
    gateway.queue.mockReturnValueOnce(slow.promise);
    const container = await mount(gateway);
    await reloadThenOpen(container, "Approve SPY 2026-12-18");
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    await act(async () => slow.resolve(queue({ canDecide: false })));
    await settle();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(one(container, "[data-golive-decision-notice]").textContent).toBe(
      "Only the owner can approve or reject a draft. The open dialog was closed and nothing was recorded."
    );
    expect(container.querySelector("[data-golive-action]")).toBeNull();
  });

  it("abandons a load when the page is left and sets no state after it", async () => {
    const slow = deferred<GoLiveQueueOutput>();
    const gateway = gatewayOf();
    gateway.queue.mockReturnValueOnce(slow.promise);
    await mount(gateway);
    const signal = gateway.queue.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      expect(signal?.aborted).toBe(true);
      await act(async () => slow.resolve(queue()));
      expect(errors).not.toHaveBeenCalled();
      expect(document.querySelector("[data-golive-draft]")).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  it("does not reload after a decision that answers when the page was left", async () => {
    const slow = deferred<GoLiveDraftOutput>();
    const gateway = gatewayOf(queue());
    gateway.approve.mockReturnValueOnce(slow.promise);
    const container = await mount(gateway);
    await click(button(container, "Approve SPY 2026-12-18"));
    await click(button(document, "Record approval"));
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => slow.resolve(draft({ state: "approved" })));
    expect(gateway.queue).toHaveBeenCalledTimes(1);
  });

  it("names a value of a newer server instead of printing undefined, and does not offer Approve for it", async () => {
    const container = await mount(
      gatewayOf(
        queue({
          drafts: [
            draft({
              exitReason: future("stop_loss"),
              preCheck: {
                enginePolicy: "not_evaluated_not_in_web_order_path",
                webFinalGate: {
                  decision: future("review"),
                  jevStance: null,
                  jevState: future("paused"),
                  maxLoss: 470,
                  maxLossPct: 0.47,
                  reasons: [],
                  structure: "debit-vertical",
                },
              },
              quote: {
                ...draft().quote,
                asOf: AT,
                longAsk: 5,
                longBid: 4.9,
                shortAsk: 2.7,
                shortBid: 2.6,
                source: future("broker_x"),
              },
              sizing: { ...draft().sizing, reason: future("new_cap") },
              structure: future("ironCondor"),
            }),
            draft({ id: "paused", state: future("paused") }),
            draft({
              id: "blocked",
              notApprovable: [future("MARGIN_CALL")],
            }),
          ],
          marketNotes: future("paused"),
          node: { armedAt: null, badge: future("paused"), checkedAt: AT },
        })
      )
    );
    expect(container.textContent).not.toContain("undefined");
    for (const raw of [
      "ironCondor",
      "stop_loss",
      "review",
      "broker_x",
      "new_cap",
      "MARGIN_CALL",
    ])
      expect(container.textContent).toContain(
        `not known to this page version (${raw})`
      );
    expect(texts(container, "[data-golive-status]").slice(1)).toEqual([
      `Node state not known to this page version (paused) (checked 2026-11-11 10:30 ET)${NODE_DISARMED_NOTE}`,
      "Generator ran at 2026-11-11 10:30 ET. 3 drafts are listed for 2026-11-11, counting decided and expired drafts.",
      "Market notes: status not known to this page version (paused)",
    ]);
    for (const empty of container.querySelectorAll("dd, li, h4 span"))
      expect(empty.textContent).toMatch(/\S/u);
    // No Approve can be used on any of the three drafts.
    for (const approve of container.querySelectorAll<HTMLButtonElement>(
      "[data-golive-action='approve']"
    ))
      expect(approve.disabled).toBe(true);
    const paused = one(container, "[data-golive-draft='paused']");
    expect(paused.querySelector("button")).toBeNull();
    expect(paused.textContent).toContain(
      "Statenot known to this page version (paused)"
    );
    // The dialog title names the raw structure as well.
    await click(button(container, "Reject SPY 2026-12-18"));
    const dialog = one(document, "[role='dialog']");
    expect(
      one(
        document,
        `#${CSS.escape(dialog.getAttribute("aria-labelledby") ?? "")}`
      ).textContent
    ).toBe("Reject SPY 2026-12-18 not known to this page version (ironCondor)");
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

    // The abort signal of the page reaches the request, so leaving the page cancels the load.
    const { signal } = new AbortController();
    await expect(gateway.queue({ signal })).resolves.toEqual(queue());
    expect(api.queue).toHaveBeenCalledWith({}, { signal });
    const approval = {
      confirm: true as const,
      id: "draft-spy",
      order: ORDER,
      revision: 3,
    };
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
      "No plan record: no proposed or approved plan is stored"
    );
  });
});
