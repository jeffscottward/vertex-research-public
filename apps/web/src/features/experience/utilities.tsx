"use client";

import {
  Button,
  TableBody,
  TableRow,
  alertTitleClassName,
  alertVariants,
} from "@darkfactory/ui";

import { useEffect, useMemo, useState } from "react";
import {
  BrokerRecoveryStatusSchema,
  ExecutionProjectionSchema,
  NativeFactProjectionSchema,
  type BrokerRecoveryStatus,
  type ExecutionProjection,
  type NativeFact,
  type NativeFactProjection,
} from "@darkfactory/api/vertex";
import { ResearchScopedWorkspace } from "../../components/research/read-scope.tsx";
import { ResearchTableHeading } from "../../components/research/research-table-heading.tsx";
import {
  ArtifactFacts,
  ReadNotice,
} from "../../components/research/research-views.tsx";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import type { AuditProjection, ExperienceScope } from "./ports.ts";
import {
  ExperienceFrame,
  ResourcePanel,
  ScopeLabel,
  ScopeChooser,
  useExperienceResource,
  useExperienceServices,
} from "./shared.tsx";
import {
  ExperienceTable,
  ExperienceTableCaption,
  ExperienceTableCell,
  ExperienceTableHead,
  ExperienceTableHeader,
  experienceTableScroll,
} from "./experience-table.tsx";

type GatewayScope = Readonly<{
  gatewayId: string;
  environment: "paper" | "live";
}>;
const AUDIT_LIMIT = 500;
const PAGE_SIZE = 25;

// Readiness is an explicit source statement, never inferred from connectivity.
// Even read-only-ready cannot grant broker-paper or live execution authority.
export const gatewayReadiness = (status: BrokerRecoveryStatus): string => {
  const ready = status.reasonCodes.includes("read-only-ready");
  const notReady = status.reasonCodes.includes("read-only-not-ready");
  if (ready && notReady)
    return "Unknown — conflicting source readiness reason codes";
  if (notReady) return "Not ready for read-only observation — source reported";
  if (ready) return "Read-only ready — source reported, not trading permission";
  return "Unknown — no explicit read-only readiness reason code";
};

export const GatewayObservation = ({
  status,
}: {
  readonly status: BrokerRecoveryStatus;
}) => (
  <article className="vx-artifact" aria-label="Gateway observation">
    <header className="vx-artifact-heading">
      <p className="vx-eyebrow">Source observation / {status.environment}</p>
      <h2>{status.gatewayId}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        The source observed this status at{" "}
        <time dateTime={status.observedAt}>{status.observedAt}</time>. This page
        does not check heartbeat freshness.
      </p>
    </header>
    <ReadNotice title="Trading disabled">
      This observation cannot submit, cancel or modify orders. Connectivity,
      broker authentication and completed recovery are not readiness or
      authority grants.
    </ReadNotice>
    <ArtifactFacts
      entries={[
        ["Status identity", status.statusId],
        [
          "Exact gateway / environment",
          `${status.gatewayId} / ${status.environment}`,
        ],
        ["Source observed at", status.observedAt],
        ["Infrastructure", status.infrastructure],
        ["Broker handshake", status.brokerHandshake],
        ["Recovery", status.recovery],
        ["Read-only readiness", gatewayReadiness(status)],
        ["Trading", "disabled"],
        ["Reason codes (source)", status.reasonCodes.join(", ")],
        [
          "Last human request identity",
          status.lastHumanRequestId ?? "Not supplied — no request inferred",
        ],
      ]}
    />
    <p className="text-muted-foreground text-sm leading-relaxed">
      This status does not include heartbeat freshness, account reconciliation
      evidence, a host fingerprint or a recovery challenge. These values remain
      unknown.
    </p>
  </article>
);

const HumanConnectionSteps = () => (
  <section
    className="vx-boundary vx-ex-utility-section"
    aria-labelledby="connection-human-steps"
  >
    <p className="vx-eyebrow">Required human actions</p>
    <h2 id="connection-human-steps">
      Verify the connection in a trusted console
    </h2>
    <ol className="vx-requirements">
      <li>
        <strong>Verify host trust.</strong> Compare the exact host fingerprint
        through the provider console you already trust. Do not accept an unknown
        host key or paste credentials into this workspace.
      </li>
      <li>
        <strong>Complete broker login and 2FA yourself.</strong> Use the
        verified broker interface. Passwords, one-time codes, permission prompts
        and security approvals remain human-only.
      </li>
      <li>
        <strong>Reconcile before any further decision.</strong> Have the
        authorized owner inspect existing orders, fills and balances in the
        trusted broker system and reconcile unknown outcomes. An empty list,
        timeout or connected socket is not proof of reconciliation.
      </li>
      <li>
        <strong>Return for a new read.</strong> Read the exact gateway and
        environment again after the source publishes another status. Reading
        here does not restart, rescan or request recovery.
      </li>
    </ol>
    <p>
      Confirmation text, model responses and displayed reason codes do not grant
      authorization. This page cannot perform recovery actions.
    </p>
    <a className="vx-text-link" href="/audit">
      Inspect execution observations
    </a>
  </section>
);

const gatewayKey = (gateway: GatewayScope): string =>
  `${gateway.gatewayId}/${gateway.environment}`;

// Lists every configured gateway this session may observe and reads the
// first one's status by default (owner rule 2026-10-30: no typed gateway ID).
// Choosing a row reads that gateway; the read stays observation-only.
const ConnectionsContent = () => {
  const services = useExperienceServices();
  const list = useExperienceResource(services.reads.gateways);
  const read = useMemo(
    () =>
      async (
        scope: GatewayScope,
        signal: AbortSignal
      ): Promise<BrokerRecoveryStatus> => {
        const value = await services.reads.gateway(scope, signal);
        const parsed = BrokerRecoveryStatusSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.gatewayId !== scope.gatewayId ||
          parsed.data.environment !== scope.environment
        )
          throw new VertexReadError("malformed");
        return parsed.data;
      },
    [services.reads.gateway]
  );
  const { resource, state } = useExperienceResource(read);
  const [selected, setSelected] = useState<GatewayScope | null>(null);
  useEffect(() => {
    void list.resource.load(undefined);
    return;
  }, [list.resource]);
  const gateways = list.state.type === "ready" ? list.state.value : null;
  const choose = (gateway: GatewayScope) => {
    resource.clear();
    const scope = {
      gatewayId: gateway.gatewayId,
      environment: gateway.environment,
    };
    setSelected(scope);
    return void resource.load(scope);
  };
  useEffect(() => {
    const first = gateways?.[0];
    if (first === undefined || selected !== null) return;
    return choose(first);
  });
  return (
    <>
      {list.state.type === "idle" ? (
        <ReadNotice title="Loading broker gateways" loading />
      ) : (
        <ResourcePanel
          state={list.state}
          title="Broker gateways"
          retry={() => void list.resource.load(undefined)}
        >
          {(rows) =>
            rows.length === 0 ? (
              <ReadNotice title="No broker gateways to show">
                This page lists each broker gateway you may observe. None is
                visible to this account right now: the server has no gateway
                binding, you hold no read grant for its account scope, or the
                grant check is unavailable. Gateways appear here without any
                typing once a binding and a grant exist.
              </ReadNotice>
            ) : (
              <section
                className="my-4 border-border border-y [&>summary]:cursor-pointer [&>summary]:py-4 [&>summary]:font-semibold"
                aria-labelledby="gateway-list-title"
              >
                <ResearchTableHeading
                  id="gateway-list-title"
                  title="Broker gateways"
                >
                  <p>
                    Each row is one configured gateway you may observe. Choose a
                    row to read its recorded status. Reading never restarts or
                    recovers a gateway.
                  </p>
                </ResearchTableHeading>
                <ExperienceTable aria-labelledby="gateway-list-title">
                  <ExperienceTableHeader>
                    <TableRow>
                      <ExperienceTableHead scope="col">
                        Gateway
                      </ExperienceTableHead>
                      <ExperienceTableHead scope="col">
                        Environment
                      </ExperienceTableHead>
                      <ExperienceTableHead scope="col">
                        Account
                      </ExperienceTableHead>
                      <ExperienceTableHead scope="col">
                        Status
                      </ExperienceTableHead>
                    </TableRow>
                  </ExperienceTableHeader>
                  <TableBody>
                    {rows.map((gateway) => {
                      const current =
                        selected !== null &&
                        gatewayKey(selected) === gatewayKey(gateway);
                      return (
                        <TableRow
                          key={gatewayKey(gateway)}
                          aria-current={current ? "true" : undefined}
                        >
                          <ExperienceTableHead scope="row">
                            {gateway.gatewayId}
                          </ExperienceTableHead>
                          <ExperienceTableCell>
                            {gateway.environment} — observation only
                          </ExperienceTableCell>
                          <ExperienceTableCell>
                            {gateway.accountAlias}
                          </ExperienceTableCell>
                          <ExperienceTableCell>
                            <Button
                              variant="outline"
                              type="button"
                              disabled={current}
                              onClick={() => choose(gateway)}
                            >
                              {current
                                ? "Showing status"
                                : `Read ${gateway.gatewayId} status`}
                            </Button>
                          </ExperienceTableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </ExperienceTable>
              </section>
            )
          }
        </ResourcePanel>
      )}
      {selected === null ? null : (
        <ResourcePanel
          state={state}
          title="Gateway status"
          retry={() => void resource.load(selected)}
        >
          {(status) => <GatewayObservation status={status} />}
        </ResourcePanel>
      )}
      <HumanConnectionSteps />
    </>
  );
};

export const ConnectionsWorkspace = () => (
  <ExperienceFrame title="Connections">
    <ConnectionsContent />
  </ExperienceFrame>
);

type AuditIssue = Readonly<{ identity: string; detail: string }>;
type AuditIndex = Readonly<{
  ordered: readonly AuditProjection[];
  issues: readonly AuditIssue[];
  unknownCount: number;
  unresolvedReconciliations: number;
  reportedUnknownCount: number;
}>;
const compareExact = (left: string, right: string): number =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// Called only with schema-validated, same-account/environment observations.
// Never coerce exact sequence or epoch strings through Number/parseInt.
export const indexAuditObservations = (
  projections: readonly AuditProjection[]
): AuditIndex => {
  const ordered = [...projections].sort((left, right) => {
    return (
      compareText(left.streamId, right.streamId) ||
      compareExact(left.ownerEpoch, right.ownerEpoch) ||
      compareExact(left.sequence, right.sequence) ||
      compareText(left.projectionId, right.projectionId)
    );
  });
  const issues: AuditIssue[] = [];
  let previous: AuditProjection | undefined;
  let unknownCount = 0;
  let unresolvedReconciliations = 0;
  let reportedUnknownCount = 0;
  for (const current of ordered) {
    const identity = `${current.streamId} / epoch ${current.ownerEpoch} / sequence ${current.sequence}`;
    if ("fact" in current) {
      if (current.fact.kind === "reconciliation") {
        if (!current.fact.reconciled || current.fact.unknownCount > 0)
          unresolvedReconciliations += 1;
        reportedUnknownCount += current.fact.unknownCount;
      }
    } else if (
      current.receipt.status === "unknown" ||
      current.receipt.errorClass === "unknown-outcome"
    ) {
      unknownCount += 1;
    }
    const streamPrevious =
      previous !== undefined && previous.streamId === current.streamId
        ? previous
        : undefined;
    const epochPrevious =
      streamPrevious !== undefined &&
      streamPrevious.ownerEpoch === current.ownerEpoch
        ? streamPrevious
        : undefined;
    const sameEpoch = epochPrevious !== undefined;
    if (streamPrevious !== undefined && !sameEpoch) {
      issues.push({
        identity,
        detail: `Owner epoch changed from ${streamPrevious.ownerEpoch} to ${current.ownerEpoch}. Cross-epoch continuity is unknown; this is not reconciliation success.`,
      });
    }
    if (!sameEpoch && current.sequence !== "1") {
      issues.push({
        identity,
        detail: `Sequence coverage gap: returned history begins at ${current.sequence}, not 1. Earlier observations are unavailable in this response.`,
      });
    }
    if (epochPrevious !== undefined) {
      const expected = BigInt(epochPrevious.sequence) + 1n;
      const actual = BigInt(current.sequence);
      if (actual > expected) {
        issues.push({
          identity,
          detail: `Sequence gap: missing ${expected.toString()} through ${(actual - 1n).toString()}. No outcome is inferred for missing observations.`,
        });
      } else if (actual < expected) {
        issues.push({
          identity,
          detail: `Duplicate sequence ${current.sequence}. Both observations remain visible; ordering is ambiguous.`,
        });
      } else if (current.previousEventHash !== epochPrevious.eventHash) {
        issues.push({
          identity,
          detail:
            "Source hash-chain mismatch: previousEventHash does not match the preceding returned eventHash. Continuity is unverified.",
        });
      }
    }
    previous = current;
  }
  return {
    ordered,
    issues,
    unknownCount,
    unresolvedReconciliations,
    reportedUnknownCount,
  };
};

// Explicit fields only: never flatten an arbitrary record or synthesize a receipt.
const nativeFactEntries = (
  fact: NativeFact
): readonly (readonly [string, string])[] => {
  switch (fact.kind) {
    case "checkpoint": {
      return [
        ["Snapshot identity", fact.snapshotId],
        ["Snapshot SHA-256", fact.snapshotSha256],
        ["Journal sequence", fact.journalSequence],
        ["Journal head hash", fact.journalHeadHash],
      ];
    }
    case "cash-settlement": {
      return [
        ["Settlement identity", fact.settlementId],
        ["Currency", fact.currency],
        ["Cash delta", fact.cashDelta],
        ["Fill event identities", fact.fillEventIds.join(", ")],
      ];
    }
    case "assignment":
    case "exercise":
    case "option-expiry": {
      return [
        ["Settlement identity", fact.settlementId],
        ["Instrument identity", fact.instrumentId],
        ["Underlying identity", fact.underlyingId],
        ["Settlement kind", fact.settlementKind],
        ["Settlement state", fact.settlementState],
        ["Quantity", fact.quantity],
        ["Currency", fact.currency],
        ["Cash delta", fact.cashDelta],
        ["Share delta", fact.shareDelta],
        ["Due at (source)", fact.dueAt],
        ["Fill event identities", fact.fillEventIds.join(", ")],
      ];
    }
    case "corporate-action": {
      return [
        ["Action identity", fact.actionId],
        ["Old instrument", fact.oldInstrumentId],
        ["New instrument", fact.newInstrumentId],
        ["Quantity numerator", fact.quantityNumerator],
        ["Quantity denominator", fact.quantityDenominator],
        ["Previous quantity", fact.previousQuantity],
        ["New quantity", fact.newQuantity],
        ["Cash delta", fact.cashDelta],
        ["Currency", fact.currency],
        ["Previous qualification SHA-256", fact.previousQualificationSha256],
        [
          "Replacement qualification SHA-256",
          fact.replacementQualificationSha256,
        ],
      ];
    }
    case "reconciliation": {
      return [
        ["Reconciliation identity", fact.reconciliationId],
        ["Observed snapshot", fact.observedSnapshotId],
        ["Unknown count (source)", String(fact.unknownCount)],
        ["Reconciled (source)", String(fact.reconciled)],
      ];
    }
    case "kill-state": {
      return [
        ["Observed action", fact.action],
        ["Reason codes", fact.reasonCodes.join(", ")],
        ["Grant reference", fact.grantId ?? "Not supplied — no grant inferred"],
      ];
    }
  }
};

const auditSearchText = (value: AuditProjection): string => {
  const common = [
    value.projectionId,
    value.accountAlias,
    value.environment,
    value.streamId,
    value.ownerEpoch,
    value.sequence,
    value.eventHash,
    value.previousEventHash ?? "",
    value.sourceKind,
    value.actorId,
    value.policyVersion,
    value.occurredAt,
    value.receivedAt,
    value.expiresAt,
  ];
  const specific =
    "fact" in value
      ? [
          value.fact.kind,
          value.proof.artifactId,
          value.proof.sha256,
          value.proof.sourceEventId,
          ...nativeFactEntries(value.fact).flatMap(([label, field]) => [
            label,
            field,
          ]),
        ]
      : [
          value.strategyVersion,
          value.reviewedArtifactSha256,
          value.admissionId ?? "",
          value.receipt.intentId,
          value.receipt.submissionKey,
          value.receipt.brokerOrderRef ?? "",
          value.receipt.status,
          value.receipt.errorClass ?? "",
          ...value.receipt.auditEventIds,
        ];
  return [...common, ...specific].join(" ").toLowerCase();
};

const NativeFactIdentity = ({
  projection,
}: {
  readonly projection: NativeFactProjection;
}) => (
  <details className="vx-details">
    <summary>
      Inspect native {projection.fact.kind} & proof reference for{" "}
      {projection.projectionId}
    </summary>
    <ArtifactFacts
      entries={[
        ["Projection identity", projection.projectionId],
        ["Proof artifact identity", projection.proof.artifactId],
        ["Proof SHA-256", projection.proof.sha256],
        ["Proof source event identity", projection.proof.sourceEventId],
        ["Actor identity", projection.actorId],
        ["Policy version", projection.policyVersion],
        ["Idempotency identity", projection.idempotencyKey],
        ["Occurred at (source)", projection.occurredAt],
        ["Received at (source)", projection.receivedAt],
        ["Expires at (source)", projection.expiresAt],
        ["Execution authorized", "false"],
        [
          "Economic authority",
          "None — observation only; reservation authority remains native-owner-only",
        ],
      ]}
    />
    <p className="text-muted-foreground text-sm leading-relaxed">
      The service verifies the projection content hash, including the proof
      reference. This page cannot retrieve or replay the referenced journal
      proof. The hash does not independently verify economic facts, spendable
      assets, journal completeness or capital authority.
    </p>
    <p className="text-muted-foreground text-sm leading-relaxed">
      Source occurrence, receipt and expiry timestamps remain unchanged. Expired
      observations are stale. This page does not continuously check freshness.
      Projection expiry does not establish admission validity or authorize
      settlement or new risk.
    </p>
  </details>
);

const NativeFactOutcome = ({ fact }: { readonly fact: NativeFact }) => (
  <>
    <strong>Native fact: {fact.kind}</strong>
    {fact.kind === "reconciliation" ? (
      <p className="text-muted-foreground text-sm leading-relaxed">
        {!fact.reconciled || fact.unknownCount > 0
          ? `UNRESOLVED RECONCILIATION — ${fact.unknownCount} unknown (source)`
          : "Source reports reconciled with zero unknown; not an independent reconciliation certificate."}
      </p>
    ) : null}
    {fact.kind === "assignment" ||
    fact.kind === "exercise" ||
    fact.kind === "option-expiry" ? (
      <p className="text-muted-foreground text-sm leading-relaxed">
        {fact.settlementState === "pending"
          ? "PENDING OBLIGATION — deltas are not spendable cash or shares."
          : "Source reports settled; no economic authority is granted here."}
      </p>
    ) : null}
    {fact.kind === "kill-state" ? (
      <p className="text-muted-foreground text-sm leading-relaxed">
        An observed pause or reset is not a control. A grant reference is not a
        new-risk authorization.
      </p>
    ) : null}
    <p className="text-muted-foreground text-sm leading-relaxed">
      Paper simulation journal observation — not an order receipt.
    </p>
  </>
);

const ReceiptIdentity = ({
  projection,
}: {
  readonly projection: ExecutionProjection;
}) => (
  <details className="vx-details">
    <summary>
      Inspect receipt & review binding for {projection.projectionId}
    </summary>
    <ArtifactFacts
      entries={[
        ["Projection identity", projection.projectionId],
        ["Intent identity", projection.receipt.intentId],
        ["Reviewed artifact SHA-256", projection.reviewedArtifactSha256],
        [
          "Review record identity",
          "Not supplied by this projection; match the exact reviewed artifact hash in the review workspace",
        ],
        [
          "Admission identity",
          projection.admissionId ?? "Not supplied — admission not inferred",
        ],
        ["Strategy version", projection.strategyVersion],
        ["Policy version", projection.policyVersion],
        ["Actor identity", projection.actorId],
        ["Idempotency identity", projection.idempotencyKey],
        ["Submission identity", projection.receipt.submissionKey],
        [
          "Broker order reference",
          projection.receipt.brokerOrderRef ??
            "Not supplied — submission outcome not inferred",
        ],
        ["Audit event identities", projection.receipt.auditEventIds.join(", ")],
        ["Occurred at (source)", projection.occurredAt],
        ["Received at (source)", projection.receivedAt],
        ["Expires at (source)", projection.expiresAt],
        [
          "Last reconciled at (receipt field)",
          projection.receipt.lastReconciledAt,
        ],
        [
          "Observation only",
          "true — not authoritative; reservation authority remains native-owner-only",
        ],
      ]}
    />
    <p className="text-muted-foreground text-sm leading-relaxed">
      A reconciliation timestamp alone does not establish a known outcome. This
      view does not retrieve or verify the review or admission record and grants
      no execution permission.
    </p>
  </details>
);

export const AuditLedger = ({
  projections,
  scope,
}: {
  readonly projections: readonly AuditProjection[];
  readonly scope: ExperienceScope;
}) => {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const index = useMemo(
    () => indexAuditObservations(projections),
    [projections]
  );
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return index.ordered.filter(
      (projection) =>
        needle.length === 0 || auditSearchText(projection).includes(needle)
    );
  }, [index, search]);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const activePage = Math.min(page, pages - 1);
  const visible = matches.slice(
    activePage * PAGE_SIZE,
    (activePage + 1) * PAGE_SIZE
  );
  if (projections.length === 0) {
    return (
      <ReadNotice title="No execution observations returned">
        No receipts or native facts were returned for this account and
        environment. This is not proof that no orders exist, that an unknown
        outcome resolved, or that the broker reconciled.
      </ReadNotice>
    );
  }
  return (
    <section
      className="vx-ex-utility-section"
      aria-labelledby="audit-ledger-heading"
    >
      <ResearchTableHeading
        id="audit-ledger-heading"
        title="Execution observations"
      >
        <p>
          Observations use stream, exact owner epoch and exact sequence order.
          Browser time does not determine this order. The response includes up
          to {AUDIT_LIMIT} observations, with {PAGE_SIZE} per page.
        </p>
        <p>
          Native facts and receipts use the same sequence history. Record
          details include source occurrence, receipt and expiry times.
        </p>
      </ResearchTableHeading>
      <ScopeLabel scope={scope} />
      <p className="text-muted-foreground text-sm leading-relaxed">
        Complete journal history and reconciliation remain unverified.
      </p>
      <p className="text-muted-foreground text-sm leading-relaxed">
        This page does not continuously check freshness. Expired records do not
        confirm current readiness or authority.
      </p>
      {index.unknownCount > 0 ? (
        <section
          className={alertVariants({ variant: "destructive" })}
          role="alert"
          aria-label="Unknown execution outcomes"
        >
          <h3 className={alertTitleClassName}>
            Unknown execution outcomes: {index.unknownCount}
          </h3>
          <p>
            Unknown does not mean not submitted, rejected or cancelled. Do not
            repeat an order to find out. The authorized human owner must
            reconcile through the trusted broker system. This count includes
            rows hidden by search and pagination.
          </p>
        </section>
      ) : null}
      {index.unresolvedReconciliations > 0 || index.reportedUnknownCount > 0 ? (
        <section
          className={alertVariants({ variant: "destructive" })}
          role="alert"
          aria-label="Unresolved native reconciliation observations"
        >
          <h3 className={alertTitleClassName}>
            Unresolved reconciliation facts: {index.unresolvedReconciliations}
          </h3>
          <p>
            Reported unknown counts across returned reconciliation facts:{" "}
            {index.reportedUnknownCount}. These are source snapshot counts, not
            deduplicated orders or an account balance. A later zero count does
            not erase earlier unresolved evidence. This notice covers rows
            hidden by search and pagination; no broker reconciliation success is
            inferred.
          </p>
        </section>
      ) : null}
      <details className="vx-details" open={index.issues.length > 0}>
        <summary>
          Sequence coverage & source hash continuity — {index.issues.length}{" "}
          warnings
        </summary>
        {index.issues.length === 0 ? (
          <p className="text-muted-foreground text-sm leading-relaxed">
            No gap or hash-chain mismatch detected within the returned range.
            Complete history, source authenticity and reconciliation remain
            unverified.
          </p>
        ) : (
          <ul
            className="vx-requirements"
            aria-label="Sequence continuity warnings"
          >
            {index.issues.map((issue, position) => (
              <li key={`${issue.identity}-${position}`}>
                <strong>{issue.identity}</strong>
                <span>{issue.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-sm leading-relaxed">
          These warnings cover all returned rows and remain visible regardless
          of search or page. Canonical content hashes are verified at the
          experience service boundary. The exact source-supplied hashes below
          identify that content; matching a hash does not authenticate the
          source or prove complete reconciliation.
        </p>
      </details>
      <div className="vx-lookup-form vx-ex-toolbar">
        <label htmlFor="audit-search">
          Search returned identities, hashes, source or outcome
        </label>
        <input
          id="audit-search"
          type="search"
          value={search}
          maxLength={160}
          autoComplete="off"
          spellCheck={false}
          aria-controls="audit-ledger-table"
          onChange={(event) => {
            setSearch(event.target.value.slice(0, 160));
            return setPage(0);
          }}
        />
        <p
          className="text-muted-foreground text-sm leading-relaxed"
          role="status"
          aria-live="polite"
        >
          {matches.length} matching of {projections.length} returned
          observations. Page {activePage + 1} of {pages}.
        </p>
      </div>
      {matches.length === 0 ? (
        <ReadNotice title="No observations match this search">
          Change or clear the search to inspect this returned scope. Sequence
          warnings and unknown-outcome counts above have not been filtered out.
        </ReadNotice>
      ) : (
        <div
          className={experienceTableScroll}
          role="region"
          aria-labelledby="audit-ledger-heading"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
          tabIndex={0}
        >
          <ExperienceTable
            id="audit-ledger-table"
            aria-labelledby="audit-ledger-heading"
          >
            <ExperienceTableCaption>
              Observation-only receipts and native facts for{" "}
              {scope.accountAlias} / {scope.environment}. Exact quantities and
              hashes are preserved; no order actions or economic authority are
              available.
            </ExperienceTableCaption>
            <ExperienceTableHeader>
              <TableRow>
                <ExperienceTableHead scope="col">
                  Stream / epoch / sequence
                </ExperienceTableHead>
                <ExperienceTableHead scope="col">
                  Outcome / fact kind
                </ExperienceTableHead>
                <ExperienceTableHead scope="col">
                  Exact receipt quantities / typed fact fields
                </ExperienceTableHead>
                <ExperienceTableHead scope="col">
                  Source & hash chain
                </ExperienceTableHead>
                <ExperienceTableHead scope="col">
                  Receipt / proof identity
                </ExperienceTableHead>
              </TableRow>
            </ExperienceTableHeader>
            <TableBody>
              {visible.map((projection, position) => (
                <TableRow
                  key={`${projection.projectionId}-${activePage}-${position}`}
                >
                  <ExperienceTableHead scope="row">
                    <span>{projection.streamId}</span>
                    <br />
                    Epoch {projection.ownerEpoch}
                    <br />
                    Sequence {projection.sequence}
                  </ExperienceTableHead>
                  <ExperienceTableCell>
                    {"fact" in projection ? (
                      <NativeFactOutcome fact={projection.fact} />
                    ) : (
                      <>
                        <strong>
                          {projection.receipt.status === "unknown"
                            ? "UNKNOWN OUTCOME — reconciliation required"
                            : projection.receipt.status}
                        </strong>
                        <p className="text-muted-foreground text-sm leading-relaxed">
                          Error class:{" "}
                          {projection.receipt.errorClass ?? "None supplied"}
                        </p>
                        <p className="text-muted-foreground text-sm leading-relaxed">
                          Observation, not an instruction
                        </p>
                      </>
                    )}
                  </ExperienceTableCell>
                  <ExperienceTableCell>
                    {"fact" in projection ? (
                      <ArtifactFacts
                        entries={nativeFactEntries(projection.fact)}
                      />
                    ) : (
                      <dl>
                        <dt>Total</dt>
                        <dd>{projection.receipt.totalQuantity}</dd>
                        <dt>Filled</dt>
                        <dd>{projection.receipt.filledQuantity}</dd>
                        <dt>Remaining</dt>
                        <dd>{projection.receipt.remainingQuantity}</dd>
                      </dl>
                    )}
                  </ExperienceTableCell>
                  <ExperienceTableCell>
                    <p>{projection.sourceKind}</p>
                    <dl className="vx-facts">
                      <div>
                        <dt>Event SHA-256 (source)</dt>
                        <dd>{projection.eventHash}</dd>
                      </div>
                      <div>
                        <dt>Previous event SHA-256</dt>
                        <dd>
                          {projection.previousEventHash ??
                            "None — first sequence only"}
                        </dd>
                      </div>
                    </dl>
                  </ExperienceTableCell>
                  <ExperienceTableCell>
                    {"fact" in projection ? (
                      <NativeFactIdentity projection={projection} />
                    ) : (
                      <ReceiptIdentity projection={projection} />
                    )}
                  </ExperienceTableCell>
                </TableRow>
              ))}
            </TableBody>
          </ExperienceTable>
        </div>
      )}
      <nav
        className="vx-ex-toolbar vx-section-toolbar"
        aria-label="Audit observation pages"
      >
        <Button
          variant="outline"
          type="button"
          disabled={activePage === 0}
          onClick={() => setPage(Math.max(0, activePage - 1))}
        >
          Previous page
        </Button>
        <span className="text-muted-foreground text-sm leading-relaxed">
          Page {activePage + 1} of {pages}
        </span>
        <Button
          variant="outline"
          type="button"
          disabled={activePage + 1 >= pages}
          onClick={() => setPage(Math.min(pages - 1, activePage + 1))}
        >
          Next page
        </Button>
      </nav>
    </section>
  );
};

const AuditContent = () => {
  const services = useExperienceServices();
  const read = useMemo(
    () =>
      async (
        readScope: ExperienceScope,
        signal: AbortSignal
      ): Promise<readonly AuditProjection[]> => {
        const result = await services.reads.audit(readScope, signal);
        if (!Array.isArray(result) || result.length > AUDIT_LIMIT)
          throw new VertexReadError("malformed");
        return result.map((value) => {
          const parsed =
            typeof value === "object" && value !== null && "fact" in value
              ? NativeFactProjectionSchema.safeParse(value)
              : ExecutionProjectionSchema.safeParse(value);
          if (
            !parsed.success ||
            parsed.data.accountAlias !== readScope.accountAlias ||
            parsed.data.environment !== readScope.environment
          )
            throw new VertexReadError("malformed");
          return parsed.data;
        });
      },
    [services.reads.audit]
  );
  const { resource, state } = useExperienceResource(read);
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  const retire = () => {
    resource.clear();
    return setScope(null);
  };
  const select = (next: ExperienceScope) => {
    setScope(next);
    return void resource.load(next);
  };
  return (
    <>
      <ScopeChooser
        label="Execution audit account scope"
        onSelect={select}
        onRetire={retire}
      />
      {scope === null ? null : (
        <ResourcePanel
          state={state}
          title="Execution audit"
          retry={() => void resource.load(scope)}
        >
          {(projections) => (
            <AuditLedger
              key={`${scope.accountAlias}:${scope.environment}`}
              projections={projections}
              scope={scope}
            />
          )}
        </ResourcePanel>
      )}
    </>
  );
};

export const AuditWorkspace = () => (
  <ExperienceFrame title="Audit">
    <AuditContent />
  </ExperienceFrame>
);

/** The /settings/workspace body; `SettingsWorkspaceSections` adds the research scope. */
export const SettingsWorkspaceContent = () => (
  <>
    <section
      className="vx-boundary vx-ex-utility-section"
      aria-labelledby="settings-account-heading"
    >
      <h2 id="settings-account-heading">Account settings</h2>
      <nav className="vx-section-links" aria-label="Existing account settings">
        <a href="/settings/account/profile">Profile</a>
        <a href="/settings/account/address">Address</a>
        <a href="/settings/account/preferences">Preferences</a>
        <a href="/settings/account/security">Security & sessions</a>
      </nav>
      <p>
        Each destination checks your session and permissions. Opening a link
        does not change preferences, revoke sessions or grant access. If access
        is denied, use the account access process. Do not enter credentials
        here.
      </p>
    </section>
    <section
      className="vx-boundary vx-ex-utility-section"
      aria-labelledby="settings-privacy-heading"
    >
      <h2 id="settings-privacy-heading">Session privacy and temporary data</h2>
      <p>
        Read results remain in page-session memory. The browser does not save
        them to local storage or an offline cache. A new read clears the prior
        result. Changing the scope stops the pending read and clears visible
        data. Leaving the page clears its read results.
      </p>
      <p>
        Session invalidation or logout clears observations and rejects late
        responses. Stopping a browser read does not cancel a server job or
        broker order. Clearing local session data does not confirm remote
        revocation. Inspect active sessions on the Security page.
      </p>
      <p>
        This page does not clear browser-wide data, store passwords or copy
        account preferences. Read failures show permission, unavailable or
        malformed-source states. They do not show sample data.
      </p>
    </section>
    <section
      className="vx-boundary vx-ex-utility-section"
      aria-labelledby="settings-utilities-heading"
    >
      <h2 id="settings-utilities-heading">Workspace utilities</h2>
      <nav
        className="vx-section-links"
        aria-label="Workspace utility destinations"
      >
        <a href="/modules">Module catalog</a>
        <a href="/connections">Connections</a>
        <a href="/audit">Audit</a>
      </nav>
      <p>
        Catalog entries and connection observations describe declared or
        observed state only. They do not prove an available runtime, data
        entitlement, broker readiness or permission to trade.
      </p>
    </section>
  </>
);

/**
 * Workspace settings sections, rendered under the upstream settings layout at
 * /settings/workspace (the layout supplies the page heading and tabs).
 */
export const SettingsWorkspaceSections = () => (
  <ResearchScopedWorkspace>
    <SettingsWorkspaceContent />
  </ResearchScopedWorkspace>
);
