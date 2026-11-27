"use client";

import {
  type ApiClient,
  createApiClient,
  type ResearchScreenStatusOutput,
} from "@darkfactory/api";
import {
  Button,
  PageHeader,
  Panel,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { ArrowLeft, RotateCcw } from "lucide-react";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  formatScreenTime,
  type ResearchScreenContextView,
  type ResearchScreenRowView,
  type ResearchScreenRunView,
  type ResearchScreenSlotView,
  type ResearchScreenSnapshotView,
  type ResearchScreenViewModel,
  toResearchScreenViewModel,
} from "../../features/research-screen/view-model.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Research screen page (researchScreen.status): the scheduler, the runs, the slots, the stored
// rows and the third-party context. Read-only and operator-only. Research only: no order path.

export interface ResearchScreenGateway {
  readonly status: () => Promise<ResearchScreenStatusOutput>;
}

export const createBrowserResearchScreenGateway = (): ResearchScreenGateway => {
  let client: ApiClient | undefined;
  const api = () => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    status: () => api().researchScreen.status({}),
  });
};

/** The page reloads at this interval while a run is active. */
export const RESEARCH_SCREEN_RELOAD_MS = 60_000;
/** The page reloads at this interval while no run is active. */
const IDLE_RELOAD_MS = 5 * RESEARCH_SCREEN_RELOAD_MS;

type Load =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: ResearchScreenStatusOutput }>;

/**
 * Loads the status on mount, then again on a timer: every minute while a run is active, every 5
 * minutes when idle. Only the newest request may set state, so a slow older response never
 * replaces a newer one. A timer reload is quiet: it keeps the shown status until the new one
 * arrives, and a failure only sets `reloadFailedAt` (an operator-only answer still ends the page).
 */
const useScreenStatus = (gateway: ResearchScreenGateway) => {
  const [state, setState] = useState<Load>({ type: "loading" });
  const [reloadFailedAt, setReloadFailedAt] = useState<Date | null>(null);
  const latest = useRef(0);
  const load = useCallback(
    async (quiet: boolean) => {
      latest.current += 1;
      const request = latest.current;
      if (!quiet) {
        setState({ type: "loading" });
        setReloadFailedAt(null);
      }
      try {
        const data = await gateway.status();
        if (request !== latest.current) return;
        setState({ data, type: "ready" });
        setReloadFailedAt(null);
      } catch (error) {
        if (request !== latest.current) return;
        const failure = describePortfolioMonitorFailure(error);
        if (failure.kind === "forbidden") setState({ type: "forbidden" });
        else if (quiet) setReloadFailedAt(new Date());
        else
          setState({
            message: `${failure.code}: ${failure.message}`,
            type: "error",
          });
      }
    },
    [gateway]
  );
  useEffect(() => {
    void load(false);
    return () => {
      latest.current += 1;
    };
  }, [load]);
  const ready = state.type === "ready";
  const active = ready && state.data.activeRun !== null;
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(
      () => void load(true),
      active ? RESEARCH_SCREEN_RELOAD_MS : IDLE_RELOAD_MS
    );
    return () => clearInterval(timer);
  }, [active, load, ready]);
  return { load, reloadFailedAt, state };
};

/** Header chip: the load state, then the scheduler state. */
const headerStatus = (
  state: Load,
  view: ResearchScreenViewModel | null
): ReactNode => {
  if (view !== null)
    return (
      <StatusBadge status={view.scheduler.tone}>
        {view.scheduler.label}
      </StatusBadge>
    );
  if (state.type === "forbidden")
    return <StatusBadge status="warning">Operator only</StatusBadge>;
  if (state.type === "error")
    return <StatusBadge status="destructive">Load failed</StatusBadge>;
  return <StatusBadge status="neutral">Loading</StatusBadge>;
};

const RunLine = ({
  heading,
  run,
}: {
  readonly heading: string;
  readonly run: ResearchScreenRunView;
}) => (
  <li className="space-y-1" data-research-screen-run={run.id}>
    <p className="flex flex-wrap items-center gap-2 font-medium">
      <span>
        {heading}: {run.title}
      </span>
      <StatusBadge status={run.tone}>{run.statusLabel}</StatusBadge>
    </p>
    {run.progressPercent !== null && (
      <progress
        aria-label={`${heading} progress`}
        className="block h-2 w-full max-w-sm"
        max={100}
        value={run.progressPercent}
      />
    )}
    <p className="text-muted-foreground">{run.detail}</p>
    <p className="text-muted-foreground">
      {run.timing}
      {run.slotLabels !== "" && ` · ${run.slotLabels}`}
    </p>
    {run.message !== null && <p>{run.message}</p>}
  </li>
);

const SlotList = ({
  empty,
  slots,
}: {
  readonly empty: string;
  readonly slots: readonly ResearchScreenSlotView[];
}) =>
  slots.length === 0 ? (
    <p className="text-muted-foreground text-sm">{empty}</p>
  ) : (
    <ul className="space-y-1 text-sm">
      {slots.map((slot) => (
        <li className="flex flex-wrap gap-x-2" key={slot.key}>
          <span className="tabular-nums">{slot.time}</span>
          {slot.labels !== "" && (
            <span className="text-muted-foreground">{slot.labels}</span>
          )}
        </li>
      ))}
    </ul>
  );

const TextList = ({
  items,
  label,
}: {
  readonly items: readonly string[];
  readonly label: string;
}) =>
  items.length > 0 && (
    <div>
      <span className="font-medium">{label}: </span>
      {items.join("; ")}
    </div>
  );

const RowNotes = ({ row }: { readonly row: ResearchScreenRowView }) => (
  <div className="min-w-64 space-y-1 whitespace-normal">
    {row.collectionNote !== null && <div>{row.collectionNote}</div>}
    {row.errorCode !== null && <div>Error code: {row.errorCode}</div>}
    <TextList items={row.blockingWarnings} label="Blocking" />
    <TextList items={row.warnings} label="Warnings" />
    <TextList items={row.reasons} label="Reasons" />
  </div>
);

const RowsTable = ({
  rows,
}: {
  readonly rows: readonly ResearchScreenRowView[];
}) => (
  <TableScroll label="Research screen rows" minWidth="72rem">
    <Table>
      <TableCaption className="sr-only">
        Screen result per report, in catalog order
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Symbol</TableHead>
          <TableHead scope="col">Action</TableHead>
          <TableHead numeric scope="col">
            Score
          </TableHead>
          <TableHead numeric scope="col">
            Price
          </TableHead>
          <TableHead numeric scope="col">
            Change
          </TableHead>
          <TableHead scope="col">Quote age</TableHead>
          <TableHead scope="col">Buy zone</TableHead>
          <TableHead numeric scope="col">
            Support
          </TableHead>
          <TableHead numeric scope="col">
            Stop
          </TableHead>
          <TableHead numeric scope="col">
            Target
          </TableHead>
          <TableHead numeric scope="col">
            Reward to risk
          </TableHead>
          <TableHead scope="col">Sources</TableHead>
          <TableHead scope="col">Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow data-research-screen-row={row.id} key={row.id}>
            <TableHead
              className="h-auto whitespace-normal font-medium"
              scope="row"
            >
              {row.symbol}
            </TableHead>
            <TableCell>
              <StatusBadge status={row.actionTone}>
                {row.actionLabel}
              </StatusBadge>
              {row.storedActionLabel !== null && (
                <div className="text-muted-foreground text-xs">
                  Last action: {row.storedActionLabel}
                </div>
              )}
            </TableCell>
            <TableCell numeric>{row.score}</TableCell>
            <TableCell numeric>{row.price}</TableCell>
            <TableCell numeric>{row.change}</TableCell>
            <TableCell>{row.quoteAge}</TableCell>
            <TableCell>{row.buyZone}</TableCell>
            <TableCell numeric>{row.support}</TableCell>
            <TableCell numeric>{row.stop}</TableCell>
            <TableCell numeric>{row.target}</TableCell>
            <TableCell numeric>{row.rewardRisk}</TableCell>
            <TableCell>{row.sources}</TableCell>
            <TableCell>
              <RowNotes row={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableScroll>
);

const SnapshotBody = ({
  snapshot,
}: {
  readonly snapshot: ResearchScreenSnapshotView;
}) => (
  <>
    {snapshot.groups.map((group) => (
      <div data-research-screen-group={group.title} key={group.title}>
        <h3 className="font-medium">{group.title}</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          {group.items.map((item) => (
            <div key={item.label}>
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    ))}
    <div data-research-screen-themes="">
      <h3 className="font-medium">Themes</h3>
      {snapshot.themes.length === 0 ? (
        <p className="text-muted-foreground">No theme is in the snapshot.</p>
      ) : (
        <TableScroll label="Third-party themes" minWidth="20rem">
          <Table>
            <TableCaption className="sr-only">
              Themes of the third-party snapshot
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Theme</TableHead>
                <TableHead numeric scope="col">
                  Change
                </TableHead>
                <TableHead scope="col">Bias</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.themes.map((theme) => (
                <TableRow key={theme.name}>
                  <TableHead
                    className="h-auto whitespace-normal font-normal"
                    scope="row"
                  >
                    {theme.name}
                  </TableHead>
                  <TableCell numeric>{theme.change}</TableCell>
                  <TableCell>{theme.bias}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      )}
    </div>
    <div data-research-screen-setups="">
      <h3 className="font-medium">Setups</h3>
      {snapshot.setups.length === 0 ? (
        <p className="text-muted-foreground">No setup is in the snapshot.</p>
      ) : (
        <TableScroll label="Third-party setups" minWidth="32rem">
          <Table>
            <TableCaption className="sr-only">
              Setups of the third-party snapshot
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Ticker</TableHead>
                <TableHead scope="col">Direction</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Pattern</TableHead>
                <TableHead scope="col">Sector</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.setups.map((setup) => (
                <TableRow
                  key={`${setup.ticker}-${setup.direction}-${setup.pattern}`}
                >
                  <TableHead
                    className="h-auto whitespace-normal font-normal"
                    scope="row"
                  >
                    {setup.ticker}
                  </TableHead>
                  <TableCell>{setup.direction}</TableCell>
                  <TableCell>{setup.name}</TableCell>
                  <TableCell>{setup.pattern}</TableCell>
                  <TableCell>{setup.sector}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      )}
    </div>
  </>
);

const ContextPanel = ({
  context,
}: {
  readonly context: ResearchScreenContextView;
}) => (
  <Panel
    data-research-screen-context=""
    description={context.warning}
    headingId="research-screen-context"
    title="Third-party context"
  >
    <div className="space-y-3 text-sm">
      {context.stale && (
        <p>
          <StatusBadge status="warning">Stale</StatusBadge> The snapshot is more
          than 4 hours old or carries a time in the future.
        </p>
      )}
      <p className="text-muted-foreground">
        Generated {context.generated} · retrieved {context.retrieved}
      </p>
      {context.lastError !== null && (
        <p role="note">Last retrieval error: {context.lastError}</p>
      )}
      {context.snapshot === null ? (
        <p>No snapshot is stored yet.</p>
      ) : (
        <SnapshotBody snapshot={context.snapshot} />
      )}
    </div>
  </Panel>
);

const ScreenBody = ({ view }: { readonly view: ResearchScreenViewModel }) => (
  <div className="space-y-6">
    <Panel headingId="research-screen-scheduler" title="Scheduler and runs">
      <div className="space-y-3 text-sm">
        <p>
          {view.scheduler.label} · last tick: {view.scheduler.lastTick}
        </p>
        {view.activeRun === null && view.lastRun === null ? (
          <p className="text-muted-foreground">No run is stored yet.</p>
        ) : (
          <ul className="space-y-3">
            {view.activeRun !== null && (
              <RunLine heading="Active run" run={view.activeRun} />
            )}
            {view.lastRun !== null && (
              <RunLine heading="Last run" run={view.lastRun} />
            )}
          </ul>
        )}
      </div>
    </Panel>
    <Panel headingId="research-screen-slots" title="Slots">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="font-medium text-sm">Next slots</h3>
          <SlotList empty="No slot is planned." slots={view.nextSlots} />
        </div>
        <div className="space-y-2">
          <h3 className="font-medium text-sm">Missed in the last 24 hours</h3>
          <SlotList empty="No slot was missed." slots={view.missedSlots} />
        </div>
      </div>
    </Panel>
    <Panel
      flush
      headingId="research-screen-rows"
      title={`Reports (${view.rows.length})`}
    >
      {view.rows.length === 0 ? (
        <p className="p-4 text-muted-foreground text-sm">
          No row is stored yet. The first run fills this table.
        </p>
      ) : (
        <RowsTable rows={view.rows} />
      )}
    </Panel>
    {view.context !== null && <ContextPanel context={view.context} />}
    <Panel headingId="research-screen-limitations" title="Limitations">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {view.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </Panel>
  </div>
);

const ScreenGate = ({
  onRetry,
  state,
  view,
}: {
  readonly onRetry: () => void;
  readonly state: Load;
  readonly view: ResearchScreenViewModel | null;
}) => {
  if (view !== null) return <ScreenBody view={view} />;
  if (state.type === "forbidden")
    return (
      <p className="min-h-40 text-muted-foreground text-sm" role="status">
        The research screen is limited to operators.
      </p>
    );
  if (state.type === "error")
    return (
      <div className="min-h-40 space-y-3">
        <p className="text-sm" role="alert">
          The research screen did not load. {state.message}
        </p>
        <Button className="min-h-11" onClick={onRetry} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );
  return (
    <div aria-busy="true" className="min-h-40 space-y-2" role="status">
      <span className="sr-only">Loading the research screen</span>
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
};

export const ResearchScreenWorkspace = ({
  gateway: supplied,
}: Readonly<{ gateway?: ResearchScreenGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchScreenGateway()
  );
  const { load, reloadFailedAt, state } = useScreenStatus(gateway);
  const view =
    state.type === "ready" ? toResearchScreenViewModel(state.data) : null;
  return (
    <div className="space-y-6" data-research-screen-state={state.type}>
      <PageHeader
        actions={
          view === null ? undefined : (
            <>
              <span
                className="text-muted-foreground text-sm"
                data-research-screen-as-of=""
              >
                As of {view.asOf}
              </span>
              <Button
                className="min-h-11"
                onClick={() => void load(false)}
                variant="outline"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                Reload
              </Button>
            </>
          )
        }
        breadcrumb={
          <nav aria-label="Breadcrumb">
            <Link
              className="inline-flex min-h-11 items-center gap-1 hover:text-foreground"
              href="/research"
              prefetch={false}
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Research
            </Link>
          </nav>
        }
        description="Scheduled screen of the catalog reports against public price data."
        status={headerStatus(state, view)}
        title="Research screen"
      />
      {view !== null && reloadFailedAt !== null && (
        <p
          className="text-muted-foreground text-sm"
          data-research-screen-reload-note=""
          role="status"
        >
          Reload failed at {formatScreenTime(reloadFailedAt)}; showing data as
          of {view.asOf}
        </p>
      )}
      <ScreenGate onRetry={() => void load(false)} state={state} view={view} />
    </div>
  );
};
