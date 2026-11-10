"use client";

import {
  type ApiClient,
  createApiClient,
  type PlayStatus,
  type PlaysListOutput,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Plays view (plays.list): potential option trades stored in Postgres (plays table). Read-only
// ideas: nothing on this page places, stages, approves or sizes an order.

export interface PlaysGateway {
  readonly list: () => Promise<PlaysListOutput>;
}

export const createBrowserPlaysGateway = (): PlaysGateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    list: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.plays.list({});
    },
  });
};

export const PLAYS_INTRO =
  "Potential option trades. Ideas only: nothing here places an order. Every play needs a defined max loss (≤2% NLV) and an exit rule.";

const STATUS_TONE: Readonly<
  Record<PlayStatus, "info" | "neutral" | "success" | "warning">
> = {
  armed: "warning",
  dropped: "info",
  idea: "neutral",
  taken: "success",
};

const usd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: PlaysListOutput }>;

export const PlaysWorkspace = ({
  gateway: supplied,
}: Readonly<{ gateway?: PlaysGateway }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserPlaysGateway());
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    try {
      return setState({ data: await gateway.list(), type: "ready" });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      return setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { message: `${failure.code}: ${failure.message}`, type: "error" }
      );
    }
  }, [gateway]);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="plays" />;
  if (state.type === "loading")
    return (
      <p
        aria-busy="true"
        className="text-muted-foreground text-sm"
        role="status"
      >
        Loading plays…
      </p>
    );
  if (state.type === "error")
    return (
      <div className="space-y-3" data-plays-state="error">
        <p className="text-sm" role="alert">
          Plays list unavailable. {state.message}
        </p>
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );

  const { data } = state;
  return (
    <div className="space-y-6" data-plays-state="ready">
      <Panel
        description={<span role="note">{PLAYS_INTRO}</span>}
        flush={data.plays.length > 0}
        title="Potential plays"
      >
        {data.plays.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-plays-empty="">
            No plays yet.
          </p>
        ) : (
          <Table className="text-sm">
            <TableCaption className="sr-only">Potential plays</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Ticker</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Thesis</TableHead>
                <TableHead scope="col">Structure</TableHead>
                <TableHead scope="col">Legs</TableHead>
                <TableHead className="text-right" scope="col">
                  Max loss
                </TableHead>
                <TableHead scope="col">Risk</TableHead>
                <TableHead scope="col">Trigger</TableHead>
                <TableHead scope="col">Exit</TableHead>
                <TableHead scope="col">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.plays.map((play) => {
                // The server accepts only https sources; checked again before it becomes a link.
                const href = play.sourceUrl?.startsWith("https://")
                  ? play.sourceUrl
                  : null;
                return (
                  <TableRow data-play={play.id} key={play.id}>
                    <TableHead
                      className="h-auto whitespace-normal font-mono"
                      scope="row"
                    >
                      {play.ticker}
                    </TableHead>
                    <TableCell>
                      <StatusBadge
                        data-play-status={play.status}
                        status={STATUS_TONE[play.status]}
                      >
                        {play.status}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      {play.thesis}
                      {play.notes === null ? null : (
                        <span className="block text-muted-foreground text-xs">
                          {play.notes}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-40 whitespace-normal">
                      {play.structure}
                    </TableCell>
                    <TableCell className="min-w-48" data-play-legs="">
                      <ul className="space-y-0.5 font-mono text-xs">
                        {play.legs.map((leg) => (
                          <li
                            data-play-leg=""
                            key={`${leg.side}-${leg.right}-${leg.strike}-${leg.expiry}`}
                          >
                            {leg.side} {leg.quantity} {leg.expiry} {leg.strike}{" "}
                            {leg.right}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell
                      className="text-right tabular-nums"
                      data-play-max-loss=""
                    >
                      {usd.format(play.maxLossUsd)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge data-play-defined-risk="" status="success">
                        Defined risk
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="min-w-32 whitespace-normal">
                      {play.trigger}
                    </TableCell>
                    <TableCell className="min-w-32 whitespace-normal">
                      {play.exitRule}
                    </TableCell>
                    <TableCell>
                      {href === null ? (
                        "—"
                      ) : (
                        <a
                          className="underline underline-offset-2"
                          href={href}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          source
                        </a>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
      <p className="text-muted-foreground text-xs">
        Read-only. Plays are added server-side; there are no order or approve
        actions here.
      </p>
    </div>
  );
};
