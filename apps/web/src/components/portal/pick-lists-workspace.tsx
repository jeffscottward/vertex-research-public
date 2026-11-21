"use client";

import {
  BASKET_SYMBOL_PATTERN,
  PICK_LIST_GATES,
  type PickListGate,
  type PickListMemberOutput,
  type PickListOutput,
  type PickListScreenMemberOutput,
  type PickListScreenOutput,
  type PickListScreenStatus,
  type SectorRotationQuadrant,
} from "@darkfactory/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  StatusBadge,
  type StatusBadgeProps,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Play,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { PickListImportPanel } from "./pick-list-import-panel.tsx";
import { PickListProposalPanel } from "./pick-list-proposal-panel.tsx";
import {
  createBrowserPickListGateway,
  defaultBucketSymbol,
  describePickListFailure,
  METHOD_LABELS,
  type PickListBucketResult,
  type PickListGateway,
  STATUS_LABELS,
} from "./pick-lists-client.ts";
import { QUADRANT_CHIP, QUADRANT_LABELS } from "./sector-rotation-chart.tsx";

export interface PickListsWorkspaceProps {
  readonly gateway?: PickListGateway;
}

type ScreenState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: PickListScreenOutput }>
  | Readonly<{ type: "error"; message: string }>;

type BucketState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "saving" }>
  | Readonly<{ type: "done"; symbol: string; result: PickListBucketResult }>
  | Readonly<{ type: "error"; message: string }>;

const GATE_LABELS: Readonly<Record<PickListGate, string>> = {
  aboveVwap20: "Above 20-day VWAP",
  emaTrend: "EMA 20 over EMA 50 trend",
  notOverextended: "Not overextended",
};

const STATUS_TONE: Readonly<
  Record<PickListScreenStatus, StatusBadgeProps["status"]>
> = {
  fail: "destructive",
  no_data: "neutral",
  not_evaluated: "neutral",
  not_screened: "neutral",
  pass: "success",
};

// The cause shown next to the status: the screen's reason, or the first gate without a verdict and its detail.
const statusDetail = (screened: PickListScreenMemberOutput): string | null => {
  if (screened.reason !== null) return screened.reason;
  const open = PICK_LIST_GATES.find((gate) => screened.gates[gate].ok === null);
  return open === undefined
    ? null
    : `${GATE_LABELS[open]}: ${screened.gates[open].detail}`;
};

const GateBadge = ({
  gate,
  ok,
  detail,
}: Readonly<{ gate: PickListGate; ok: boolean | null; detail: string }>) => {
  const verdict = ok === null ? "not-evaluated" : ok ? "pass" : "fail";
  const Icon = ok === null ? CircleHelp : ok ? CircleCheck : CircleX;
  const tone =
    ok === null
      ? "text-muted-foreground"
      : ok
        ? "text-success-foreground"
        : "text-destructive";
  return (
    <span
      className={`inline-flex size-6 items-center justify-center ${tone}`}
      data-gate={gate}
      data-verdict={verdict}
      title={`${GATE_LABELS[gate]}: ${detail}`}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only">{`${GATE_LABELS[gate]} ${ok === null ? "not evaluated" : verdict}: ${detail}`}</span>
    </span>
  );
};

const Quadrant = ({
  quadrant,
  reason,
}: Readonly<{
  quadrant: SectorRotationQuadrant | null;
  reason: string | null | undefined;
}>) => {
  if (quadrant === null)
    return (
      <span className="text-muted-foreground">
        {reason ?? "Not computed; the server sent no reason"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`size-2.5 rounded-full ${QUADRANT_CHIP[quadrant]}`}
      />
      {QUADRANT_LABELS[quadrant]}
    </span>
  );
};

const ScreenStatusCell = ({
  screened,
}: Readonly<{ screened: PickListScreenMemberOutput }>) => {
  const detail = statusDetail(screened);
  return (
    <TableCell>
      <StatusBadge
        status={STATUS_TONE[screened.status]}
        title={detail ?? undefined}
      >
        {STATUS_LABELS[screened.status]}
      </StatusBadge>
      {detail === null ? null : (
        <span className="ml-2 text-muted-foreground text-xs">{detail}</span>
      )}
    </TableCell>
  );
};

// Why a member row has no screen result, by the state of this card's screen run.
const NO_SCREEN_TEXT: Readonly<Record<ScreenState["type"], string>> = {
  error:
    "Not screened: the last screen run failed. See the message above this table.",
  idle: "Not screened yet. Select Run screen.",
  loading: "Screening now.",
  ready:
    "Not screened: this member is not in the last screen result. Run the screen again.",
};

const MemberRow = ({
  member,
  screened,
  screenState,
}: Readonly<{
  member: PickListMemberOutput;
  screened: PickListScreenMemberOutput | undefined;
  screenState: ScreenState["type"];
}>) => (
  <TableRow>
    <TableHead
      className="h-auto whitespace-normal font-medium font-mono"
      scope="row"
    >
      <span title={member.thesis ?? undefined}>{member.symbol}</span>
    </TableHead>
    <TableCell className="text-right">
      {member.rank ?? "No rank in import"}
    </TableCell>
    <TableCell>{member.rating ?? "No rating in import"}</TableCell>
    <TableCell className="text-right">
      {member.targetPrice === null
        ? "No target in import"
        : member.targetPrice.toFixed(2)}
    </TableCell>
    <TableCell>
      {member.sector ?? "Not in import"}
      {screened?.sectorEtf ? (
        <span className="ml-1 font-mono text-muted-foreground text-xs">
          {screened.sectorEtf}
        </span>
      ) : null}
    </TableCell>
    {screened === undefined ? (
      // One cell across Gates, Status and both quadrants: the four share one cause.
      <TableCell className="text-muted-foreground" colSpan={4}>
        {NO_SCREEN_TEXT[screenState]}
      </TableCell>
    ) : (
      <>
        <TableCell>
          <span className="inline-flex gap-1">
            {PICK_LIST_GATES.map((gate) => (
              <GateBadge
                detail={screened.gates[gate].detail}
                gate={gate}
                key={gate}
                ok={screened.gates[gate].ok}
              />
            ))}
          </span>
        </TableCell>
        <ScreenStatusCell screened={screened} />
        <TableCell>
          <Quadrant
            quadrant={screened.quadrant}
            reason={screened.quadrantReason}
          />
        </TableCell>
        <TableCell>
          <Quadrant
            quadrant={screened.sectorQuadrant}
            reason={screened.sectorQuadrantReason}
          />
        </TableCell>
      </>
    )}
  </TableRow>
);

const BucketControl = ({
  list,
  gateway,
  onSynced,
}: Readonly<{
  list: PickListOutput;
  gateway: PickListGateway;
  onSynced: (list: PickListOutput) => void;
}>) => {
  const fieldId = useId();
  const [symbol, setSymbol] = useState(
    () => list.bucketSymbol ?? defaultBucketSymbol(list.slug)
  );
  const [state, setState] = useState<BucketState>({ type: "idle" });
  const [invalid, setInvalid] = useState(false);

  const sync = async (bucketSymbol: string) => {
    if (!BASKET_SYMBOL_PATTERN.test(bucketSymbol)) return setInvalid(true);
    setInvalid(false);
    setState({ type: "saving" });
    try {
      const result = await gateway.syncBucket(list.id, bucketSymbol);
      setState({ result, symbol: bucketSymbol, type: "done" });
      return onSynced(result.list);
    } catch (error) {
      return setState({
        message: describePickListFailure(error),
        type: "error",
      });
    }
  };

  const saving = state.type === "saving";
  const bucket = list.bucketSymbol;
  return (
    <div className="space-y-2">
      {bucket === null ? (
        <form
          aria-label={`Make bucket from ${list.name}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            return void sync(symbol);
          }}
        >
          <label className="space-y-1 text-sm" htmlFor={fieldId}>
            <span className="block">Bucket symbol</span>
            <Input
              aria-describedby={invalid ? `${fieldId}-error` : undefined}
              className="w-36 font-mono"
              id={fieldId}
              invalid={invalid}
              maxLength={10}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              required
              value={symbol}
            />
          </label>
          <Button
            loading={saving}
            loadingLabel="Making bucket"
            type="submit"
            variant="secondary"
          >
            Make bucket
          </Button>
          {invalid ? (
            <p
              className="w-full text-destructive text-sm"
              id={`${fieldId}-error`}
            >
              Use a letter, then up to 9 letters or digits.
            </p>
          ) : null}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <a
            className="inline-flex min-h-11 items-center font-medium text-sm underline underline-offset-4"
            href={`/baskets?symbol=${encodeURIComponent(bucket)}`}
          >
            Bucket {bucket}
          </a>
          <Button
            aria-label={`Refresh bucket ${bucket} from the latest snapshot`}
            loading={saving}
            loadingLabel="Refreshing bucket"
            onClick={() => void sync(bucket)}
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh bucket
          </Button>
        </div>
      )}
      {state.type === "done" ? (
        <p className="text-sm" role="status">
          {`Bucket ${state.symbol} holds ${state.result.memberCount} members.`}
          {state.result.omitted.length > 0
            ? ` ${state.result.omitted.length} omitted (a basket holds at most 50): ${state.result.omitted.join(", ")}.`
            : ""}
        </p>
      ) : null}
      {state.type === "error" ? (
        <p className="text-destructive text-sm" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
};

const PickListCard = ({
  list,
  gateway,
  onSynced,
}: Readonly<{
  list: PickListOutput;
  gateway: PickListGateway;
  onSynced: (list: PickListOutput) => void;
}>) => {
  const [screen, setScreen] = useState<ScreenState>({ type: "idle" });

  const runScreen = async () => {
    setScreen({ type: "loading" });
    try {
      const data = await gateway.screen(list.id);
      return setScreen({ data, type: "ready" });
    } catch (error) {
      return setScreen({
        message: describePickListFailure(error),
        type: "error",
      });
    }
  };

  const screened = new Map(
    screen.type === "ready"
      ? screen.data.members.map((member) => [member.symbol, member] as const)
      : []
  );
  const loading = screen.type === "loading";
  return (
    <Card aria-label={list.name} role="region">
      <CardHeader>
        <CardTitle headingLevel={2}>{list.name}</CardTitle>
        <CardDescription>
          {list.sourceLabel} · as of {list.latest.asOf} ·{" "}
          {METHOD_LABELS[list.latest.method]} · {list.snapshotCount}{" "}
          {list.snapshotCount === 1 ? "snapshot" : "snapshots"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <BucketControl gateway={gateway} list={list} onSynced={onSynced} />
          <Button
            loading={loading}
            loadingLabel="Screening"
            onClick={() => void runScreen()}
            type="button"
          >
            <Play aria-hidden="true" className="size-4" />
            Run screen
          </Button>
        </div>
        {screen.type === "ready" ? (
          <p className="text-muted-foreground text-xs" role="status">
            Screened {screen.data.computedAt} from daily bars.
          </p>
        ) : null}
        {screen.type === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {screen.message}
          </p>
        ) : null}
        <Table>
          <TableCaption className="sr-only">
            {`${list.name} members as of ${list.latest.asOf}`}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Symbol</TableHead>
              <TableHead className="text-right" scope="col">
                Rank
              </TableHead>
              <TableHead scope="col">Rating</TableHead>
              <TableHead className="text-right" scope="col">
                Target
              </TableHead>
              <TableHead scope="col">Sector</TableHead>
              <TableHead scope="col">Gates</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Quadrant</TableHead>
              <TableHead scope="col">Sector quadrant</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.latest.members.map((member) => (
              <MemberRow
                key={member.symbol}
                member={member}
                screened={screened.get(member.symbol)}
                screenState={screen.type}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};

export const PickListsWorkspace = ({
  gateway: suppliedGateway,
}: PickListsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserPickListGateway()
  );
  const [items, setItems] = useState<readonly PickListOutput[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await gateway.list());
      setLoaded(true);
      return setListError(null);
    } catch (error) {
      return setListError(describePickListFailure(error));
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (next: PickListOutput) =>
    setItems((current) =>
      current.map((item) => (item.id === next.id ? next : item))
    );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Research only — not an order. A pick, a gate or a quadrant never
        authorizes a trade.
      </p>
      {listError === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-destructive text-sm" role="alert">
            {listError}
          </p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            <RefreshCw aria-hidden="true" className="size-4" />
            Retry
          </Button>
        </div>
      )}
      {!loaded && listError === null ? (
        <p
          aria-live="polite"
          className="text-muted-foreground text-sm"
          role="status"
        >
          Loading pick lists…
        </p>
      ) : null}
      {loaded ? (
        <PickListProposalPanel gateway={gateway} lists={items} />
      ) : null}
      <PickListImportPanel gateway={gateway} onImported={() => void load()} />
      {loaded && items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No pick lists. Import one above.
        </p>
      ) : null}
      {items.map((list) => (
        <PickListCard
          gateway={gateway}
          key={list.id}
          list={list}
          onSynced={replace}
        />
      ))}
    </div>
  );
};
