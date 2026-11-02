import { Button } from "@darkfactory/ui";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedReview,
  AgentRun,
  PortfolioSnapshot,
  ProjectionContinuity,
  StrategySpec,
} from "@darkfactory/api/vertex";
import type {
  DecisionInbox,
  ExperienceScope,
  ImmutableArtifact,
} from "./ports.ts";

// Source-authored regression scenarios only. No provider, broker or runtime is opened.
const hooks = vi.hoisted(() => {
  const states: Array<{ value: unknown }> = [];
  let index = 0;
  return {
    begin: () => {
      index = 0;
      return;
    },
    clear: () => {
      states.length = 0;
      index = 0;
      return;
    },
    useState: <Value,>(initial: Value | (() => Value)) => {
      const slot = index++;
      states[slot] ??= {
        value:
          typeof initial === "function" ? (initial as () => Value)() : initial,
      };
      return [
        states[slot]!.value as Value,
        (next: Value | ((previous: Value) => Value)) => {
          states[slot]!.value =
            typeof next === "function"
              ? (next as (previous: Value) => Value)(
                  states[slot]!.value as Value
                )
              : next;
          return;
        },
      ] as const;
    },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useMemo: <Value,>(factory: () => Value) => factory(),
  useId: () => "synthetic-search-id",
}));

import {
  PortfolioCollection,
  PortfolioContinuity,
  PortfolioObservation,
  PortfolioReadResult,
  PortfolioWorkspace,
} from "./portfolio.tsx";
import { TodayDecisionInbox, TodayWorkspace } from "./today.tsx";
import { ResourcePanel, ScopeChooser } from "./shared.tsx";
import {
  classifyVertexFailure,
  VertexReadError,
} from "../../components/research/vertex-client.ts";

const hash = "a".repeat(64);
const asOf = "2026-09-22T12:00:00.000000001Z";
const received = "2026-09-22T12:00:00.000000002Z";
const evaluated = "2026-09-22T12:00:00.000000003Z";
const scope: ExperienceScope = {
  accountAlias: "synthetic-private-alias",
  environment: "paper",
};
const continuity: ProjectionContinuity = {
  ...scope,
  streamId: "synthetic-private-stream",
  ownerEpoch: "9007199254740993",
  highWaterSequence: "9007199254740993",
  highWaterEventHash: hash,
  lastOccurredAt: asOf,
  lastReceivedAt: received,
  evaluatedAt: evaluated,
  freshness: {
    status: "fresh",
    observedAt: asOf,
    evaluatedAt: evaluated,
    maxAgeMs: 1000,
  },
  state: "continuous",
  expectedNextSequence: "9007199254740994",
  receivedSequence: null,
  newRiskInhibited: true,
  authoritative: false,
};
const snapshot: PortfolioSnapshot = {
  schemaVersion: "1.0.0",
  snapshotId: "synthetic-snapshot",
  ...scope,
  streamId: continuity.streamId,
  ownerEpoch: continuity.ownerEpoch,
  sequence: continuity.highWaterSequence,
  sourceEventHash: hash,
  sourceKind: "paper-simulation",
  asOfAt: asOf,
  receivedAt: received,
  currency: "USD",
  cash: null,
  netAssetValue: "0",
  positions: [
    {
      instrumentId: "synthetic-instrument",
      quantity: "9007199254740993.000000001",
      marketValue: null,
      costBasis: null,
      currency: "USD",
      priceAsOf: null,
      sleeveId: null,
    },
  ],
  lots: [],
  reservations: [],
  sleeveAllocations: [],
  continuity,
  observationOnly: true,
  executionAuthorized: false,
  researchNotionalIncluded: false,
};
const strategy: ImmutableArtifact<StrategySpec> = {
  artifactId: "synthetic-immutable-strategy-1",
  sha256: hash,
  value: {
    schemaVersion: "1.0.0",
    strategyId: "synthetic-strategy",
    version: "1.0.0",
    sleeve: "quant",
    hypothesis: "Synthetic regression fixture",
    universe: ["synthetic-instrument"],
    signalSchedule: {
      calendar: "XNYS",
      timezone: "UTC",
      interval: "bar-close",
    },
    entryRules: [
      {
        ruleId: "entry",
        featureId: "close",
        operator: "gt",
        threshold: "1",
        lookbackBars: 1,
      },
    ],
    exitRules: [
      {
        ruleId: "exit",
        featureId: "close",
        operator: "lt",
        threshold: "1",
        lookbackBars: 1,
      },
    ],
    riskLimits: {
      maximumLoss: "1",
      maximumNotional: "987654321.123456789",
      maximumPositions: 1,
    },
    requiredData: [
      {
        kind: "candles",
        maximumAgeMs: 1000,
        pointInTimeRequired: true,
        entitlementPolicyId: "synthetic-policy",
      },
    ],
    costModel: {
      commissionPerUnit: "0",
      spreadBps: "0",
      slippageBps: "0",
      borrowAnnualBps: "0",
      impactModel: "fixed-bps",
      maximumParticipationBps: "1",
    },
    codeDigest: hash,
  },
};
const agent: ImmutableArtifact<AgentRun> = {
  artifactId: "synthetic-private-agent",
  sha256: hash,
  value: {
    schemaVersion: "1.0.0",
    runId: "synthetic-run",
    agentRole: "research",
    taskContract: "synthetic-task",
    allowedTools: ["read-evidence"],
    modelVersion: null,
    inputEvidenceIds: [],
    outputArtifactIds: [],
    tokenBudget: 0,
    costBudgetUsd: "0",
    status: "blocked",
    errors: [{ code: "permission-denied", retryable: false }],
    approvalRequests: [
      { requestId: "synthetic-approval", kind: "research-review" },
    ],
    executionAuthorized: false,
  },
};
const review: AcceptedReview = {
  schemaVersion: "1.0.0",
  reviewId: "synthetic-review",
  ...scope,
  collectionId: null,
  artifactId: strategy.artifactId,
  artifactSha256: hash,
  reviewVersion: "1.0.0",
  decision: "accepted",
  purpose: "research",
  actorId: "synthetic-actor",
  reviewedAt: asOf,
  expiresAt: "2026-09-22T13:00:00Z",
  policyVersion: "1.0.0",
  strategyVersion: strategy.artifactId,
  supersedesReviewId: null,
  executionAuthorized: false,
};
const inbox: DecisionInbox = {
  strategies: [strategy],
  agents: [agent],
  reviews: [],
  continuity: { status: "available", continuity },
};

type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly type?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly href?: string;
  readonly scope?: ExperienceScope;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly onClick?: () => void;
  readonly onSelect?: (value: ExperienceScope) => void;
  readonly onRetire?: () => void;
}>;
const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  const children: Interactive[] = [];
  Children.forEach(node.props.children, (child) => {
    children.push(...elements(child));
    return;
  });
  return [node, ...children];
};
const render = (component: () => ReactNode): ReactNode => {
  hooks.begin();
  return component();
};
const markup = (node: ReactNode): string => {
  hooks.clear();
  return renderToStaticMarkup(node);
};
const click = (tree: ReactNode, label: string): void => {
  const button = elements(tree).find(
    (node) =>
      (node.type === "button" || node.type === Button) &&
      node.props.children === label
  );
  expect(button?.props.disabled).not.toBe(true);
  expect(button?.props.onClick).toBeTypeOf("function");
  button?.props.onClick?.();
};

afterEach(() => {
  hooks.clear();
  vi.useRealTimers();
  return vi.restoreAllMocks();
});

describe("portfolio source truthfulness", () => {
  it("puts table explanation in named help while keeping the table and its source caption visible", () => {
    const html = markup(
      <PortfolioCollection
        title="Positions"
        description="Exact source observations, without rounding."
        rows={snapshot.positions}
        columns={[{ label: "Instrument", value: (row) => row.instrumentId }]}
        identity={(row) => row.instrumentId}
      />
    );
    const help =
      html.match(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/)?.[0] ??
      "";
    const visible = html.replace(help, "");
    const headingId = html.match(/<h2 id="([^"]+)">Positions<\/h2>/)?.[1];
    expect(headingId).toBeTruthy();
    expect(html).toContain('aria-label="About Positions"');
    expect(html.match(/popovertarget="([^"]+)"/i)?.[1]).toBe(
      `${headingId}-help`
    );
    expect(help).toContain("Exact source observations, without rounding.");
    expect(visible).not.toContain(
      "Exact source observations, without rounding."
    );
    expect(visible).toContain(`aria-labelledby="${headingId}"`);
    expect(visible).toContain(
      "<caption>Positions — exact source values; no calculated totals</caption>"
    );
    expect(visible).toContain("<td>synthetic-instrument</td>");
    expect(visible).toContain("1 supplied");
    return expect(visible).not.toContain("<details");
  });

  it("keeps critical portfolio source, uncertainty and authority states outside help", () => {
    const html = markup(
      <PortfolioObservation
        snapshot={{
          ...snapshot,
          continuity: {
            ...continuity,
            state: "stale",
            freshness: { ...continuity.freshness, status: "stale" },
          },
          reservations: [
            {
              reservationId: "synthetic-reservation",
              submissionKey: "synthetic-submission",
              instrumentId: null,
              cashAmount: "7",
              shareQuantity: "0",
              currency: "USD",
              state: "unknown",
              sourceEventId: "synthetic-event",
              authoritative: false,
            },
          ],
        }}
      />
    );
    const help = Array.from(
      html.matchAll(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/g),
      (match) => match[0]
    );
    expect(help).toHaveLength(4);
    const visible = help.reduce(
      (remaining, disclosure) => remaining.replace(disclosure, ""),
      html
    );
    for (const critical of [
      "observation only",
      "PAPER-SIMULATION observations only",
      "not broker-paper holdings or live balances",
      "stale · freshness: stale",
      "Values are historical observations",
      "Current balances are unconfirmed",
      "Unknown — not supplied",
      "New risk is blocked",
      "This projection has no reservation authority",
      "Cash is not available or spendable cash",
      "Research and Quant Lab notional are excluded from NAV",
      "quantities are observations, never sizing recommendations",
      "Nonauthoritative native-owner projections",
      "do not grant spending permission",
      "This view cannot reserve, release, reconcile or submit",
      "Allocations neither create funds nor authorize spending",
      "This does not establish zero exposure",
      "<td>unknown</td>",
      "9007199254740993.000000001",
    ]) {
      expect(visible).toContain(critical);
    }
    expect(help.join("")).toContain(
      "Individual source lots remain separate from position totals"
    );
    expect(help.join("")).toContain(
      "No tax or realized-profit calculation is performed"
    );
    return expect(visible).not.toContain(
      "No tax or realized-profit calculation is performed"
    );
  });

  it("never hides unavailable source or research no-live-NAV warnings in table help", () => {
    for (const observation of [
      { ...snapshot, sourceKind: "source-unavailable" as const, positions: [] },
      {
        ...snapshot,
        environment: "research" as const,
        sourceKind: "broker-observation" as const,
        netAssetValue: null,
        continuity: { ...continuity, environment: "research" as const },
      },
    ]) {
      const html = markup(<PortfolioObservation snapshot={observation} />);
      const visible = html.replace(
        /<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/g,
        ""
      );
      if (observation.sourceKind === "source-unavailable") {
        expect(visible).toContain("Portfolio source unavailable");
        expect(visible).toContain(
          "Empty collections and unknown values are not zero"
        );
      } else {
        expect(visible).toContain("Research observations — no live NAV");
        expect(visible).toContain("Not applicable — research has no live NAV");
      }
    }
  });

  it("keeps unknown separate from zero and preserves decimal, nanosecond and sequence strings", () => {
    const html = markup(<PortfolioObservation snapshot={snapshot} />);
    expect(html).toContain("Unknown — not supplied");
    expect(html).toContain("Net asset value (USD)</dt><dd>0</dd>");
    expect(html).toContain("9007199254740993.000000001");
    expect(html).toContain(asOf);
    expect(html).toContain(received);
    expect(html).toContain(evaluated);
    expect(html).toContain("9007199254740994");
    expect(html).toContain(hash);
    expect(html).toContain("PAPER-SIMULATION observations only");
    expect(html).toContain("Cash is not available or spendable cash");
    return expect(html).not.toContain("9,007,199");
  });

  it("labels empty collections without asserting a zero portfolio or spending permission", () => {
    const html = markup(
      <PortfolioObservation
        snapshot={{ ...snapshot, positions: [], netAssetValue: null }}
      />
    );
    for (const collection of [
      "positions",
      "lots",
      "reservation projections",
      "sleeve allocations",
    ]) {
      expect(html).toContain(`No ${collection} supplied`);
    }
    expect(html).toContain("This does not establish zero exposure");
    expect(html).toContain("Nonauthoritative native-owner projections");
    expect(html).toContain("do not grant spending permission");
    return expect(html).not.toContain("<dd>0</dd>");
  });

  it("keeps research and Quant Lab notional isolated from live NAV", () => {
    const research: PortfolioSnapshot = {
      ...snapshot,
      environment: "research",
      sourceKind: "broker-observation",
      netAssetValue: null,
      continuity: { ...continuity, environment: "research" },
    };
    const html = markup(<PortfolioObservation snapshot={research} />);
    expect(html).toContain("Research observations — no live NAV");
    expect(html).toContain("Not applicable — research has no live NAV");
    expect(html).toContain(
      "Research and Quant Lab notional are excluded from NAV"
    );
    expect(html).not.toContain(strategy.value.riskLimits.maximumNotional);
    const live = markup(
      <PortfolioObservation
        snapshot={{
          ...snapshot,
          environment: "live",
          sourceKind: "broker-observation",
          netAssetValue: "11.000000001",
          continuity: { ...continuity, environment: "live" },
        }}
      />
    );
    expect(live).toContain("11.000000001");
    expect(live).toContain("Observed cash and live NAV");
    return expect(live).not.toContain(
      strategy.value.riskLimits.maximumNotional
    );
  });

  it("renders each continuity failure distinctly and keeps missing high-water evidence unknown", () => {
    for (const state of [
      "empty",
      "gap",
      "stale",
      "epoch-mismatch",
      "unavailable",
    ] as const) {
      const html = markup(
        <PortfolioContinuity
          continuity={{
            ...continuity,
            state,
            highWaterEventHash: null,
            lastOccurredAt: null,
            lastReceivedAt: null,
          }}
        />
      );
      expect(html).toContain(state);
      expect(html).toContain("Unknown — not supplied");
      expect(html).toContain(
        "This projection has no reservation authority. New risk is blocked."
      );
      expect(html).toContain(
        "Only the native owner can establish reservation authority."
      );
    }
    return expect(
      markup(
        <PortfolioContinuity
          continuity={{
            ...continuity,
            state: "gap",
            receivedSequence: "9007199254740998",
          }}
        />
      )
    ).toContain("9007199254740998");
  });

  it("distinguishes unavailable capability, source and record from an empty successful read", () => {
    for (const reason of [
      "capability-disabled",
      "source-unavailable",
      "not-found",
    ] as const) {
      const html = markup(
        <PortfolioReadResult
          result={{ status: "unavailable", reason, executionAuthorized: false }}
          scope={scope}
        />
      );
      expect(html).toContain("Portfolio unavailable");
      expect(html).toContain(reason);
      expect(html).not.toContain("No positions supplied");
    }
    const html = markup(
      <PortfolioReadResult
        result={{
          status: "available",
          snapshot: { ...snapshot, positions: [] },
        }}
        scope={scope}
      />
    );
    expect(html).toContain("No positions supplied");
    return expect(html).not.toContain("Portfolio unavailable");
  });

  it("withholds a mismatched scope instead of displaying another account's observation", () => {
    const html = markup(
      <PortfolioReadResult
        result={{
          status: "available",
          snapshot: { ...snapshot, accountAlias: "other-private-account" },
        }}
        scope={scope}
      />
    );
    expect(html).toContain("Portfolio scope mismatch");
    expect(html).not.toContain("other-private-account");
    return expect(html).not.toContain(snapshot.snapshotId);
  });

  it("does not derive spendable cash from reservations or sleeve allocations", () => {
    const html = markup(
      <PortfolioObservation
        snapshot={{
          ...snapshot,
          cash: "80",
          netAssetValue: "100",
          reservations: [
            {
              reservationId: "synthetic-reservation",
              submissionKey: "synthetic-submission",
              instrumentId: null,
              cashAmount: "7",
              shareQuantity: "0",
              currency: "USD",
              state: "unknown",
              sourceEventId: "synthetic-event",
              authoritative: false,
            },
          ],
          sleeveAllocations: [
            {
              sleeveId: "synthetic-sleeve",
              allocatedAmount: "31",
              currency: "USD",
              sourceEventId: "synthetic-event",
              authoritative: false,
            },
          ],
        }}
      />
    );
    expect(html).toContain("<dd>80</dd>");
    expect(html).toContain("<dd>100</dd>");
    expect(html).toContain("<td>unknown</td>");
    expect(html).not.toContain("<dd>73</dd>");
    expect(html).not.toContain("<dd>131</dd>");
    return expect(html).toContain("no calculated totals");
  });

  it("bounds collection rendering and resets paging when search changes", () => {
    const rows = Array.from({ length: 53 }, (_, index) => ({
      id: `fixture-${index}`,
    }));
    const page = () =>
      PortfolioCollection({
        title: "Positions",
        description: "Synthetic fixture",
        rows,
        columns: [{ label: "Identity", value: (row) => row.id }],
        identity: (row) => row.id,
      });
    let tree = render(page);
    expect(elements(tree).filter((node) => node.type === "td")).toHaveLength(
      25
    );
    click(tree, "Next");
    tree = render(page);
    expect(renderToStaticMarkup(tree)).toContain("fixture-25");
    expect(renderToStaticMarkup(tree)).not.toContain("<td>fixture-0</td>");
    elements(tree)
      .find((node) => node.type === "input")
      ?.props.onChange?.({ target: { value: "fixture-52" } });
    tree = render(page);
    expect(elements(tree).filter((node) => node.type === "td")).toHaveLength(1);
    expect(renderToStaticMarkup(tree)).toContain("Page 1 of 1");
    elements(tree)
      .find((node) => node.type === "input")
      ?.props.onChange?.({ target: { value: "missing" } });
    tree = render(page);
    expect(renderToStaticMarkup(tree)).toContain("No matching observations");
    click(tree, "Clear search");
    return expect(
      elements(render(page)).filter((node) => node.type === "td")
    ).toHaveLength(25);
  });

  return it("retires selected private children as soon as either scope form changes", () => {
    for (const workspace of [PortfolioWorkspace, TodayWorkspace]) {
      hooks.clear();
      let tree = render(workspace);
      const picker = elements(tree).find((node) => node.type === ScopeChooser);
      expect(
        elements(tree).some((node) => node.props.scope !== undefined)
      ).toBe(false);
      picker?.props.onSelect?.(scope);
      tree = render(workspace);
      const selected = elements(tree).find(
        (node) => node.props.scope !== undefined
      );
      expect(selected?.props.scope).toEqual(scope);
      expect(selected?.key).toBe(JSON.stringify(scope));
      elements(tree)
        .find((node) => node.type === ScopeChooser)
        ?.props.onRetire?.();
      tree = render(workspace);
      expect(
        elements(tree).some((node) => node.props.scope !== undefined)
      ).toBe(false);
    }
  });
});

describe("Today decision inbox", () => {
  it("combines actionable sources and exposes only static nonsecret destination fragments", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-22T12:30:00Z");
    const tree = render(() =>
      TodayDecisionInbox({
        inbox: {
          ...inbox,
          continuity: {
            status: "available",
            continuity: { ...continuity, state: "gap" },
          },
        },
        scope,
      })
    );
    const links = elements(tree)
      .filter((node) => node.type === "a")
      .map((node) => node.props.href);
    expect(links).toEqual([
      "/agents#approval-requests",
      "/agents#blocked-runs",
      "/strategies#review-queue",
      "/portfolio#continuity",
    ]);
    for (const href of links) {
      expect(href).not.toContain(scope.accountAlias);
      expect(href).not.toContain(strategy.artifactId);
      expect(href).not.toContain(agent.artifactId);
    }
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Immutable strategy version");
    expect(html).toContain(strategy.artifactId);
    return expect(html).not.toContain(
      strategy.value.riskLimits.maximumNotional
    );
  });

  it("requires exact artifact, hash, immutable strategy version, scope and unexpired research decision", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-22T12:30:00Z");
    const renderReview = (value: AcceptedReview) =>
      markup(
        <TodayDecisionInbox
          inbox={{ ...inbox, agents: [], reviews: [value] }}
          scope={scope}
        />
      );
    expect(renderReview(review)).toContain("No pending items supplied");
    for (const changed of [
      { artifactId: "different-artifact" },
      { artifactSha256: "b".repeat(64) },
      { strategyVersion: strategy.value.version },
      { accountAlias: "different-account" },
      { environment: "live" as const },
      { purpose: "paper-simulation" as const },
      { expiresAt: "2026-09-22T12:30:00Z" },
      { reviewedAt: "2026-09-22T12:31:00Z" },
    ]) {
      expect(renderReview({ ...review, ...changed })).toContain(
        "exact-version review needed"
      );
    }
    return expect(renderReview({ ...review, decision: "rejected" })).toContain(
      "No pending items supplied"
    );
  });

  it("does not count ordinary running/completed work or continuous projection as pending decisions", () => {
    const html = markup(
      <TodayDecisionInbox
        inbox={{
          strategies: [],
          reviews: [],
          agents: [
            {
              ...agent,
              value: {
                ...agent.value,
                status: "running",
                errors: [],
                approvalRequests: [],
              },
            },
          ],
          continuity: inbox.continuity,
        }}
        scope={scope}
      />
    );
    expect(html).toContain("No pending items supplied");
    expect(html).not.toContain("matching items");
    return expect(html).toContain("does not confirm portfolio status");
  });

  it("keeps unavailable and empty continuity actionable without fabricating a balance", () => {
    const missing = markup(
      <TodayDecisionInbox
        inbox={{
          strategies: [],
          agents: [],
          reviews: [],
          continuity: {
            status: "unavailable",
            reason: "capability-disabled",
            executionAuthorized: false,
          },
        }}
        scope={scope}
      />
    );
    expect(missing).toContain("Continuity unavailable");
    expect(missing).toContain("capability-disabled");
    const empty = markup(
      <TodayDecisionInbox
        inbox={{
          strategies: [],
          agents: [],
          reviews: [],
          continuity: {
            status: "available",
            continuity: {
              ...continuity,
              state: "empty",
              highWaterSequence: "0",
              highWaterEventHash: null,
            },
          },
        }}
        scope={scope}
      />
    );
    expect(empty).toContain("Continuity: empty");
    return expect(empty).not.toContain("No pending items supplied");
  });

  return it("filters actionable kinds and distinguishes filtered-empty from an empty source", () => {
    let tree = render(() => TodayDecisionInbox({ inbox, scope }));
    elements(tree)
      .find((node) => node.type === "select")
      ?.props.onChange?.({ target: { value: "blocked" } });
    tree = render(() => TodayDecisionInbox({ inbox, scope }));
    expect(
      elements(tree)
        .filter((node) => node.type === "tbody")
        .flatMap((body) => elements(body).filter((node) => node.type === "tr"))
    ).toHaveLength(1);
    expect(renderToStaticMarkup(tree)).toContain("research: blocked");
    elements(tree)
      .find((node) => node.type === "input")
      ?.props.onChange?.({ target: { value: "does-not-exist" } });
    tree = render(() => TodayDecisionInbox({ inbox, scope }));
    expect(renderToStaticMarkup(tree)).toContain("No matching decisions");
    click(tree, "Clear filters");
    tree = render(() => TodayDecisionInbox({ inbox, scope }));
    return expect(
      elements(tree)
        .filter((node) => node.type === "tbody")
        .flatMap((body) => elements(body).filter((node) => node.type === "tr"))
    ).toHaveLength(3);
  });
});

describe("shared observation read states", () => {
  it("never renders private observations while idle, loading, denied, expired or failed", () => {
    const child = vi.fn(() => <p>private-observation-marker</p>);
    expect(
      markup(
        <ResourcePanel state={{ type: "idle" }} title="Portfolio">
          {child}
        </ResourcePanel>
      )
    ).toContain("No portfolio selected");
    expect(
      markup(
        <ResourcePanel state={{ type: "loading" }} title="Portfolio">
          {child}
        </ResourcePanel>
      )
    ).toContain("Reading portfolio");
    for (const kind of [
      "denied",
      "unauthorized",
      "unavailable",
      "malformed",
      "suspended",
      "error",
    ] as const) {
      const state = {
        type: "error" as const,
        failure: classifyVertexFailure(new VertexReadError(kind)),
      };
      const html = markup(
        <ResourcePanel state={state} title="Portfolio" retry={() => undefined}>
          {child}
        </ResourcePanel>
      );
      expect(html).toContain(state.failure.title);
      expect(html).not.toContain("private-observation-marker");
      if (kind === "denied") {
        expect(html).toContain("/account");
        expect(html).not.toContain("Retry read");
      }
      if (kind === "unauthorized" || kind === "suspended") {
        expect(html).toContain("/dashboard");
        expect(html).not.toContain("Retry read");
      }
    }
    return expect(child).not.toHaveBeenCalled();
  });

  return it("wires an explicit read retry rather than any job or execution command", () => {
    const retry = vi.fn();
    const tree = ResourcePanel({
      state: {
        type: "error",
        failure: classifyVertexFailure(new VertexReadError("unavailable")),
      },
      title: "Decision inbox",
      retry,
      children: () => null,
    });
    click(tree, "Retry read");
    return expect(retry).toHaveBeenCalledOnce();
  });
});
