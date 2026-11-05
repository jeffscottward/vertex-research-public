"use client";

import type { JevStance, JevVerdict, JevVerdictOutput } from "@darkfactory/api";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  createBrowserJevVerdictGateway,
  type JevVerdictGateway,
} from "./jev-verdict-client.ts";
import { describeMarketDataFailure } from "./market-data-client.ts";

// Display-only JEV verdict on /charts (merge plan P5). Loading the panel reads the cached
// verdict and never calls JEV; "Ask JEV" makes one call within the server throttle.
// JEV sees only public daily price fields; the verdict never places or changes orders.

// Timers longer than this overflow setTimeout; the panel then waits for a reload.
const MAX_TIMER_MS = 2_147_483_647;

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: JevVerdictOutput }>
  | Readonly<{ type: "error"; code: string; message: string }>;

type RefreshNotice = Readonly<{ code: string; message: string }> | null;

const STANCE_TEXT: Readonly<Record<JevStance, string>> = {
  BEARISH: "Bearish",
  BULLISH: "Bullish",
  NEUTRAL: "Neutral",
};

const utc = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const VerdictView = ({
  stale,
  verdict,
}: Readonly<{ stale: boolean; verdict: JevVerdict }>) => (
  <div className="space-y-3" data-stance={verdict.stance}>
    <div className="flex flex-wrap items-baseline gap-3">
      <p className="font-medium text-2xl">{STANCE_TEXT[verdict.stance]}</p>
      {stale ? (
        <p
          className="rounded-md border border-border px-2 py-0.5 text-xs"
          data-jev-stale=""
        >
          Stale
        </p>
      ) : null}
    </div>
    <dl className="grid grid-cols-3 gap-2 text-sm sm:max-w-sm">
      {(["BULLISH", "NEUTRAL", "BEARISH"] as const).map((stance) => (
        <div key={stance}>
          <dt className="text-muted-foreground text-xs">
            {STANCE_TEXT[stance]}
          </dt>
          <dd className="font-mono">
            {percent(verdict.probabilities[stance])}
          </dd>
        </div>
      ))}
    </dl>
    {verdict.factors.length > 0 ? (
      <ul className="space-y-1 text-sm">
        {verdict.factors.map((factor) => (
          <li className="flex gap-2" key={factor.key}>
            <span className="text-muted-foreground">{factor.label}</span>
            <span className="font-mono">{percent(factor.probability)}</span>
          </li>
        ))}
      </ul>
    ) : null}
    <p className="text-muted-foreground text-xs">{verdict.reason}</p>
    <p className="text-muted-foreground text-xs" data-jev-decided-at="">
      Decided {utc(verdict.decidedAt)}
      {verdict.model === null ? "" : ` · model ${verdict.model}`}
      {verdict.dataAsOf === null ? "" : ` · prices to ${verdict.dataAsOf}`}
    </p>
    <details className="text-muted-foreground text-xs">
      <summary className="min-h-11 cursor-pointer py-3">
        Fields sent to JEV
      </summary>
      <p className="font-mono">{verdict.sentFields.join(", ")}</p>
    </details>
  </div>
);

const ReadyBody = ({ data }: Readonly<{ data: JevVerdictOutput }>) => (
  <>
    {data.configured ? null : (
      <p className="text-sm" data-jev-unconfigured="">
        JEV is not configured on this server. The panel cannot ask for a
        verdict.
      </p>
    )}
    {data.lastFailure === null ? null : (
      <p
        className="text-sm"
        data-failure-code={data.lastFailure.code}
        role="status"
      >
        Last request failed at {utc(data.lastFailure.at)}:{" "}
        {data.lastFailure.message}.
      </p>
    )}
    {data.verdict === null ? (
      data.configured ? (
        <p className="text-muted-foreground text-sm" data-jev-empty="">
          No verdict yet. Ask JEV makes one call; the limit is one call per
          symbol every {Math.round(data.minIntervalSeconds / 60)} min.
        </p>
      ) : null
    ) : (
      <VerdictView stale={data.state === "stale"} verdict={data.verdict} />
    )}
    <details className="text-muted-foreground text-xs">
      <summary className="min-h-11 cursor-pointer py-3">Data limits</summary>
      <ul className="list-disc space-y-1 pl-5">
        {data.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
        <li>
          A verdict older than {Math.round(data.staleAfterSeconds / 60)} min is
          marked stale.
        </li>
      </ul>
    </details>
  </>
);

export interface JevVerdictPanelProps {
  readonly gateway?: JevVerdictGateway | undefined;
  readonly now?: () => number;
  readonly symbol: string;
}

export const JevVerdictPanel = ({
  symbol,
  gateway: supplied,
  now = Date.now,
}: JevVerdictPanelProps) => {
  const headingId = useId();
  const [gateway] = useState(
    () => supplied ?? createBrowserJevVerdictGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<RefreshNotice>(null);
  const [, setTick] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setState({ type: "loading" });
    setNotice(null);
    setBusy(false);
    gateway.get({ symbol }).then(
      (data) => {
        if (mine === generation.current) setState({ data, type: "ready" });
      },
      (error: unknown) => {
        if (mine === generation.current)
          setState({ type: "error", ...describeMarketDataFailure(error) });
      }
    );
    // A late answer after unmount or a symbol change must not set state.
    return () => {
      generation.current += 1;
    };
  }, [gateway, symbol]);

  const nextRefreshAt =
    state.type === "ready" ? state.data.nextRefreshAt : null;
  const waitMs = nextRefreshAt === null ? 0 : Date.parse(nextRefreshAt) - now();

  // Re-render when the throttle window ends so the button enables itself.
  useEffect(() => {
    if (waitMs <= 0 || waitMs > MAX_TIMER_MS) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), waitMs);
    return () => clearTimeout(timer);
  }, [waitMs]);

  const refresh = useCallback(async () => {
    const mine = generation.current;
    setBusy(true);
    setNotice(null);
    try {
      const data = await gateway.refresh({ symbol });
      if (mine !== generation.current) return;
      setState({ data, type: "ready" });
      if (data.throttled && data.nextRefreshAt !== null)
        setNotice({
          code: "THROTTLED",
          message: `Refresh limit reached. Next refresh after ${utc(data.nextRefreshAt)}.`,
        });
    } catch (error) {
      if (mine === generation.current)
        setNotice(describeMarketDataFailure(error));
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  }, [gateway, symbol]);

  const configured = state.type === "ready" && state.data.configured;
  const canRefresh = configured && !busy && waitMs <= 0;

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-md border border-border p-4"
      data-jev-verdict={symbol}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-medium text-base" id={headingId}>
            JEV verdict · {symbol}
          </h2>
          <p className="text-muted-foreground text-xs">
            Display only · never places or changes orders
          </p>
        </div>
        <div className="space-y-1 text-right">
          <button
            className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-60"
            disabled={!canRefresh}
            onClick={() => void refresh()}
            type="button"
          >
            {busy ? "Asking JEV…" : "Ask JEV"}
          </button>
          {configured && nextRefreshAt !== null && waitMs > 0 ? (
            <p className="text-muted-foreground text-xs" data-jev-next="">
              Next refresh after {utc(nextRefreshAt)}
            </p>
          ) : null}
        </div>
      </div>
      {notice === null ? null : (
        <p className="text-sm" data-notice-code={notice.code} role="status">
          {notice.message}
        </p>
      )}
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading JEV verdict…
        </p>
      ) : state.type === "error" ? (
        <div
          className="space-y-1 rounded-md border border-border p-4"
          data-error-code={state.code}
          role="alert"
        >
          <p className="font-mono text-sm">{state.code}</p>
          <p className="text-sm">{state.message}</p>
        </div>
      ) : (
        <ReadyBody data={state.data} />
      )}
    </section>
  );
};
