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
  BrokerRecoveryStatus,
  ExecutionProjection,
  NativeFact,
  NativeFactProjection,
} from "@darkfactory/api/vertex";
import type { AuditProjection, ExperienceScope } from "./ports.ts";

// Source-authored regressions only. The suite is intentionally not executed in
// the full-build authoring phase. A deterministic hook harness exercises read
// lifetimes without browser, provider, session or broker actions.
const harness = vi.hoisted(() => {
  const states: Array<{ value: unknown }> = [];
  const memos: Array<{ value: unknown; deps: readonly unknown[] }> = [];
  const clearResources: Array<() => void> = [];
  let stateIndex = 0;
  let memoIndex = 0;
  return {
    services: {
      reads: { gateway: vi.fn(), audit: vi.fn() },
      reviews: null,
      jobs: null,
    },
    clearResources,
    begin: () => {
      stateIndex = 0;
      memoIndex = 0;
    },
    reset: () => {
      for (const clear of clearResources.splice(0)) clear();
      states.length = 0;
      memos.length = 0;
    },
    useState: <Value,>(initial: Value | (() => Value)) => {
      const index = stateIndex++;
      states[index] ??= {
        value:
          typeof initial === "function" ? (initial as () => Value)() : initial,
      };
      const setValue = (value: Value) => {
        return (states[index]!.value = value);
      };
      return [states[index]!.value as Value, setValue] as const;
    },
    useMemo: <Value,>(
      factory: () => Value,
      deps: readonly unknown[]
    ): Value => {
      const index = memoIndex++;
      const previous = memos[index];
      if (
        previous !== undefined &&
        previous.deps.length === deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps[i]))
      )
        return previous.value as Value;
      const value = factory();
      memos[index] = { value, deps };
      return value;
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: harness.useState,
  useMemo: harness.useMemo,
}));

vi.mock("./shared.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./shared.tsx")>();
  const { createReadResource } = await import(
    "../../components/research/read-resource.ts"
  );
  return {
    ...original,
    ExperienceFrame: ({ children }: { readonly children: ReactNode }) => (
      <div>{children}</div>
    ),
    useExperienceServices: () => harness.services,
    useExperienceResource: <Input, Value>(
      read: (input: Input, signal: AbortSignal) => Promise<Value>
    ) => {
      const resource = harness.useMemo(() => {
        const created = createReadResource(read);
        harness.clearResources.push(created.clear);
        return created;
      }, [read]);
      return { resource, state: resource.getSnapshot() };
    },
  };
});

import {
  AuditLedger,
  AuditWorkspace,
  ConnectionsWorkspace,
  GatewayObservation,
  SettingsWorkspaceContent,
  SettingsWorkspaceSections,
  gatewayReadiness,
  indexAuditObservations,
} from "./utilities.tsx";
import { ScopeChooser } from "./shared.tsx";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import { ResearchHeading } from "../../components/research/research-views.tsx";

type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly id?: string;
  readonly htmlFor?: string;
  readonly type?: string;
  readonly disabled?: boolean;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
  readonly onClick?: () => void;
  readonly onSelect?: (scope: ExperienceScope) => void;
  readonly onRetire?: () => void;
}>;
const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
};
const render = (component: () => ReactNode): ReactNode => {
  harness.begin();
  return component();
};
const markup = (node: ReactNode): string => renderToStaticMarkup(node);
const workspaceContent = (workspace: () => ReactNode): (() => ReactNode) => {
  const frame = workspace() as ReactElement<{ children: ReactNode }>;
  const content = Children.only(frame.props.children) as ReactElement;
  return () => (content.type as () => ReactNode)();
};
const change = (tree: ReactNode, id: string, value: string) => {
  const field = elements(tree).find((element) => element.props.id === id);
  expect(field?.props.onChange).toBeTypeOf("function");
  return field!.props.onChange!({ target: { value } });
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  return await Promise.resolve();
};
const scope: ExperienceScope = {
  accountAlias: "account-test",
  environment: "paper",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const observedAt = "2026-09-22T12:00:00.123456789Z";
const gateway = (
  overrides: Partial<BrokerRecoveryStatus> = {}
): BrokerRecoveryStatus => ({
  schemaVersion: "1.0.0",
  statusId: "status-1",
  gatewayId: "gateway-test",
  environment: "paper",
  observedAt,
  infrastructure: "observed",
  brokerHandshake: "authenticated",
  recovery: "completed",
  trading: "disabled",
  reasonCodes: ["connectivity-observed"],
  lastHumanRequestId: "human-request-1",
  ...overrides,
});
const projection = (
  sequence = "1",
  overrides: Partial<ExecutionProjection> = {}
): ExecutionProjection => ({
  schemaVersion: "1.0.0",
  projectionId: `projection-${sequence}`,
  ...scope,
  streamId: "stream-1",
  ownerEpoch: "1",
  sequence,
  previousEventHash: sequence === "1" ? null : hashA,
  eventHash: hashA,
  occurredAt: observedAt,
  receivedAt: "2026-09-22T12:00:01.123456789Z",
  actorId: "actor-1",
  policyVersion: "1.0.0",
  strategyVersion: "strategy-v1",
  reviewedArtifactSha256: hashC,
  admissionId: "admission-1",
  expiresAt: "2026-09-22T13:00:00Z",
  idempotencyKey: `projection-key-${sequence}`,
  sourceKind: "broker-observation",
  authoritative: false,
  reservationAuthority: "native-owner-only",
  receipt: {
    schemaVersion: "1.0.0",
    intentId: `intent-${sequence}`,
    submissionKey: `submission-${sequence}`,
    brokerOrderRef: null,
    environment: "paper",
    observationOnly: true,
    status: "unknown",
    totalQuantity: "10",
    filledQuantity: "0",
    remainingQuantity: "10",
    lastReconciledAt: observedAt,
    errorClass: "unknown-outcome",
    auditEventIds: [`event-${sequence}`],
  },
  ...overrides,
});

const selectAudit = (tree: ReactNode, selected: ExperienceScope = scope) => {
  const picker = elements(tree).find(
    (element) => element.type === ScopeChooser
  );
  expect(picker?.props.onSelect).toBeTypeOf("function");
  return picker!.props.onSelect!(selected);
};

afterEach(() => {
  harness.reset();
  harness.services.reads.gateway.mockReset();
  return harness.services.reads.audit.mockReset();
});

describe("gateway observations never become recovery or trading authority", () => {
  it("renders Connections once with a distinct context label and visible trading boundary", () => {
    const frame = ConnectionsWorkspace() as ReactElement<{
      readonly title: string;
    }>;
    const html = markup(<ResearchHeading title={frame.props.title} />);
    expect(html.match(/Connections/g)).toHaveLength(1);
    expect(html).toContain("<h1>Connections</h1>");
    expect(markup(<GatewayObservation status={gateway()} />)).toContain(
      "Trading disabled"
    );
    return expect(harness.services.reads.gateway).not.toHaveBeenCalled();
  });

  it("does not infer readiness from observed infrastructure, authentication or completed recovery", () => {
    const value = gateway();
    expect(gatewayReadiness(value)).toBe(
      "Unknown — no explicit read-only readiness reason code"
    );
    const html = markup(<GatewayObservation status={value} />);
    expect(html).toContain("observed");
    expect(html).toContain("authenticated");
    expect(html).toContain("completed");
    expect(html).toContain("Trading disabled");
    expect(html).toContain("Unknown — no explicit");
    return expect(html).not.toContain("<button");
  });

  it("only labels explicit source readiness and preserves contradictory codes as unknown", () => {
    expect(
      gatewayReadiness(gateway({ reasonCodes: ["read-only-ready"] }))
    ).toContain("not trading permission");
    expect(
      gatewayReadiness(gateway({ reasonCodes: ["read-only-not-ready"] }))
    ).toContain("Not ready");
    expect(
      gatewayReadiness(
        gateway({ reasonCodes: ["read-only-ready", "read-only-not-ready"] })
      )
    ).toContain("Unknown — conflicting");
    const html = markup(
      <GatewayObservation
        status={gateway({ reasonCodes: ["read-only-ready"] })}
      />
    );
    expect(html).toContain("Trading disabled");
    return expect(html).toContain("read-only-ready");
  });

  it("preserves exact source time and status identity, without browser freshness invention", () => {
    const html = markup(<GatewayObservation status={gateway()} />);
    expect(html).toContain(observedAt);
    expect(html).toContain("status-1");
    expect(html).toContain("gateway-test / paper");
    expect(html).toContain("This page does not check heartbeat freshness");
    return expect(html).not.toContain("just now");
  });
});

describe("execution audit preserves evidence and uncertainty", () => {
  it("sorts exact sequence and owner epoch strings beyond Number precision without mutating source order", () => {
    const rows = [
      projection("9007199254740994"),
      projection("9007199254740992"),
      projection("9007199254740993"),
    ];
    const original = rows.map((row) => row.sequence);
    const indexed = indexAuditObservations(rows);
    expect(indexed.ordered.map((row) => row.sequence)).toEqual([
      "9007199254740992",
      "9007199254740993",
      "9007199254740994",
    ]);
    expect(rows.map((row) => row.sequence)).toEqual(original);
    const epochs = indexAuditObservations([
      projection("1", { ownerEpoch: "9007199254740993" }),
      projection("1", { ownerEpoch: "9007199254740992" }),
    ]);
    expect(epochs.ordered.map((row) => row.ownerEpoch)).toEqual([
      "9007199254740992",
      "9007199254740993",
    ]);
    return expect(
      epochs.issues.some((issue) =>
        issue.detail.includes("Cross-epoch continuity is unknown")
      )
    ).toBe(true);
  });

  it("reports exact missing sequence ranges rather than hiding gaps or claiming reconciliation", () => {
    const indexed = indexAuditObservations([projection("4"), projection("1")]);
    expect(indexed.issues).toEqual([
      {
        identity: "stream-1 / epoch 1 / sequence 4",
        detail:
          "Sequence gap: missing 2 through 3. No outcome is inferred for missing observations.",
      },
    ]);
    const html = markup(
      render(() => AuditLedger({ projections: indexed.ordered, scope }))
    );
    expect(html).toContain("Sequence gap: missing 2 through 3");
    return expect(html).not.toContain("Reconciliation successful");
  });

  it("flags unavailable prefixes, duplicate sequences and broken hash predecessors separately", () => {
    expect(
      indexAuditObservations([projection("99")]).issues[0]!.detail
    ).toContain("returned history begins at 99, not 1");
    expect(
      indexAuditObservations([
        projection(),
        projection("1", { projectionId: "duplicate" }),
      ]).issues[0]!.detail
    ).toContain("Duplicate sequence 1");
    expect(
      indexAuditObservations([
        projection(),
        projection("2", { previousEventHash: hashB }),
      ]).issues[0]!.detail
    ).toContain("Source hash-chain mismatch");
    const separateStreams = indexAuditObservations([
      projection("1"),
      projection("1", { streamId: "stream-2" }),
    ]);
    return expect(separateStreams.issues).toHaveLength(0);
  });

  it("keeps unknown outcomes prominent and displays exact source hashes and review/admission/intent identity", () => {
    const html = markup(
      render(() => AuditLedger({ projections: [projection()], scope }))
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Unknown execution outcomes: 1");
    expect(html).toContain("UNKNOWN OUTCOME — reconciliation required");
    expect(html).toContain("Unknown does not mean not submitted");
    expect(html).toContain(hashA);
    expect(html).toContain(hashC);
    expect(html).toContain("intent-1");
    expect(html).toContain("admission-1");
    expect(html).toContain("Review record identity");
    expect(html).toContain("Not supplied by this projection");
    expect(html).toContain(observedAt);
    return expect(html).toContain(
      "A reconciliation timestamp alone does not establish a known outcome"
    );
  });

  it("does not round quantities or interpret null admission/order references as successful reconciliation", () => {
    const base = projection();
    const value = projection("1", {
      admissionId: null,
      receipt: {
        ...base.receipt,
        totalQuantity: "9007199254740993.123456789",
        remainingQuantity: "9007199254740993.123456789",
      },
    });
    const html = markup(
      render(() => AuditLedger({ projections: [value], scope }))
    );
    expect(html).toContain("9007199254740993.123456789");
    expect(html).toContain("admission not inferred");
    return expect(html).toContain("submission outcome not inferred");
  });

  it("keeps gap notices and unknown counts when search hides every affected receipt", () => {
    const component = () =>
      AuditLedger({ projections: [projection(), projection("4")], scope });
    change(render(component), "audit-search", "does-not-match");
    const html = markup(render(component));
    expect(html).toContain("No observations match this search");
    expect(html).toContain("Unknown execution outcomes: 2");
    expect(html).toContain("Sequence gap: missing 2 through 3");
    return expect(html).not.toContain("<tbody");
  });

  it("bounds pages to 25 records, keeps unknown totals, and resets the page for search", () => {
    const projections = Array.from({ length: 26 }, (_value, index) =>
      projection(String(index + 1))
    );
    const component = () => AuditLedger({ projections, scope });
    let tree = render(component);
    expect((markup(tree).match(/<tr\b/g) ?? []).length).toBe(26);
    expect(markup(tree)).toContain("Unknown execution outcomes: 26");
    const next = elements(tree).find(
      (element) =>
        (element.type === "button" || element.type === Button) &&
        element.props.children === "Next page"
    );
    expect(next!.props.disabled).toBe(false);
    next!.props.onClick!();
    tree = render(component);
    expect((markup(tree).match(/<tr\b/g) ?? []).length).toBe(2);
    expect(markup(tree)).toContain("projection-26");
    expect(markup(tree)).toContain("Page 2 of 2");
    change(tree, "audit-search", "intent-1");
    return expect(markup(render(component))).toContain("Page 1 of 1");
  });

  it("retains semantic table, caption, row/column headers and keyboard-scrollable region without action controls", () => {
    const tree = render(() =>
      AuditLedger({ projections: [projection()], scope })
    );
    const html = markup(tree);
    expect(html).toContain("<caption");
    expect(html).toContain('scope="row"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      'role="region" aria-labelledby="audit-ledger-heading" tabindex="0"'
    );
    const buttons = elements(tree).filter(
      (element) => element.type === "button" || element.type === Button
    );
    expect(buttons.map((element) => element.props.children)).toEqual([
      "Previous page",
      "Next page",
    ]);
    expect(html).not.toContain("<form");
    return expect(html).not.toMatch(
      /<button[^>]*>(?:<(?!\/button)[^>]*>)*[^<]*(Cancel|Modify|Submit|Reconcile|Approve)/i
    );
  });

  return it("labels the empty response without asserting absence of orders", () => {
    const html = markup(render(() => AuditLedger({ projections: [], scope })));
    expect(html).toContain("No execution observations returned");
    return expect(html).toContain("not proof that no orders exist");
  });
});

describe("audit scope and failure boundaries", () => {
  it("does not read before selection and sends the exact authorized scope", async () => {
    harness.services.reads.audit.mockResolvedValue([]);
    const component = workspaceContent(AuditWorkspace);
    expect(markup(render(component))).not.toContain("execution audit");
    expect(harness.services.reads.audit).not.toHaveBeenCalled();
    selectAudit(render(component));
    expect(harness.services.reads.audit).toHaveBeenCalledWith(
      scope,
      expect.any(AbortSignal)
    );
    expect(markup(render(component))).toContain("Reading execution audit");
    await settle();
    return expect(markup(render(component))).toContain(
      "No execution observations returned"
    );
  });

  it("retires scope by aborting a pending read and suppresses a late response", async () => {
    let finish: ((values: readonly ExecutionProjection[]) => void) | undefined;
    let signal: AbortSignal | undefined;
    harness.services.reads.audit.mockImplementation(
      (_scope: unknown, inputSignal: AbortSignal) => {
        signal = inputSignal;
        return new Promise<readonly ExecutionProjection[]>((resolve) => {
          finish = resolve;
        });
      }
    );
    const component = workspaceContent(AuditWorkspace);
    selectAudit(render(component));
    const picker = elements(render(component)).find(
      (element) => element.type === ScopeChooser
    );
    picker!.props.onRetire!();
    expect(signal!.aborted).toBe(true);
    finish!([projection()]);
    await settle();
    expect(markup(render(component))).not.toContain("Reading execution audit");
    return expect(markup(render(component))).not.toContain("projection-1");
  });

  it.each([
    { result: [projection("1", { accountAlias: "another-account" })] },
    { result: [projection("1", { environment: "live" })] },
    { result: [{ ...projection(), sequence: "01" }] },
    { result: [{ ...projection(), eventHash: "unverified" }] },
    {
      result: [
        {
          ...projection(),
          receipt: {
            ...projection().receipt,
            status: "unknown",
            errorClass: null,
          },
        },
      ],
    },
    {
      result: Array.from({ length: 501 }, (_value, index) =>
        projection(String(index + 1))
      ),
    },
  ])(
    "withholds wrong-scope, malformed and over-bound responses rather than partially displaying them",
    async ({ result }) => {
      harness.services.reads.audit.mockResolvedValue(result);
      const component = workspaceContent(AuditWorkspace);
      selectAudit(render(component));
      await settle();
      const html = markup(render(component));
      expect(html).toContain("Source verification failed");
      return expect(html).not.toContain("<tbody");
    }
  );

  return it.each([
    ["denied", "Access not granted"],
    ["unauthorized", "Sign in again"],
    ["unavailable", "Source unavailable"],
    ["malformed", "Source verification failed"],
  ] as const)("renders %s failures and no old receipt", async (kind, title) => {
    harness.services.reads.audit.mockRejectedValue(new VertexReadError(kind));
    const component = workspaceContent(AuditWorkspace);
    selectAudit(render(component));
    await settle();
    const html = markup(render(component));
    expect(html).toContain(title);
    return expect(html).not.toContain("projection-1");
  });
});

describe("settings composes existing account ownership", () => {
  return it("links existing account and utility destinations without auth, preference or mutation controls", () => {
    // The route wraps the same sections in the research scope gate, which
    // starts in its "checking" state on the server.
    expect(markup(<SettingsWorkspaceSections />)).not.toContain(
      "/settings/account/profile"
    );
    const html = markup(<SettingsWorkspaceContent />);
    for (const href of [
      "/settings/account/profile",
      "/settings/account/address",
      "/settings/account/preferences",
      "/settings/account/security",
      "/modules",
      "/connections",
      "/audit",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain(
      "Read results remain in page-session memory. The browser does not save them to local storage"
    );
    expect(html).toContain(
      "Stopping a browser read does not cancel a server job or broker order"
    );
    expect(html).toContain(
      "Clearing local session data does not confirm remote revocation"
    );
    expect(html).not.toMatch(/<(input|form|button|select)(\s|>)/);
    return expect(html).not.toContain("onClick");
  });
});

const optionFact = {
  settlementId: "settlement-option",
  instrumentId: "option-1",
  underlyingId: "underlying-1",
  settlementKind: "physical" as const,
  settlementState: "pending" as const,
  quantity: "9007199254740993.123456789",
  currency: "USD",
  cashDelta: "-9007199254740993.123456789",
  shareDelta: "100",
  dueAt: "2026-09-23T12:00:00.123456789Z",
  fillEventIds: ["fill-1"],
};
const nativeFacts: readonly NativeFact[] = [
  {
    kind: "checkpoint",
    snapshotId: "snapshot-1",
    snapshotSha256: hashB,
    journalSequence: "9007199254740993",
    journalHeadHash: hashC,
  },
  {
    kind: "cash-settlement",
    settlementId: "settlement-cash",
    currency: "USD",
    cashDelta: "-12.123456789",
    fillEventIds: ["fill-1", "fill-2"],
  },
  { kind: "assignment", ...optionFact },
  { kind: "exercise", ...optionFact },
  { kind: "option-expiry", ...optionFact, cashDelta: "0", shareDelta: "0" },
  {
    kind: "corporate-action",
    actionId: "split-1",
    oldInstrumentId: "old-instrument",
    newInstrumentId: "new-instrument",
    quantityNumerator: "9007199254740993",
    quantityDenominator: "2",
    previousQuantity: "2",
    newQuantity: "9007199254740993",
    cashDelta: "0",
    currency: "USD",
    previousQualificationSha256: hashB,
    replacementQualificationSha256: hashC,
  },
  {
    kind: "reconciliation",
    reconciliationId: "reconciliation-1",
    observedSnapshotId: "snapshot-unknown",
    unknownCount: 7,
    reconciled: false,
  },
  {
    kind: "kill-state",
    action: "reset-new-risk",
    reasonCodes: ["human-reset-observed"],
    grantId: "grant-reference-only",
  },
];
const nativeProjection = (
  fact: NativeFact = nativeFacts[0]!,
  sequence = "2",
  overrides: Partial<NativeFactProjection> = {}
): NativeFactProjection => ({
  schemaVersion: "1.0.0",
  projectionId: `native-${fact.kind}-${sequence}`,
  accountAlias: scope.accountAlias,
  environment: "paper",
  streamId: "stream-1",
  ownerEpoch: "1",
  sequence,
  proofJournalSequence: sequence,
  proofJournalHeadHash: "c".repeat(64),
  factOrdinal: 0,
  previousEventHash: hashA,
  eventHash: hashA,
  occurredAt: observedAt,
  receivedAt: "2026-09-22T12:00:01.123456789Z",
  actorId: "actor-native",
  policyVersion: "1.0.0",
  expiresAt: "2026-09-22T13:00:00Z",
  idempotencyKey: `native-key-${sequence}`,
  sourceKind: "paper-simulation",
  proof: {
    artifactId: "native-proof-1",
    sha256: hashB,
    sourceEventId: "journal-event-1",
  },
  fact,
  authoritative: false,
  reservationAuthority: "native-owner-only",
  executionAuthorized: false,
  ...overrides,
});

describe("native fact audit union", () => {
  it.each(nativeFacts.map((fact) => ({ fact })))(
    "renders strict typed $fact.kind fields without inventing an execution receipt",
    ({ fact }) => {
      const value = nativeProjection(fact);
      const tree = render(() => AuditLedger({ projections: [value], scope }));
      const html = markup(tree);
      expect(html).toContain(`Native fact: ${fact.kind}`);
      expect(html).toContain(
        "Paper simulation journal observation — not an order receipt"
      );
      expect(html).toContain("native-proof-1");
      expect(html).toContain("journal-event-1");
      expect(html).toContain(hashB);
      expect(html).toContain("Proof SHA-256");
      expect(html).toContain("Execution authorized");
      expect(html).toContain("native-owner-only");
      expect(html).not.toContain("Broker order reference");
      expect(html).not.toContain("Reviewed artifact SHA-256");
      expect(html).not.toContain("Intent identity");
      expect(html).not.toContain("<dt>Total</dt>");
      return expect(
        elements(tree)
          .filter(
            (element) => element.type === "button" || element.type === Button
          )
          .map((element) => element.props.children)
      ).toEqual(["Previous page", "Next page"]);
    }
  );

  it("places native facts and receipt observations in the same exact stream sequence with no artificial gap", () => {
    const rows: readonly AuditProjection[] = [
      projection("3"),
      nativeProjection(),
      projection("1"),
    ];
    const indexed = indexAuditObservations(rows);
    expect(indexed.ordered.map((row) => row.sequence)).toEqual(["1", "2", "3"]);
    expect(indexed.issues).toHaveLength(0);
    expect(indexed.unknownCount).toBe(2);
    return expect(rows.map((row) => row.sequence)).toEqual(["3", "2", "1"]);
  });

  it("retains shared-stream gaps and predecessor mismatches across receipt/native boundaries", () => {
    const indexed = indexAuditObservations([
      projection("1"),
      nativeProjection(nativeFacts[0]!, "2", { previousEventHash: hashB }),
      projection("4"),
    ]);
    expect(indexed.issues.map((issue) => issue.detail)).toEqual([
      "Source hash-chain mismatch: previousEventHash does not match the preceding returned eventHash. Continuity is unverified.",
      "Sequence gap: missing 3 through 3. No outcome is inferred for missing observations.",
    ]);
    const nativeOnly = indexAuditObservations([nativeProjection()]);
    return expect(nativeOnly.issues[0]!.detail).toContain(
      "returned history begins at 2, not 1"
    );
  });

  it.each(["assignment", "exercise", "option-expiry"] as const)(
    "keeps pending %s obligations nonspendable and preserves future dueAt",
    (kind) => {
      const fact = nativeFacts.find((value) => value.kind === kind)!;
      const html = markup(
        render(() =>
          AuditLedger({ projections: [nativeProjection(fact)], scope })
        )
      );
      expect(html).toContain(
        "PENDING OBLIGATION — deltas are not spendable cash or shares"
      );
      expect(html).toContain(optionFact.dueAt);
      expect(html).toContain(optionFact.quantity);
      expect(html).toContain("pending");
      expect(html).not.toContain("Available cash");
      return expect(html).not.toContain("Buying power");
    }
  );

  it("preserves corporate-action exact ratio, qualification hashes and signed cash without deriving capital", () => {
    const html = markup(
      render(() =>
        AuditLedger({ projections: [nativeProjection(nativeFacts[5]!)], scope })
      )
    );
    expect(html).toContain("9007199254740993");
    expect(html).toContain("Quantity denominator");
    expect(html).toContain("Previous qualification SHA-256");
    expect(html).toContain("Replacement qualification SHA-256");
    expect(html).toContain(hashB);
    expect(html).toContain(hashC);
    const cashHtml = markup(
      render(() =>
        AuditLedger({ projections: [nativeProjection(nativeFacts[1]!)], scope })
      )
    );
    return expect(cashHtml).toContain("-12.123456789");
  });

  it("does not let later zero reconciliation or search erase earlier nonzero or false-zero evidence", () => {
    const rows: readonly AuditProjection[] = [
      nativeProjection(nativeFacts[6]!, "2"),
      nativeProjection(
        {
          kind: "reconciliation",
          reconciliationId: "false-zero",
          observedSnapshotId: "snapshot-2",
          unknownCount: 0,
          reconciled: false,
        },
        "3"
      ),
      nativeProjection(
        {
          kind: "reconciliation",
          reconciliationId: "reported-zero",
          observedSnapshotId: "snapshot-3",
          unknownCount: 0,
          reconciled: true,
        },
        "4"
      ),
    ];
    const index = indexAuditObservations(rows);
    expect(index.unknownCount).toBe(0);
    expect(index.unresolvedReconciliations).toBe(2);
    expect(index.reportedUnknownCount).toBe(7);
    const component = () => AuditLedger({ projections: rows, scope });
    change(render(component), "audit-search", "reported-zero");
    const html = markup(render(component));
    expect(html).toContain("Unresolved reconciliation facts: 2");
    expect(html).toContain(
      "Reported unknown counts across returned reconciliation facts: 7"
    );
    expect(html).toContain("not deduplicated orders");
    expect(html).toContain("not an independent reconciliation certificate");
    change(render(component), "audit-search", "no-such-record");
    const emptyHtml = markup(render(component));
    expect(emptyHtml).toContain("No observations match this search");
    expect(emptyHtml).toContain("Unresolved reconciliation facts: 2");
    return expect(emptyHtml).toContain("facts: 7");
  });

  it("keeps native reconciliation counts visible when pagination hides the fact", () => {
    const rows: readonly AuditProjection[] = [
      ...Array.from({ length: 25 }, (_value, index) =>
        projection(String(index + 1))
      ),
      nativeProjection(nativeFacts[6]!, "26"),
    ];
    const tree = render(() => AuditLedger({ projections: rows, scope }));
    const html = markup(tree);
    expect(html).toContain("Unresolved reconciliation facts: 1");
    expect(html).toContain("facts: 7");
    return expect(html).not.toContain("native-reconciliation-26");
  });

  it("searches exact proof identities, kinds, hashes and typed fields", () => {
    const rows: readonly AuditProjection[] = [
      projection(),
      nativeProjection(nativeFacts[0]!, "2", {
        proof: {
          artifactId: "search-proof",
          sha256: hashB,
          sourceEventId: "search-journal",
        },
      }),
    ];
    const component = () => AuditLedger({ projections: rows, scope });
    for (const query of [
      "search-proof",
      "search-journal",
      "checkpoint",
      "9007199254740993",
      hashB,
    ]) {
      change(render(component), "audit-search", query);
      const html = markup(render(component));
      expect(html).toContain("native-checkpoint-2");
      expect(html).toContain("1 matching of 2");
      expect(html).not.toContain("Inspect receipt &amp; review binding");
    }
  });

  it("labels exact source timing and expiry as observation staleness, never admission authority or proof replay", () => {
    const value = nativeProjection();
    const html = markup(
      render(() => AuditLedger({ projections: [value], scope }))
    );
    expect(html).toContain(value.occurredAt);
    expect(html).toContain(value.receivedAt);
    expect(html).toContain(value.expiresAt);
    expect(html).toContain("Expired observations are stale");
    expect(html).toContain("This page does not continuously check freshness");
    expect(html).toContain(
      "Projection expiry does not establish admission validity"
    );
    expect(html).toContain(
      "This page cannot retrieve or replay the referenced journal proof"
    );
    return expect(html).toContain(
      "The hash does not independently verify economic facts"
    );
  });

  it("renders observed kill/reset and grant references without exposing a risk-state action", () => {
    const html = markup(
      render(() =>
        AuditLedger({ projections: [nativeProjection(nativeFacts[7]!)], scope })
      )
    );
    expect(html).toContain("reset-new-risk");
    expect(html).toContain("grant-reference-only");
    expect(html).toContain("A grant reference is not a new-risk authorization");
    return expect(html).not.toMatch(
      /<button[^>]*>(?:<(?!\/button)[^>]*>)*[^<]*(Reset|Pause|Resume|Reconcile|Approve)/i
    );
  });

  it.each(nativeFacts.map((fact) => ({ fact })))(
    "accepts a source-schema-valid $fact.kind from the scoped read without a receipt",
    async ({ fact }) => {
      // The shared guard owns canonical hash/proof binding; this harness isolates
      // the utility's defensive schema/scope union dispatch, not source authenticity.
      harness.services.reads.audit.mockResolvedValue([nativeProjection(fact)]);
      const component = workspaceContent(AuditWorkspace);
      selectAudit(render(component));
      await settle();
      const html = markup(render(component));
      expect(html).toContain(`Native fact: ${fact.kind}`);
      return expect(html).not.toContain("Source verification failed");
    }
  );

  return it.each([
    { value: { ...nativeProjection(), fact: { kind: "unexpected" } } },
    {
      value: {
        ...nativeProjection(),
        proof: { artifactId: "proof", sha256: "bad", sourceEventId: "event" },
      },
    },
    { value: { ...nativeProjection(), proof: null } },
    {
      value: {
        ...nativeProjection(),
        proof: { ...nativeProjection().proof, grant: true },
      },
    },
    {
      value: { ...nativeProjection(), sequence: "1", previousEventHash: null },
    },
    { value: { ...nativeProjection(), environment: "live" } },
    { value: { ...nativeProjection(), accountAlias: "another-account" } },
    { value: { ...nativeProjection(), receipt: projection().receipt } },
    { value: { ...projection(), fact: nativeFacts[0] } },
    {
      value: {
        ...nativeProjection(),
        fact: { ...nativeFacts[6], reconciled: true },
      },
    },
    {
      value: {
        ...nativeProjection(),
        fact: { ...nativeFacts[7], grantId: null },
      },
    },
    {
      value: {
        ...nativeProjection(),
        fact: { ...nativeFacts[4], cashDelta: "1" },
      },
    },
    {
      value: {
        ...nativeProjection(),
        fact: { ...nativeFacts[2], settlementState: "settled" },
      },
    },
  ])(
    "withholds malformed native kinds, proof references and contradictory facts without falling back to receipt interpretation",
    async ({ value }) => {
      harness.services.reads.audit.mockResolvedValue([value]);
      const component = workspaceContent(AuditWorkspace);
      selectAudit(render(component));
      await settle();
      const html = markup(render(component));
      expect(html).toContain("Source verification failed");
      return expect(html).not.toContain("<tbody");
    }
  );
});
