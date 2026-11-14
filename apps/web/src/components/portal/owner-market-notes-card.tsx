"use client";

// What: the "Owner market notes" card on /markets (marketNotes.list, scope "all"): the dated
// narrative context the owner sent (a reel, an article or plain text), each note with its source,
// stance, review date, affected area and its claims with a verification status each. Active notes
// come first, then stale ones (review date passed); retired notes are only counted. Read only:
// nothing here creates, changes or routes an order, the arm state, a size or a risk setting.
// Used by: apps/web/src/app/(portal)/markets/page.tsx.
// See: owner-market-notes-model.ts (labels and order), packages/api/src/contracts/market-notes.ts.
import {
  type ApiClient,
  createApiClient,
  type MarketNotesListOutput,
} from "@darkfactory/api";
import { Button, cn, Panel, StatusBadge } from "@darkfactory/ui";
import { ChevronDown, ExternalLink, RotateCcw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";
import {
  buildOwnerMarketNotesView,
  type OwnerMarketNoteClaimView,
  type OwnerMarketNoteSourceView,
  type OwnerMarketNoteView,
} from "./owner-market-notes-model.ts";

export interface OwnerMarketNotesGateway {
  readonly list: () => Promise<MarketNotesListOutput>;
}

export const createBrowserOwnerMarketNotesGateway =
  (): OwnerMarketNotesGateway => {
    let client: ApiClient | undefined;
    return Object.freeze({
      list: () => {
        client ??= createApiClient({ baseUrl: window.location.origin });
        return client.marketNotes.list({ scope: "all" });
      },
    });
  };

export const OWNER_MARKET_NOTES_REFRESH_MS = 60_000;

const OWNER_MARKET_NOTES_SCOPE_LINE =
  "Research context only. A claim is a fact only when its status is Supported. Notes never change orders, arming, sizing or risk settings.";

type CardState = "empty" | "error" | "forbidden" | "loading" | "ready";

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      data: MarketNotesListOutput;
      /** A failed periodic refresh: the last good data stays on screen. */
      refreshError?: string;
    }>;

const errorMessage = (error: unknown): string => {
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : undefined;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "Request failed.";
};

const Shell = ({
  children,
  state,
}: Readonly<{ children: ReactNode; state: CardState }>) => (
  <Panel
    contentClassName="space-y-4"
    data-owner-market-notes={state}
    description={OWNER_MARKET_NOTES_SCOPE_LINE}
    headingId="owner-market-notes-title"
    title="Owner market notes"
  >
    {children}
  </Panel>
);

const Fact = ({
  children,
  label,
}: Readonly<{ children: ReactNode; label: string }>) => (
  <div className="min-w-0">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="wrap-anywhere text-sm">{children}</dd>
  </div>
);

// The link is a 44px target. Its vertical padding is given back by the negative margin, so one
// line or a wrapped label takes only its text height in the row.
const SourceValue = ({
  source,
}: Readonly<{ source: OwnerMarketNoteSourceView }>) =>
  source.href === null ? (
    source.label
  ) : (
    <a
      className="-my-3 inline-block min-h-11 min-w-11 py-3 underline underline-offset-4"
      href={source.href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {source.label}
      <ExternalLink
        aria-hidden="true"
        className="ml-1 inline size-3.5 align-text-bottom"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );

// At 375px the status sits above the claim text; from `sm` it takes a fixed column beside it.
const ClaimRow = ({ claim }: Readonly<{ claim: OwnerMarketNoteClaimView }>) => (
  <li
    className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3"
    data-claim-status={claim.status}
  >
    <div className="sm:w-32 sm:shrink-0">
      <StatusBadge status={claim.tone}>{claim.statusLabel}</StatusBadge>
    </div>
    <div className="min-w-0 space-y-1">
      <p className="wrap-anywhere text-sm" data-claim-text="">
        {claim.text}
      </p>
      {claim.check === null ? null : (
        <>
          <p
            className="wrap-anywhere whitespace-pre-line text-muted-foreground text-sm"
            data-claim-evidence=""
          >
            <span className="font-medium text-foreground">Evidence: </span>
            {claim.check.evidence}
          </p>
          <p
            className="text-muted-foreground text-xs tabular-nums"
            data-claim-checked=""
          >
            Checked {claim.check.checkedOn}
          </p>
        </>
      )}
    </div>
  </li>
);

const NoteItem = ({ note }: Readonly<{ note: OwnerMarketNoteView }>) => {
  // An active note shows its claims at first. A stale note starts collapsed, so old notes do
  // not push the cards below far down. The choice then stays across refreshes.
  const [open, setOpen] = useState(note.stale === null);
  const claimsId = useId();
  return (
    <li
      className="space-y-3 py-4 first:pt-0 last:pb-0"
      data-note-status={note.stale === null ? "active" : "stale"}
      data-owner-market-note={note.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="wrap-anywhere min-w-0 font-medium text-base">
          {note.theme}
        </h3>
        <StatusBadge
          data-note-verification=""
          status={note.verificationBadge.tone}
        >
          {note.verificationBadge.label}
        </StatusBadge>
        {note.stale === null ? null : (
          <StatusBadge data-note-stale="" status="warning">
            {note.stale.label}
          </StatusBadge>
        )}
      </div>
      {note.stale === null ? null : (
        <p className="text-sm" data-note-stale-notice="">
          {note.stale.notice}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label="As of">
          <span className="tabular-nums">{note.asOf}</span>
        </Fact>
        <Fact label="Received">
          <span className="tabular-nums">{note.receivedOn}</span>
        </Fact>
        <Fact label="Review by">
          <span className="tabular-nums">{note.reviewBy}</span>
        </Fact>
        <Fact label="Source">
          <SourceValue source={note.source} />
        </Fact>
        <Fact label="Stance">{note.stanceLabel}</Fact>
        <Fact label="Claim checks">{note.verificationSummary}</Fact>
        {note.affected.map((group) => (
          <Fact key={group.label} label={group.label}>
            {group.values.join(", ")}
          </Fact>
        ))}
      </dl>
      <Button
        aria-controls={claimsId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        size="sm"
        variant="outline"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4", open && "rotate-180")}
        />
        {open ? "Hide" : "Show"} claims ({note.claims.length})
      </Button>
      <ol className="space-y-3 pt-3" hidden={!open} id={claimsId}>
        {note.claims.map((claim) => (
          <ClaimRow claim={claim} key={claim.id} />
        ))}
      </ol>
    </li>
  );
};

const OwnerMarketNotes = ({
  data,
  refreshError,
}: Readonly<{
  data: MarketNotesListOutput;
  refreshError?: string | undefined;
}>) => {
  const view = buildOwnerMarketNotesView(data);
  return (
    <Shell state={view.emptyText === null ? "ready" : "empty"}>
      {refreshError === undefined ? null : (
        <p
          className="text-destructive text-sm"
          data-owner-market-notes-refresh-error=""
          role="alert"
        >
          Refresh failed. {view.loadedLine} {refreshError}
        </p>
      )}
      {view.emptyText === null ? (
        <ul className="divide-y">
          {view.notes.map((note) => (
            <NoteItem key={note.id} note={note} />
          ))}
        </ul>
      ) : (
        <p
          className="text-muted-foreground text-sm"
          data-owner-market-notes-empty=""
        >
          {view.emptyText}
        </p>
      )}
      {view.retiredLine === null ? null : (
        <p
          className="text-muted-foreground text-sm"
          data-owner-market-notes-retired=""
        >
          {view.retiredLine}
        </p>
      )}
      {view.truncatedLine === null ? null : (
        <p
          className="text-muted-foreground text-sm"
          data-owner-market-notes-truncated=""
        >
          {view.truncatedLine}
        </p>
      )}
      <p
        className="text-muted-foreground text-xs"
        data-owner-market-notes-today=""
      >
        A note is stale when its review date is before {view.today} (UTC).
      </p>
    </Shell>
  );
};

export const OwnerMarketNotesCard = ({
  gateway: supplied,
}: Readonly<{ gateway?: OwnerMarketNotesGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserOwnerMarketNotesGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  // Each load takes the next number; only the newest may write, so a slow older answer (the
  // timer or Retry overlapping) never overwrites a newer one.
  const latest = useRef(0);
  const load = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    try {
      const data = await gateway.list();
      if (request === latest.current) setState({ data, type: "ready" });
    } catch (error) {
      if (request !== latest.current) return;
      setState((previous) => {
        if (isOperatorAccessDenied(error)) return { type: "forbidden" };
        const message = errorMessage(error);
        // A failed refresh keeps the last good data and reports the failure inline.
        return previous.type === "ready"
          ? { data: previous.data, refreshError: message, type: "ready" }
          : { message, type: "error" };
      });
    }
  }, [gateway]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(
      () => void load(),
      OWNER_MARKET_NOTES_REFRESH_MS
    );
    return () => {
      window.clearInterval(timer);
      // Unmount drops the answer still in flight.
      latest.current += 1;
    };
  }, [load]);

  if (state.type === "loading")
    return (
      <Shell state="loading">
        <p
          aria-busy="true"
          className="text-muted-foreground text-sm"
          role="status"
        >
          Loading owner market notes…
        </p>
      </Shell>
    );
  if (state.type === "forbidden")
    return (
      <Shell state="forbidden">
        <p className="text-muted-foreground text-sm" role="status">
          Operator access required.
        </p>
      </Shell>
    );
  if (state.type === "error")
    return (
      <Shell state="error">
        <p className="text-sm" role="alert">
          Owner market notes unavailable. {state.message}
        </p>
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry
        </Button>
      </Shell>
    );

  return (
    <OwnerMarketNotes data={state.data} refreshError={state.refreshError} />
  );
};
