"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";

import {
  IV_SKEW_TARGET_DELTAS,
  OPTIONS_FLOW_HOURS,
  type ExposureSection,
  type FlowSection,
  type GexContext,
  type OptionsAnalyticsOutput,
  type VolatilitySection,
} from "@darkfactory/api";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { GexContextStrip } from "./gex-context-strip.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";
import {
  createBrowserOptionsAnalyticsGateway,
  type OptionsAnalyticsGateway,
} from "./options-analytics-client.ts";

// Per-symbol options research panel on /charts and the stock page: IV term structure, skew
// and surface, estimated GEX with OI walls and its context strip, and recent option flow
// (QuantData). Read-only.

const DASH = "—";
const headCell = "py-1 pr-3 font-normal";
// TableHead sets text-foreground on the cell, so column headers restate the muted colour.
const columnHeadCell = `${headCell} text-muted-foreground`;
const numCell = "py-1 pr-3 text-right font-mono";
const MAX_SKEW_EXPIRIES = 6;
const MAX_FLOW_ROWS = 25;

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: OptionsAnalyticsOutput }>
  | Readonly<{ type: "error"; code: string; message: string }>;

const pct = (value: number | null | undefined): string =>
  value === null || value === undefined ? DASH : `${(value * 100).toFixed(1)}%`;

const money = (value: number | null): string => {
  if (value === null) return DASH;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

// Skew points carry the provider's rounded delta; show each under its nearest target column.
const SectionShell = ({
  id,
  title,
  status,
  message,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly message: string | null;
  readonly children?: ReactNode;
}) => (
  <section
    aria-labelledby={id}
    className="space-y-2 rounded-md border border-border p-4"
    data-section-status={status}
  >
    <h3 className="font-medium text-sm" id={id}>
      {title}
    </h3>
    {message === null ? null : (
      <p className="text-muted-foreground text-xs" role="status">
        {message}
      </p>
    )}
    {status === "ok" ? children : null}
  </section>
);

const Volatility = ({ section }: { readonly section: VolatilitySection }) => {
  const id = useId();
  const expiries = [
    ...new Set(section.skew.map((point) => point.expiry)),
  ].slice(0, MAX_SKEW_EXPIRIES);
  const maxIv = Math.max(
    ...section.termStructure.map((point) => point.atmIv),
    0.0001
  );
  const surfaceMax = Math.max(
    ...section.surface.rows.flatMap((row) =>
      row.ivs.filter((iv): iv is number => iv !== null)
    ),
    0.0001
  );
  return (
    <SectionShell
      id={id}
      message={section.message}
      status={section.status}
      title="Implied volatility"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <h4 className="text-muted-foreground text-xs">
            ATM IV term structure
          </h4>
          <div className="overflow-x-auto">
            <Table
              className="w-full whitespace-nowrap text-xs"
              data-term-structure
            >
              <TableHeader>
                <TableRow className="border-border border-b text-left text-muted-foreground">
                  <TableHead className={columnHeadCell} scope="col">
                    Expiry
                  </TableHead>
                  <TableHead
                    className={`${headCell} text-right text-muted-foreground`}
                    scope="col"
                  >
                    DTE
                  </TableHead>
                  <TableHead
                    className={`${headCell} text-right text-muted-foreground`}
                    scope="col"
                  >
                    ATM IV
                  </TableHead>
                  <TableHead className={columnHeadCell} scope="col">
                    <span className="sr-only">Level</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {section.termStructure.map((point) => (
                  <TableRow
                    className="border-border border-b"
                    key={point.expiry}
                  >
                    <TableCell className="py-1 pr-3 font-mono">
                      {point.expiry}
                    </TableCell>
                    <TableCell className={numCell}>{point.dte}</TableCell>
                    <TableCell className={numCell}>
                      {pct(point.atmIv)}
                    </TableCell>
                    <TableCell className="w-1/3 py-1">
                      <div
                        aria-hidden="true"
                        className="h-2 rounded-sm bg-primary/60"
                        style={{ width: `${(point.atmIv / maxIv) * 100}%` }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <h4 className="text-muted-foreground text-xs">
            Skew (IV by delta; puts negative)
          </h4>
          <div className="overflow-x-auto">
            <Table className="w-full whitespace-nowrap text-xs" data-skew>
              <TableHeader>
                <TableRow className="border-border border-b text-left text-muted-foreground">
                  <TableHead className={columnHeadCell} scope="col">
                    Expiry
                  </TableHead>
                  {IV_SKEW_TARGET_DELTAS.map((delta) => (
                    <TableHead
                      className={`${headCell} text-right text-muted-foreground`}
                      key={delta}
                      scope="col"
                    >
                      {delta > 0 ? `+${delta}` : delta}Δ
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {expiries.map((expiry) => (
                  <TableRow className="border-border border-b" key={expiry}>
                    <TableCell className="py-1 pr-3 font-mono">
                      {expiry}
                    </TableCell>
                    {IV_SKEW_TARGET_DELTAS.map((target) => {
                      const point = section.skew.find(
                        (row) => row.expiry === expiry && row.target === target
                      );
                      // The chosen contract may sit up to 18 delta points from the column.
                      return (
                        <TableCell
                          className={numCell}
                          key={target}
                          title={
                            point === undefined
                              ? undefined
                              : `Contract delta ${point.delta}`
                          }
                        >
                          {pct(point?.iv)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
      <div className="space-y-1">
        <h4 className="text-muted-foreground text-xs">
          IV surface (out-of-the-money IV by strike / spot)
        </h4>
        <div className="overflow-x-auto">
          <Table className="w-full whitespace-nowrap text-xs" data-iv-surface>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground">
                <TableHead className={columnHeadCell} scope="col">
                  Expiry (DTE)
                </TableHead>
                {section.surface.moneyness.map((m) => (
                  <TableHead
                    className={`${headCell} text-right text-muted-foreground`}
                    key={m}
                    scope="col"
                  >
                    {(m * 100).toFixed(0)}%
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.surface.rows.map((row) => (
                <TableRow className="border-border border-b" key={row.expiry}>
                  <TableCell className="py-1 pr-3 font-mono">
                    {row.expiry} ({row.dte})
                  </TableCell>
                  {row.ivs.map((iv, index) => (
                    <TableCell
                      className={numCell}
                      key={index}
                      style={
                        iv === null
                          ? undefined
                          : {
                              backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round((iv / surfaceMax) * 45)}%, transparent)`,
                            }
                      }
                    >
                      {pct(iv)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </SectionShell>
  );
};

const Exposure = ({
  section,
  spot,
  context,
}: {
  readonly section: ExposureSection;
  readonly spot: number | null;
  readonly context: GexContext;
}) => {
  const id = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const maxAbs = Math.max(
    ...section.strikes.map((row) => Math.abs(row.gex ?? 0)),
    1
  );
  const nearest =
    spot === null
      ? null
      : section.strikes.reduce<number | null>(
          (best, row) =>
            best === null || Math.abs(row.strike - spot) < Math.abs(best - spot)
              ? row.strike
              : best,
          null
        );
  // Center the strike nearest spot inside the scroll box without moving the page.
  useEffect(() => {
    const box = scroller.current;
    const row = box?.querySelector<HTMLElement>("[data-spot-row]");
    if (box && row)
      box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
  }, [section]);
  return (
    <SectionShell
      id={id}
      message={section.message}
      status={section.status}
      title="Gamma exposure and open interest"
    >
      <GexContextStrip context={context} />
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">
            Estimated net GEX (per 1% move)
          </dt>
          <dd className="font-mono" data-total-gex>
            {money(section.totalGex)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Max pain (aggregate OI)</dt>
          <dd className="font-mono">{section.maxPain ?? DASH}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Gamma IV expiry</dt>
          <dd className="font-mono">{section.gexExpiry ?? DASH}</dd>
        </div>
        {(
          [
            ["Gamma flip (est.)", context.levels.flip],
            ["Call wall (largest +GEX)", context.levels.callWall],
            ["Put wall (largest -GEX)", context.levels.putWall],
          ] as const
        ).map(([label, level]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono" data-gex-level={label}>
              {level === null ? DASH : level.toFixed(2)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="max-h-96 overflow-auto" ref={scroller}>
        <Table
          className="w-full whitespace-nowrap text-xs"
          containerClassName="overflow-visible"
          data-gex-table
        >
          <TableHeader className="sticky top-0 bg-background">
            <TableRow className="border-border border-b text-left text-muted-foreground">
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Strike
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Call OI
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Put OI
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Est. GEX
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                <span className="sr-only">GEX bar</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.strikes.map((row) => (
              <TableRow
                className={`border-border border-b ${row.strike === nearest ? "bg-muted" : ""}`}
                data-spot-row={row.strike === nearest ? "" : undefined}
                key={row.strike}
              >
                <TableCell className={numCell}>{row.strike}</TableCell>
                <TableCell className={numCell}>
                  {row.callOpenInterest.toLocaleString("en-US")}
                </TableCell>
                <TableCell className={numCell}>
                  {row.putOpenInterest.toLocaleString("en-US")}
                </TableCell>
                <TableCell className={numCell}>{money(row.gex)}</TableCell>
                <TableCell className="w-1/4 min-w-20 py-1">
                  <div
                    aria-hidden="true"
                    className={`h-2 rounded-sm ${(row.gex ?? 0) < 0 ? "bg-destructive/70" : "bg-primary/70"}`}
                    style={{
                      width: `${(Math.abs(row.gex ?? 0) / maxAbs) * 100}%`,
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionShell>
  );
};

const Flow = ({ section }: { readonly section: FlowSection }) => {
  const id = useId();
  return (
    <SectionShell
      id={id}
      message={section.message}
      status={section.status}
      title={`Option flow (last ${section.hours} h)`}
    >
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Call premium</dt>
          <dd className="font-mono">{money(section.callPremium)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Put premium</dt>
          <dd className="font-mono">{money(section.putPremium)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Net (call − put)</dt>
          <dd className="font-mono" data-net-premium>
            {money(section.callPremium - section.putPremium)}
          </dd>
        </div>
      </dl>
      <div className="max-h-96 overflow-auto">
        <Table
          className="w-full whitespace-nowrap text-xs"
          containerClassName="overflow-visible"
          data-flow-table
        >
          <TableHeader className="sticky top-0 bg-background">
            <TableRow className="border-border border-b text-left text-muted-foreground">
              <TableHead className={columnHeadCell} scope="col">
                Time (UTC)
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Contract
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Premium
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Size
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Type
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Sentiment
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.events.slice(0, MAX_FLOW_ROWS).map((event, index) => (
              <TableRow className="border-border border-b" key={index}>
                <TableCell className="py-1 pr-3 font-mono">
                  {event.time.slice(5, 16).replace("T", " ")}
                </TableCell>
                <TableCell className="py-1 pr-3 font-mono">
                  {event.contract}
                  {event.unusual ? " · unusual" : ""}
                </TableCell>
                <TableCell className={numCell}>
                  {money(event.premium)}
                </TableCell>
                <TableCell className={numCell}>{event.size}</TableCell>
                <TableCell className="py-1 pr-3">
                  {event.flowType ?? DASH}
                </TableCell>
                <TableCell className="py-1 pr-3">{event.sentiment}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionShell>
  );
};

export interface OptionsAnalyticsPanelProps {
  readonly symbol: string;
  readonly gateway?: OptionsAnalyticsGateway | undefined;
}

export const OptionsAnalyticsPanel = ({
  symbol,
  gateway: supplied,
}: OptionsAnalyticsPanelProps) => {
  const headingId = useId();
  const selectId = useId();
  const [gateway] = useState(
    () => supplied ?? createBrowserOptionsAnalyticsGateway()
  );
  const [hours, setHours] = useState<number>(24);
  const [state, setState] = useState<State>({ type: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ type: "loading" });
    try {
      const data = await gateway.snapshot({ flowHours: hours, symbol });
      if (mine === generation.current) setState({ data, type: "ready" });
    } catch (error) {
      if (mine === generation.current)
        setState({ type: "error", ...describeMarketDataFailure(error) });
    }
  }, [gateway, hours, symbol]);

  useEffect(() => {
    void load();
    // A late answer after unmount or a symbol/window change must not set state.
    return () => {
      generation.current += 1;
    };
  }, [load]);

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4"
      data-options-analytics={symbol}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-medium text-base" id={headingId}>
            Options analytics · {symbol}
          </h2>
          <p className="text-muted-foreground text-xs">
            QuantData · research only
            {state.type === "ready"
              ? ` · spot ${state.data.spot ?? DASH} · received ${state.data.receivedAt.slice(11, 19)} UTC`
              : ""}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1 text-xs">
            <label className="block text-muted-foreground" htmlFor={selectId}>
              Flow window
            </label>
            <select
              className="h-11 rounded-md border border-border bg-background px-2 text-sm"
              id={selectId}
              onChange={(event) => setHours(Number(event.target.value))}
              value={hours}
            >
              {OPTIONS_FLOW_HOURS.map((option) => (
                <option key={option} value={option}>
                  {option} h
                </option>
              ))}
            </select>
          </div>
          <button
            className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-60"
            disabled={state.type === "loading"}
            onClick={() => void load()}
            type="button"
          >
            Refresh
          </button>
        </div>
      </div>
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading options analytics…
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
        <>
          {state.data.rateLimited ? (
            <p className="text-xs" role="status">
              QuantData rate limit reached; retry in about{" "}
              {state.data.retryAfterSeconds ?? 60} s.
            </p>
          ) : null}
          <Volatility section={state.data.volatility} />
          <Exposure
            context={state.data.context}
            section={state.data.exposure}
            spot={state.data.spot}
          />
          <Flow section={state.data.flow} />
          <details className="text-muted-foreground text-xs">
            <summary className="min-h-11 cursor-pointer py-3">
              Data limits
            </summary>
            <ul className="list-disc space-y-1 pl-5">
              {state.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
};
