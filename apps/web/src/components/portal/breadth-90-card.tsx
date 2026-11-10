"use client";

import {
  type ApiClient,
  type Breadth90GetOutput,
  type Breadth90State,
  type Breadth90Status,
  type Breadth90StoredEvent,
  createApiClient,
} from "@darkfactory/api";
import { Button, cn } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";
import { Breadth90Chart } from "./breadth-90-chart.tsx";

// Breadth-90 signal card (breadth90.get), the first thing on the markets page: the state the rig
// tick computed from NYSE up/down volume (ARMED after an 80%+ down day, FIRED on a 90% up day or
// two 80% up days while armed, FORMING when today's unfinished session meets that rule), the last
// 30 sessions, recent events and the dip basket. Read only: nothing here creates or routes an order.

export interface Breadth90Gateway {
  readonly get: () => Promise<Breadth90GetOutput>;
}

export const createBrowserBreadth90Gateway = (): Breadth90Gateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    get: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.breadth90.get({});
    },
  });
};

export const BREADTH90_REFRESH_MS = 60_000;

// FIRED is the loud one; the text label always names the state as well.
const STATE_STYLE: Readonly<Record<Breadth90State, string>> = {
  ARMED: "border-amber-500 bg-amber-300 text-amber-950",
  FIRED:
    "border-emerald-400 bg-emerald-700 text-white text-base ring-2 ring-emerald-400 ring-offset-2 ring-offset-background",
  FORMING: "border-orange-400 bg-orange-700 text-white",
  IDLE: "border-border bg-muted text-muted-foreground",
};
const CARD_BORDER: Readonly<Record<Breadth90State, string>> = {
  ARMED: "border-amber-500",
  FIRED: "border-emerald-600 border-2",
  FORMING: "border-orange-600 border-2",
  IDLE: "border-border",
};
const STATE_MEANING: Readonly<Record<Breadth90State, string>> = {
  ARMED:
    "Armed: an 80%+ down day is in the last 30 sessions. Waiting for a 90% up day or two 80% up days.",
  FIRED:
    "Fired: a 90% up day, or two 80% up days in a row, while armed (research signal, not an order).",
  FORMING:
    "Forming: today's unfinished session meets the fire rule. It counts only at the close.",
  IDLE: "Idle: no 80%+ down day in the last 30 sessions.",
};

const pct = (value: number | null): string =>
  // Two decimals, so a reading just under a threshold (89.96) never rounds up to it (90.0).
  value === null ? "—" : `${value.toFixed(2)}%`;

const eventLine = (event: Breadth90StoredEvent): string =>
  [
    `up ${pct(event.upPct)}`,
    `adv ${pct(event.advPct)}`,
    event.trigger === null ? null : `trigger ${event.trigger}`,
    event.grade === null ? null : event.grade,
    event.strict ? "strict" : null,
    event.armedOn === null ? null : `armed ${event.armedOn}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      data: Breadth90GetOutput;
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
}: Readonly<{ children: ReactNode; state: Breadth90State | null }>) => (
  <section
    aria-labelledby="breadth90-title"
    className={cn(
      "space-y-4 rounded-lg border bg-card p-4 shadow-sm",
      CARD_BORDER[state ?? "IDLE"]
    )}
    data-breadth90-state={state ?? "none"}
  >
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-heading font-semibold text-lg" id="breadth90-title">
        Breadth-90 signal
      </h2>
      <span className="rounded-full border border-destructive-border bg-destructive-subtle px-2 py-0.5 font-semibold text-destructive text-xs uppercase tracking-wide">
        High priority
      </span>
    </div>
    {children}
  </section>
);

const BasketSection = ({
  basket,
}: Readonly<{ basket: Breadth90Status["basket"] }>) => (
  <section aria-labelledby="breadth90-basket" className="space-y-2">
    <h3 className="font-medium text-sm" id="breadth90-basket">
      Dip basket
    </h3>
    {basket === null ||
    (basket.summary === null && basket.tiers.length === 0) ? (
      <p className="text-muted-foreground text-sm">No dip basket published.</p>
    ) : (
      <div className="space-y-1 text-sm" data-breadth90-basket="">
        {basket.summary === null ? null : <p>{basket.summary}</p>}
        {basket.tiers.length === 0 ? null : (
          <ul className="space-y-0.5">
            {basket.tiers.map((tier) => (
              <li key={tier.id}>
                <span className="font-medium">{tier.label}</span>
                {tier.weightPctNlv === null
                  ? ""
                  : ` · ${tier.weightPctNlv}% NLV`}
                {tier.tickers.length === 0
                  ? ""
                  : ` · ${tier.tickers.join(" ")}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    )}
    {basket?.rulesNote ? (
      <p className="text-muted-foreground text-xs">{basket.rulesNote}</p>
    ) : null}
    {basket?.reportPath ? (
      <p className="text-muted-foreground text-xs">
        Report: <code className="break-all">{basket.reportPath}</code>
      </p>
    ) : null}
  </section>
);

const RefreshError = ({
  message,
}: Readonly<{ message?: string | undefined }>) =>
  message === undefined ? null : (
    <p
      className="text-destructive text-sm"
      data-breadth90-refresh-error=""
      role="alert"
    >
      Refresh failed; showing the last loaded data. {message}
    </p>
  );

const Breadth90Signal = ({
  data,
  refreshError,
}: Readonly<{
  data: Breadth90GetOutput;
  refreshError?: string | undefined;
}>) => {
  const { days, events, status, thresholds } = data;
  if (status === null && days.length === 0)
    return (
      <Shell state={null}>
        <RefreshError message={refreshError} />
        <p className="text-muted-foreground text-sm" data-breadth90-empty="">
          No breadth-90 data yet. The rig tick (vertex-breadth-90.timer) pushes
          NYSE sessions to Vertex after each run.
        </p>
      </Shell>
    );

  const signal = status?.state ?? "IDLE";
  const latest = days.at(-1);
  const basket = status?.basket ?? null;
  return (
    <Shell state={signal}>
      <RefreshError message={refreshError} />
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-3 py-1 font-bold text-sm tracking-wide",
            STATE_STYLE[signal]
          )}
          data-state-badge={signal}
        >
          <span className="sr-only">Signal state: </span>
          {signal}
        </span>
        {status?.strict === true ? (
          <span
            className="rounded-full border border-border px-2 py-0.5 font-medium text-xs"
            data-strict=""
          >
            Strict (90% down day in window)
          </span>
        ) : null}
        {status?.armedOn ? (
          <span className="text-sm tabular-nums" data-armed="">
            Armed on {status.armedOn}
            {status.sessionsLeft === null
              ? ""
              : ` · ${status.sessionsLeft} sessions left`}
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-sm">{STATE_MEANING[signal]}</p>
      {latest === undefined ? null : (
        <dl
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          data-breadth90-latest=""
        >
          <div>
            <dt className="text-muted-foreground text-xs">Session</dt>
            <dd className="font-medium tabular-nums">{latest.date}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Up volume</dt>
            <dd className="font-semibold text-2xl tabular-nums">
              {pct(latest.upPct)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Advancers</dt>
            <dd className="font-semibold text-2xl tabular-nums">
              {pct(latest.advPct)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Value</dt>
            <dd className="font-medium" data-session-kind="">
              {latest.final ? "Close" : "Intraday (unfinished session)"}
            </dd>
          </div>
        </dl>
      )}
      {days.length === 0 ? null : (
        <Breadth90Chart days={days} thresholds={thresholds} />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="breadth90-events" className="space-y-2">
          <h3 className="font-medium text-sm" id="breadth90-events">
            Recent events
          </h3>
          {events.length === 0 ? (
            <p className="text-muted-foreground text-sm">No events yet.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-breadth90-events="">
              {events.map((event) => (
                <li key={`${event.kind}|${event.date}|${event.tier}`}>
                  <span className="font-medium tabular-nums">{event.date}</span>{" "}
                  <span className="font-semibold">{event.kind}</span>{" "}
                  <span className="text-muted-foreground">
                    {eventLine(event)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <BasketSection basket={basket} />
      </div>
      <p className="text-muted-foreground text-xs" data-breadth90-source="">
        {latest === undefined
          ? "No sessions yet."
          : `Source ${latest.source}, as of ${latest.sourceAsOf}.`}
        {status === null ? "" : ` Signal computed ${status.asOf}.`} NYSE
        USI:UVOL/DVOL and ADV/DECL. Research only; no orders.
      </p>
    </Shell>
  );
};

export const Breadth90Card = ({
  gateway: supplied,
}: Readonly<{ gateway?: Breadth90Gateway }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserBreadth90Gateway());
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    try {
      const data = await gateway.get();
      return setState({ data, type: "ready" });
    } catch (error) {
      return setState((previous) => {
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
    const timer = window.setInterval(() => void load(), BREADTH90_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (state.type === "loading")
    return (
      <Shell state={null}>
        <p
          aria-busy="true"
          className="text-muted-foreground text-sm"
          role="status"
        >
          Loading breadth-90 signal…
        </p>
      </Shell>
    );
  if (state.type === "forbidden")
    return (
      <Shell state={null}>
        <p className="text-muted-foreground text-sm" role="status">
          Operator access required.
        </p>
      </Shell>
    );
  if (state.type === "error")
    return (
      <Shell state={null}>
        <p className="text-sm" role="alert">
          Breadth-90 signal unavailable. {state.message}
        </p>
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </Shell>
    );

  return (
    <Breadth90Signal data={state.data} refreshError={state.refreshError} />
  );
};
