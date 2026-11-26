// What: 6-ticker live Option Tape panel for /flow (SPY, SPX, QQQ, NDX, IWM, NVDA) backed by
// flow.optionPrints (flow-option-prints.v1). Shows source, delay, freshness, unread gap count,
// full-window summary totals and newest prints. Research only; never a trade signal.
"use client";

import {
  type ApiClient,
  createApiClient,
  type FlowOptionPrints,
  type FlowOptionTicker,
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
import { useCallback, useEffect, useRef, useState } from "react";

import {
  OPTION_TAPE_HEADERS,
  OPTION_TAPE_TICKERS,
  OPTION_TAPE_WINDOWS,
  type OptionTapeWindowMinutes,
  optionTapeFreshness,
  optionTapeMetrics,
  optionTapeRows,
  optionTapeUnreadLine,
  optionTapeWindowLabel,
} from "../../features/flow/option-tape-view-model.ts";

export type FlowOptionTapePanelProps = Readonly<{
  client?: Pick<ApiClient["flow"], "optionPrints">;
  initialTicker?: FlowOptionTicker;
}>;

export function FlowOptionTapePanel({
  client,
  initialTicker = "SPY",
}: FlowOptionTapePanelProps) {
  const apiRef = useRef(client);
  apiRef.current = client;
  const seqRef = useRef(0);
  const [ticker, setTicker] = useState<FlowOptionTicker>(initialTicker);
  const [windowMinutes, setWindowMinutes] =
    useState<OptionTapeWindowMinutes>(60);
  const [data, setData] = useState<FlowOptionPrints | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (
      nextTicker: FlowOptionTicker,
      nextWindow: OptionTapeWindowMinutes
    ) => {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setLoading(true);
      setError(null);
      try {
        const api =
          apiRef.current ??
          createApiClient({ baseUrl: window.location.origin }).flow;
        const result = await api.optionPrints({
          limit: 50,
          ticker: nextTicker,
          windowMinutes: nextWindow,
        });
        if (seq !== seqRef.current) return;
        setData(result);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "Could not load live option prints."
        );
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(ticker, windowMinutes);
    return () => {
      seqRef.current += 1;
    };
  }, [load, ticker, windowMinutes]);

  const selectTicker = (nextTicker: FlowOptionTicker) => {
    if (nextTicker === ticker) return;
    setData(null);
    setError(null);
    setTicker(nextTicker);
  };

  const selectWindow = (nextWindow: OptionTapeWindowMinutes) => {
    if (nextWindow === windowMinutes) return;
    setData(null);
    setError(null);
    setWindowMinutes(nextWindow);
  };

  const freshness = data ? optionTapeFreshness(data.freshness) : null;
  const metrics = data ? optionTapeMetrics(data) : [];
  const rows = data ? optionTapeRows(data) : [];
  return (
    <Panel
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {freshness ? (
            <StatusBadge status={freshness.tone}>{freshness.label}</StatusBadge>
          ) : null}
          <Button
            aria-label="Refresh option tape"
            className="min-h-11 min-w-11"
            onClick={() => void load(ticker, windowMinutes)}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            <span>Refresh</span>
          </Button>
        </div>
      }
      description={
        data
          ? `${data.source} · ${data.delay} · ${optionTapeUnreadLine(data.unreadRanges)}`
          : "QuantData order-flow/consolidated · Live intraday option prints for SPY, SPX, QQQ, NDX, IWM and NVDA."
      }
      title="Live option prints"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            aria-label="Option print ticker"
            className="flex flex-wrap gap-1.5"
            role="group"
          >
            {OPTION_TAPE_TICKERS.map((item) => (
              <Button
                aria-pressed={item === ticker}
                className="min-h-11 min-w-11"
                key={item}
                onClick={() => selectTicker(item)}
                size="sm"
                type="button"
                variant={item === ticker ? "default" : "outline"}
              >
                {item}
              </Button>
            ))}
          </div>
          <div
            aria-label="Option print window"
            className="flex flex-wrap gap-1.5"
            role="group"
          >
            {OPTION_TAPE_WINDOWS.map((minutes) => (
              <Button
                aria-pressed={minutes === windowMinutes}
                className="min-h-11 min-w-11"
                key={minutes}
                onClick={() => selectWindow(minutes)}
                size="sm"
                type="button"
                variant={minutes === windowMinutes ? "default" : "outline"}
              >
                {optionTapeWindowLabel(minutes)}
              </Button>
            ))}
          </div>
        </div>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        {loading && data === null ? (
          <p className="text-muted-foreground text-sm">
            Loading live option prints for {ticker}.
          </p>
        ) : null}

        {data === null ? null : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {metrics.map((metric) => (
                <div
                  className="rounded-md border border-border bg-card/50 p-3"
                  key={metric.label}
                >
                  <dt className="text-muted-foreground text-xs">
                    {metric.label}
                  </dt>
                  <dd className="mt-1 font-mono font-semibold text-foreground text-sm">
                    {metric.value}
                  </dd>
                </div>
              ))}
            </dl>

            {rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No stored option prints for {data.ticker} in this window.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableCaption>
                    Newest {rows.length} of {data.summary.trades} stored{" "}
                    {data.ticker} prints ({data.source}). Research input only;
                    never a trade signal.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      {OPTION_TAPE_HEADERS.map((header) => (
                        <TableHead key={header}>{header}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {row.time}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {row.contract}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {row.side}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {row.sentiment}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {row.size}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {row.price}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {row.premium}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {row.kind}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
