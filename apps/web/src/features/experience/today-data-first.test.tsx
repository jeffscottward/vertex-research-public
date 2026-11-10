import { Button } from "@darkfactory/ui";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, ProjectionContinuity } from "@darkfactory/api/vertex";
import type {
  DecisionInbox,
  ExperienceScope,
  ImmutableArtifact,
} from "./ports.ts";

// Synthetic source-only scenarios. No provider, broker or runtime is opened.
const hooks = vi.hoisted(() => {
  const states: Array<{ value: unknown }> = [];
  let index = 0;
  return {
    begin: () => {
      index = 0;
    },
    clear: () => {
      states.length = 0;
      index = 0;
    },
    useState: <Value,>(initial: Value | (() => Value)) => {
      const slot = index++;
      states[slot] ??= {
        value:
          typeof initial === "function" ? (initial as () => Value)() : initial,
      };
      return [
        states[slot]!.value as Value,
        (next: Value) => {
          return (states[slot]!.value = next);
        },
      ] as const;
    },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useMemo: <Value,>(factory: () => Value) => factory(),
}));

import { TodayDecisionInbox, TodayWorkspace } from "./today.tsx";
import { ScopeChooser } from "./shared.tsx";
import { SectorRotationChanges } from "../../components/portal/sector-rotation-changes.tsx";

const hash = "a".repeat(64);
const scope: ExperienceScope = {
  accountAlias: "synthetic-private-account",
  environment: "paper",
};
const at = "2026-09-22T12:00:00.000000001Z";
const continuity: ProjectionContinuity = {
  ...scope,
  streamId: "synthetic-stream",
  ownerEpoch: "9007199254740993",
  highWaterSequence: "9007199254740993",
  highWaterEventHash: hash,
  lastOccurredAt: at,
  lastReceivedAt: at,
  evaluatedAt: at,
  freshness: {
    status: "fresh",
    observedAt: at,
    evaluatedAt: at,
    maxAgeMs: 1000,
  },
  state: "continuous",
  expectedNextSequence: "9007199254740994",
  receivedSequence: null,
  newRiskInhibited: true,
  authoritative: false,
};
const agent: ImmutableArtifact<AgentRun> = {
  artifactId: "synthetic-run-artifact",
  sha256: hash,
  value: {
    schemaVersion: "1.0.0",
    runId: "synthetic-run",
    agentRole: "research",
    taskContract: "synthetic-task",
    allowedTools: [],
    modelVersion: null,
    inputEvidenceIds: [],
    outputArtifactIds: [],
    tokenBudget: 0,
    costBudgetUsd: "0",
    status: "blocked",
    errors: [{ code: "permission-denied", retryable: false }],
    approvalRequests: [
      { requestId: "synthetic-review-request", kind: "research-review" },
    ],
    executionAuthorized: false,
  },
};
const inbox: DecisionInbox = {
  strategies: [],
  agents: [agent],
  reviews: [],
  continuity: { status: "available", continuity },
};
const visibleMarkup = (value: DecisionInbox): string =>
  renderToStaticMarkup(
    <TodayDecisionInbox inbox={value} scope={scope} />
  ).replace(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/g, "");

type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly value?: string;
  readonly type?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly onSelect?: (value: ExperienceScope) => void;
  readonly onRetire?: () => void;
}>;
const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  const children: Interactive[] = [];
  Children.forEach(node.props.children, (child) => {
    return children.push(...elements(child));
  });
  return [node, ...children];
};
const render = (value = inbox): ReactNode => {
  hooks.begin();
  return TodayDecisionInbox({ inbox: value, scope });
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

afterEach(() => hooks.clear());

describe("Today data-first decision inbox", () => {
  it("associates title help with a visible, focusable decision table and keeps next actions outside help", () => {
    const html = renderToStaticMarkup(
      <TodayDecisionInbox inbox={inbox} scope={scope} />
    );
    const help =
      html.match(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/)?.[0] ??
      "";
    expect(help).toContain('id="decision-inbox-title-help"');
    expect(help).toContain('aria-labelledby="decision-inbox-title"');
    expect(help).toContain(
      "Running or completed status alone does not require a decision"
    );
    expect(html).toContain('aria-label="About Decision inbox"');
    expect(html).toMatch(/popovertarget="decision-inbox-title-help"/i);
    const visible = html.replace(help, "");
    expect(visible).toContain(
      'data-slot="table" aria-labelledby="decision-inbox-title">'
    );
    expect(visible).toContain(
      'aria-label="Decision inbox; scroll horizontally for all fields" tabindex="0"'
    );
    expect(visible).toContain(
      'data-slot="table-head" scope="col">Condition</th>'
    );
    expect(visible).toContain(
      'data-slot="table-head" scope="col">Next action</th>'
    );
    for (const text of [
      "research: blocked",
      "permission-denied",
      "not marked retryable",
      "research-review",
      "synthetic-review-request",
      agent.artifactId,
      hash,
      'href="/agents#approval-requests"',
      'href="/agents#blocked-runs"',
    ]) {
      expect(visible).toContain(text);
    }
    expect(visible).not.toContain("Running or completed status alone");
    expect(visible).not.toContain(scope.accountAlias);
    return expect(visible).not.toContain("<details");
  });

  it("keeps unavailable, withheld and stale continuity truthful without hiding risk inhibition", () => {
    const unavailable = visibleMarkup({
      ...inbox,
      agents: [],
      continuity: {
        status: "unavailable",
        reason: "source-unavailable",
        executionAuthorized: false,
      },
    });
    for (const text of [
      "Continuity unavailable",
      "source-unavailable",
      "No continuity record supplied",
      "Unknown — not supplied",
      "No continuous stream or complete portfolio is inferred",
      "Inspect portfolio continuity",
    ]) {
      expect(unavailable).toContain(text);
    }
    const mismatch = visibleMarkup({
      ...inbox,
      agents: [],
      continuity: {
        status: "available",
        continuity: {
          ...continuity,
          accountAlias: "withheld-private-account",
          streamId: "withheld-private-stream",
        },
      },
    });
    expect(mismatch).toContain("Continuity scope mismatch");
    expect(mismatch).toContain("Mismatched record withheld");
    expect(mismatch).not.toContain("withheld-private-account");
    expect(mismatch).not.toContain("withheld-private-stream");
    const stale = visibleMarkup({
      ...inbox,
      agents: [],
      continuity: {
        status: "available",
        continuity: {
          ...continuity,
          state: "stale",
          freshness: { ...continuity.freshness, status: "stale" },
        },
      },
    });
    for (const text of [
      "Continuity: stale",
      "Freshness stale",
      "New risk remains inhibited",
      at,
      "9007199254740993",
      continuity.streamId,
      hash,
    ]) {
      expect(stale).toContain(text);
    }
  });

  it("does not turn an empty inbox or a completed run into readiness or permission", () => {
    const html = visibleMarkup({
      ...inbox,
      agents: [
        {
          ...agent,
          value: {
            ...agent.value,
            status: "completed",
            errors: [],
            approvalRequests: [],
            outputArtifactIds: ["synthetic-output"],
          },
        },
      ],
    });
    expect(html).toContain("No pending items supplied");
    expect(html).toContain(
      "It does not confirm portfolio status, current broker connectivity or permission to trade"
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain(agent.artifactId);
    return expect(html).not.toContain("Ready to trade");
  });

  it("keeps bounded pagination and filter reset callbacks for the supplied collection", () => {
    const many: DecisionInbox = {
      ...inbox,
      agents: Array.from({ length: 21 }, (_, index) => ({
        ...agent,
        artifactId: `synthetic-${index}`,
        value: { ...agent.value, approvalRequests: [] },
      })),
    };
    let tree = render(many);
    expect(renderToStaticMarkup(tree)).toContain("21 matching items");
    expect(
      elements(tree).find(
        (node) =>
          (node.type === "button" || node.type === Button) &&
          node.props.children === "Previous"
      )?.props.disabled
    ).toBe(true);
    click(tree, "Next");
    tree = render(many);
    expect(renderToStaticMarkup(tree)).toContain("Page 2 of 2");
    expect(
      elements(tree).find(
        (node) =>
          (node.type === "button" || node.type === Button) &&
          node.props.children === "Next"
      )?.props.disabled
    ).toBe(true);
    elements(tree)
      .find((node) => node.type === "input")
      ?.props.onChange?.({ target: { value: "not-supplied" } });
    tree = render(many);
    expect(renderToStaticMarkup(tree)).toContain("No matching decisions");
    click(tree, "Clear filters");
    tree = render(many);
    expect(renderToStaticMarkup(tree)).toContain("Page 1 of 2");
    elements(tree)
      .find((node) => node.type === "select")
      ?.props.onChange?.({ target: { value: "approval" } });
    return expect(renderToStaticMarkup(render(many))).toContain(
      "No matching decisions"
    );
  });

  it("passes the supplied sector rotation loader to the card", () => {
    const load = vi.fn();
    hooks.begin();
    const tree = TodayWorkspace({ sectorRotation: load });
    const card = elements(tree).find(
      (node) => node.type === SectorRotationChanges
    );
    return expect(Reflect.get(card?.props ?? {}, "load")).toBe(load);
  });

  return it("retires scoped reads when the workspace scope is cleared", () => {
    hooks.begin();
    let tree = TodayWorkspace();
    const picker = elements(tree).find((node) => node.type === ScopeChooser);
    expect(picker?.props.onSelect).toBeTypeOf("function");
    picker?.props.onSelect?.(scope);
    hooks.begin();
    tree = TodayWorkspace();
    expect(
      elements(tree).some((node) => node.key === JSON.stringify(scope))
    ).toBe(true);
    elements(tree)
      .find((node) => node.type === ScopeChooser)
      ?.props.onRetire?.();
    hooks.begin();
    tree = TodayWorkspace();
    return expect(
      elements(tree).some((node) => node.key === JSON.stringify(scope))
    ).toBe(false);
  });
});
