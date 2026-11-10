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
  ExecutionProjection,
  NativeFactProjection,
} from "@darkfactory/api/vertex";
import type { AuditProjection, ExperienceScope } from "./ports.ts";

// Synthetic observations only; these tests never contact a gateway or broker.
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

import { AuditLedger } from "./utilities.tsx";
import { experienceTableScroll } from "./experience-table.tsx";

const scope: ExperienceScope = {
  accountAlias: "synthetic-account",
  environment: "paper",
};
const hash = "b".repeat(64);
const at = "2026-09-22T12:00:00.123456789Z";
const projection = (sequence = "1"): ExecutionProjection => ({
  schemaVersion: "1.0.0",
  projectionId: `synthetic-projection-${sequence}`,
  ...scope,
  streamId: "synthetic-stream",
  ownerEpoch: "9007199254740993",
  sequence,
  previousEventHash: sequence === "1" ? null : hash,
  eventHash: hash,
  occurredAt: at,
  receivedAt: at,
  expiresAt: "2026-09-22T13:00:00Z",
  actorId: "synthetic-actor",
  policyVersion: "1.0.0",
  strategyVersion: "synthetic-strategy",
  reviewedArtifactSha256: hash,
  admissionId: null,
  idempotencyKey: `synthetic-key-${sequence}`,
  sourceKind: "broker-observation",
  authoritative: false,
  reservationAuthority: "native-owner-only",
  receipt: {
    schemaVersion: "1.0.0",
    intentId: `synthetic-intent-${sequence}`,
    submissionKey: `synthetic-submission-${sequence}`,
    brokerOrderRef: null,
    environment: "paper",
    observationOnly: true,
    status: "unknown",
    totalQuantity: "9007199254740993.000000001",
    filledQuantity: "0",
    remainingQuantity: "9007199254740993.000000001",
    lastReconciledAt: at,
    errorClass: "unknown-outcome",
    auditEventIds: [`synthetic-event-${sequence}`],
  },
});
const unresolved: NativeFactProjection = {
  schemaVersion: "1.0.0",
  projectionId: "synthetic-native-reconciliation",
  ...scope,
  environment: "paper",
  streamId: "synthetic-stream",
  ownerEpoch: "9007199254740993",
  sequence: "3",
  proofJournalSequence: "3",
  proofJournalHeadHash: "c".repeat(64),
  factOrdinal: 0,
  previousEventHash: hash,
  eventHash: hash,
  occurredAt: at,
  receivedAt: at,
  expiresAt: "2026-09-22T13:00:00Z",
  actorId: "synthetic-actor",
  policyVersion: "1.0.0",
  idempotencyKey: "synthetic-native-key",
  sourceKind: "paper-simulation",
  proof: {
    artifactId: "synthetic-proof",
    sha256: hash,
    sourceEventId: "synthetic-event",
  },
  fact: {
    kind: "reconciliation",
    reconciliationId: "synthetic-reconciliation",
    observedSnapshotId: "synthetic-snapshot",
    reconciled: false,
    unknownCount: 2,
  },
  authoritative: false,
  reservationAuthority: "native-owner-only",
  executionAuthorized: false,
};
const withoutHelp = (html: string): string =>
  html.replace(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/g, "");
type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
}>;
const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  const children: Interactive[] = [];
  Children.forEach(node.props.children, (child) =>
    children.push(...elements(child))
  );
  return [node, ...children];
};
const render = (projections: readonly AuditProjection[]): ReactNode => {
  hooks.begin();
  return AuditLedger({ projections, scope });
};

afterEach(() => hooks.clear());

describe("Audit data-first presentation", () => {
  it("associates the existing exact observation table with title help without hiding safety states", () => {
    const html = renderToStaticMarkup(render([projection(), unresolved]));
    const visible = withoutHelp(html);
    expect(html).toContain('aria-label="About Execution observations"');
    expect(html).toContain("Browser time does not determine this order");
    expect(visible).not.toContain("Browser time does not determine this order");
    expect(visible).toContain(
      'data-slot="table" id="audit-ledger-table" aria-labelledby="audit-ledger-heading">'
    );
    expect(visible).toContain(
      `class="${experienceTableScroll}" role="region" aria-labelledby="audit-ledger-heading" tabindex="0"`
    );
    for (const text of [
      "9007199254740993.000000001",
      "9007199254740993",
      hash,
      at,
      "Complete journal history and reconciliation remain unverified",
      "does not continuously check freshness",
      "Expired records do not confirm current readiness or authority",
      "Unknown execution outcomes: 1",
      "Unresolved reconciliation facts: 1",
      "Do not repeat an order",
      "UNKNOWN OUTCOME",
      "UNRESOLVED RECONCILIATION",
      "Sequence coverage",
      "no order actions or economic authority are available",
    ]) {
      expect(visible).toContain(text);
    }
  });
  it("retains unknown and gap notices when search hides every record", () => {
    const records = [projection(), unresolved];
    elements(render(records))
      .find((node) => node.type === "input")
      ?.props.onChange?.({ target: { value: "no-matching-source" } });
    const visible = withoutHelp(renderToStaticMarkup(render(records)));
    for (const text of [
      "No observations match this search",
      "Unknown execution outcomes: 1",
      "Unresolved reconciliation facts: 1",
      "Sequence coverage",
      "Do not repeat an order",
    ]) {
      expect(visible).toContain(text);
    }
    return expect(visible).not.toContain("<table");
  });
  it("keeps pagination read-only and counts unknowns across hidden pages", () => {
    const records = Array.from({ length: 26 }, (_, index) =>
      projection(String(index + 1))
    );
    const tree = render(records);
    const next = elements(tree).find(
      (node) =>
        (node.type === "button" || node.type === Button) &&
        node.props.children === "Next page"
    );
    expect(next?.props.disabled).toBe(false);
    next?.props.onClick?.();
    const paged = render(records);
    const visible = withoutHelp(renderToStaticMarkup(paged));
    expect(visible).toContain("Page 2 of 2");
    expect(visible).toContain("Unknown execution outcomes: 26");
    expect(visible).toContain("synthetic-projection-26");
    expect(
      elements(paged).find(
        (node) =>
          (node.type === "button" || node.type === Button) &&
          node.props.children === "Next page"
      )?.props.disabled
    ).toBe(true);
    return expect(
      elements(paged).find(
        (node) =>
          (node.type === "button" || node.type === Button) &&
          node.props.children === "Previous page"
      )?.props.disabled
    ).toBe(false);
  });
  return it("keeps an empty response unknown rather than suggesting broker reconciliation", () => {
    const html = renderToStaticMarkup(render([]));
    expect(html).toContain("No execution observations returned");
    expect(html).toContain("not proof that no orders exist");
    return expect(html).not.toContain("<table");
  });
});
