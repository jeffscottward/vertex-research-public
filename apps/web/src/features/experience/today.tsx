"use client";

import { Button } from "@darkfactory/ui";

import { useEffect, useMemo, useState } from "react";
import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import type { AcceptedReview } from "@darkfactory/api/vertex";
import type { SectorRotationSnapshot } from "@darkfactory/api";
import { SectorRotationChanges } from "../../components/portal/sector-rotation-changes.tsx";
import { ResearchTableHeading } from "../../components/research/research-table-heading.tsx";
import type { DecisionInbox, ExperienceScope } from "./ports.ts";
import {
  EmptyCollection,
  ExperienceFrame,
  ResourcePanel,
  ScopeLabel,
  ScopeChooser,
  useExperienceResource,
  useExperienceServices,
} from "./shared.tsx";

type InboxKind = "approval" | "blocked" | "strategy" | "continuity";
type InboxItem = Readonly<{
  key: string;
  kind: InboxKind;
  title: string;
  detail: string;
  identity: string;
  digest: string | null;
  href:
    | "/agents#approval-requests"
    | "/agents#blocked-runs"
    | "/strategies#review-queue"
    | "/portfolio#continuity";
  action: string;
}>;
const kindLabels: Record<InboxKind, string> = {
  approval: "Agent approval requests",
  blocked: "Blocked or failed jobs",
  strategy: "Pending exact-version reviews",
  continuity: "Continuity issues",
};
const PAGE_SIZE = 20;

const currentReview = (review: AcceptedReview, now: bigint): boolean => {
  try {
    return (
      timestampToEpochNanoseconds(review.reviewedAt) <= now &&
      now < timestampToEpochNanoseconds(review.expiresAt)
    );
  } catch {
    return false;
  }
};

const actionableInbox = (
  inbox: DecisionInbox,
  scope: ExperienceScope,
  now: bigint
): readonly InboxItem[] => {
  const items: InboxItem[] = [];
  const scopedReviews = inbox.reviews.filter(
    (review) =>
      review.accountAlias === scope.accountAlias &&
      review.environment === scope.environment &&
      review.purpose === "research"
  );
  const superseded = new Set(
    scopedReviews
      .map((review) => review.supersedesReviewId)
      .filter((id) => id !== null)
  );
  for (const artifact of inbox.agents) {
    const run = artifact.value;
    if (run.approvalRequests.length > 0) {
      items.push({
        key: `approval:${artifact.artifactId}`,
        kind: "approval",
        title: `${run.agentRole}: approval requested`,
        detail: run.approvalRequests
          .map((request) => `${request.kind} · ${request.requestId}`)
          .join("; "),
        identity: artifact.artifactId,
        digest: artifact.sha256,
        href: "/agents#approval-requests",
        action: "Inspect approval requests",
      });
    }
    if (run.status === "blocked" || run.status === "failed") {
      items.push({
        key: `blocked:${artifact.artifactId}`,
        kind: "blocked",
        title: `${run.agentRole}: ${run.status}`,
        detail:
          run.errors.length === 0
            ? "The source supplied no error code. Inspect this exact run before proposing further work."
            : run.errors
                .map(
                  (error) =>
                    `${error.code}${error.retryable ? " · source marks retryable" : " · not marked retryable"}`
                )
                .join("; "),
        identity: artifact.artifactId,
        digest: artifact.sha256,
        href: "/agents#blocked-runs",
        action: "Inspect blocked or failed run",
      });
    }
  }
  for (const artifact of inbox.strategies) {
    const reviewed = scopedReviews.some(
      (review) =>
        review.artifactId === artifact.artifactId &&
        review.artifactSha256 === artifact.sha256 &&
        review.strategyVersion === artifact.artifactId &&
        !superseded.has(review.reviewId) &&
        currentReview(review, now)
    );
    if (!reviewed) {
      items.push({
        key: `strategy:${artifact.artifactId}`,
        kind: "strategy",
        title: `${artifact.value.strategyId}: exact-version review needed`,
        detail: `${artifact.value.sleeve} · display version ${artifact.value.version}. No current, unsuperseded research decision matching this immutable artifact and hash was supplied. A different version or expired review does not resolve this item.`,
        identity: artifact.artifactId,
        digest: artifact.sha256,
        href: "/strategies#review-queue",
        action: "Open strategy review queue",
      });
    }
  }
  const read = inbox.continuity;
  if (read.status === "unavailable") {
    items.push({
      key: "continuity:unavailable",
      kind: "continuity",
      title: "Continuity unavailable",
      detail: `${read.reason}. No continuous stream or complete portfolio is inferred.`,
      identity: "No continuity record supplied",
      digest: null,
      href: "/portfolio#continuity",
      action: "Inspect portfolio continuity",
    });
  } else if (
    read.continuity.accountAlias !== scope.accountAlias ||
    read.continuity.environment !== scope.environment
  ) {
    items.push({
      key: "continuity:mismatch",
      kind: "continuity",
      title: "Continuity scope mismatch",
      detail:
        "The source returned continuity for a different scope. Private details are withheld; completeness cannot be established.",
      identity: "Mismatched record withheld",
      digest: null,
      href: "/portfolio#continuity",
      action: "Read the intended portfolio scope",
    });
  } else if (
    read.continuity.state !== "continuous" ||
    read.continuity.freshness.status !== "fresh"
  ) {
    const continuity = read.continuity;
    items.push({
      key: "continuity:attention",
      kind: "continuity",
      title: `Continuity: ${continuity.state}`,
      detail: `Freshness ${continuity.freshness.status} · evaluated ${continuity.evaluatedAt} · high-water ${continuity.highWaterSequence} · owner epoch ${continuity.ownerEpoch}. New risk remains inhibited. This page cannot reconcile or repair the native-owner stream.`,
      identity: continuity.streamId,
      digest: continuity.highWaterEventHash,
      href: "/portfolio#continuity",
      action: "Inspect portfolio continuity",
    });
  }
  return items;
};

export const TodayDecisionInbox = ({
  inbox,
  scope,
}: {
  readonly inbox: DecisionInbox;
  readonly scope: ExperienceScope;
}) => {
  const [kind, setKind] = useState<"all" | InboxKind>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  // Review currency is evaluated at this read, never represented as a grant of authority.
  const items = useMemo(
    () => actionableInbox(inbox, scope, BigInt(Date.now()) * 1_000_000n),
    [inbox, scope]
  );
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        (kind === "all" || item.kind === kind) &&
        (text.length === 0 ||
          `${item.title} ${item.detail} ${item.identity}`
            .toLowerCase()
            .includes(text))
    );
  }, [items, kind, query]);
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = matches.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );
  return (
    <section className="vx-ex-section" aria-labelledby="decision-inbox-title">
      <ResearchTableHeading id="decision-inbox-title" title="Decision inbox">
        <p>
          Supplied approval requests, blocked or failed jobs, pending
          exact-version research reviews and continuity issues. Running or
          completed status alone does not require a decision.
        </p>
        <p>Links do not include the account scope or private artifact IDs.</p>
      </ResearchTableHeading>
      <div className="vx-ex-toolbar">
        <label>
          Item type
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "all" | InboxKind);
              return setPage(0);
            }}
          >
            <option value="all">All item types</option>
            <option value="approval">Agent approval requests</option>
            <option value="blocked">Blocked or failed jobs</option>
            <option value="strategy">Pending exact-version reviews</option>
            <option value="continuity">Continuity issues</option>
          </select>
        </label>
        <label>
          Search decision inbox
          <input
            type="search"
            value={query}
            maxLength={160}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              return setPage(0);
            }}
          />
        </label>
        {query.length > 0 || kind !== "all" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setQuery("");
              setKind("all");
              return setPage(0);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <EmptyCollection title="No pending items supplied">
          This read contains no pending item in the supported categories. It
          does not confirm portfolio status, current broker connectivity or
          permission to trade.
        </EmptyCollection>
      ) : matches.length === 0 ? (
        <EmptyCollection title="No matching decisions">
          Change the item type or clear the search. Other supplied items may
          still require a decision.
        </EmptyCollection>
      ) : (
        <div>
          <div
            className="vx-ex-table-scroll"
            role="region"
            aria-label="Decision inbox; scroll horizontally for all fields"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
            tabIndex={0}
          >
            <table
              className="vx-ex-table"
              aria-labelledby="decision-inbox-title"
            >
              <caption>Pending decisions — supplied records only</caption>
              <thead>
                <tr>
                  <th scope="col">Item type</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Source identity</th>
                  <th scope="col">Source hash</th>
                  <th scope="col">Next action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.key}>
                    <td>{kindLabels[item.kind]}</td>
                    <th scope="row">{item.title}</th>
                    <td>{item.detail}</td>
                    <td>
                      {item.kind === "strategy" ? (
                        <span className="text-muted-foreground text-sm leading-relaxed">
                          Immutable strategy version
                          <br />
                        </span>
                      ) : null}
                      {item.identity}
                    </td>
                    <td>
                      {item.digest === null
                        ? "Unknown — not supplied"
                        : item.digest}
                    </td>
                    <td>
                      <a className="vx-text-link" href={item.href}>
                        {item.action}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="vx-ex-pagination" aria-label="Decision inbox pages">
            <Button
              type="button"
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <p role="status">
              Page {currentPage + 1} of {pageCount}
              {" · "}
              {matches.length} matching items
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </nav>
        </div>
      )}
    </section>
  );
};

const ScopedToday = ({ scope }: { readonly scope: ExperienceScope }) => {
  const services = useExperienceServices();
  const { resource, state } = useExperienceResource(services.reads.inbox);
  useEffect(() => {
    void resource.load(scope);
    return () => resource.clear();
  }, [resource, scope]);
  return (
    <div className="vx-ex-stack">
      <div className="vx-ex-toolbar">
        <ScopeLabel scope={scope} />
        <Button
          variant="outline"
          type="button"
          disabled={state.type === "loading"}
          onClick={() => void resource.load(scope)}
        >
          Refresh decision inbox
        </Button>
      </div>
      <ResourcePanel
        state={state}
        title="Decision inbox"
        retry={() => void resource.load(scope)}
      >
        {(inbox) => <TodayDecisionInbox inbox={inbox} scope={scope} />}
      </ResourcePanel>
    </div>
  );
};

export interface TodayWorkspaceProps {
  // Sector rotation card loader; defaults to the browser API client.
  readonly sectorRotation?: (() => Promise<SectorRotationSnapshot>) | undefined;
}

export const TodayWorkspace = ({
  sectorRotation,
}: TodayWorkspaceProps = {}) => {
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  return (
    <ExperienceFrame title="Decision inbox">
      <SectorRotationChanges load={sectorRotation} />
      <ScopeChooser
        onSelect={setScope}
        onRetire={() => setScope(null)}
        label="Decision inbox account scope"
      />
      {scope === null ? null : (
        <ScopedToday key={JSON.stringify(scope)} scope={scope} />
      )}
    </ExperienceFrame>
  );
};
