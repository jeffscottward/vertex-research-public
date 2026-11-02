"use client";

import type {
  CongressTradesFeedOutput,
  CongressTradeWindow,
} from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CongressTradesGateway,
  createBrowserCongressTradesGateway,
} from "./congress-trades-client.ts";
import { describeResearchLensFailure } from "./research-lenses-client.ts";

// Congress trades: the House Clerk STOCK Act periodic transaction report (PTR) filing feed.
// The transaction rows live in each filing's PDF; the page links them. Research only; no orders.

const WINDOWS: readonly CongressTradeWindow[] = [7, 30, 90];
const ALL_MEMBERS = "";
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-56";

type FeedState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; feed: CongressTradesFeedOutput }>;

export interface CongressTradesWorkspaceProps {
  readonly gateway?: CongressTradesGateway;
}

export const CongressTradesWorkspace = ({
  gateway: suppliedGateway,
}: CongressTradesWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserCongressTradesGateway()
  );
  const [days, setDays] = useState<CongressTradeWindow>(30);
  const [member, setMember] = useState(ALL_MEMBERS);
  const [state, setState] = useState<FeedState>({ type: "loading" });
  const latest = useRef(0);

  const load = useCallback(
    async (span: CongressTradeWindow) => {
      latest.current += 1;
      const request = latest.current;
      setState({ type: "loading" });
      const next: FeedState = await gateway.feed(span).then(
        (loaded) => ({ feed: loaded, type: "ready" }),
        (error: unknown) => ({
          message: describeResearchLensFailure(error),
          type: "error",
        })
      );
      // A newer window choice wins over a slower, older response.
      if (request !== latest.current) return;
      setState(next);
      // Keep the member filter only while that member still has filings in the window.
      if (next.type === "ready")
        setMember((current) =>
          next.feed.members.includes(current) ? current : ALL_MEMBERS
        );
    },
    [gateway]
  );

  useEffect(() => {
    void load(days);
    return;
  }, [load, days]);

  const feed = state.type === "ready" ? state.feed : null;
  const filings =
    feed === null
      ? []
      : feed.filings.filter(
          (filing) => member === ALL_MEMBERS || filing.member === member
        );

  return (
    <div className="space-y-6">
      <p className="max-w-4xl text-muted-foreground text-sm">
        House members report stock and option trades in STOCK Act periodic
        transaction reports (PTRs). A report can arrive up to 45 days after the
        trade. This feed lists the filings from the House Clerk disclosure
        index; the transaction detail (asset, type, date, amount range) is in
        each linked PDF. Research only; no orders.
      </p>

      <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-end">
        <label className="space-y-1">
          <span className="block">Filed in the last</span>
          <select
            className={selectClass}
            onChange={(event) => {
              setDays(Number(event.target.value) as CongressTradeWindow);
            }}
            value={days}
          >
            {WINDOWS.map((span) => (
              <option key={span} value={span}>
                {span} days
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block">Member</span>
          <select
            className={selectClass}
            disabled={feed === null}
            onChange={(event) => setMember(event.target.value)}
            value={member}
          >
            <option value={ALL_MEMBERS}>All members</option>
            {feed?.members.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading filings…
        </p>
      ) : null}
      {state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">Filings unavailable: {state.message}</p>
          <Button
            className="min-h-11"
            onClick={() => void load(days)}
            size="sm"
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Try again
          </Button>
        </div>
      ) : null}

      {feed === null ? null : (
        <section aria-label="PTR filings" className="space-y-3">
          <p className="text-muted-foreground text-xs" role="status">
            {filings.length} {filings.length === 1 ? "filing" : "filings"} ·{" "}
            {feed.source} · read{" "}
            {feed.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC
          </p>
          {filings.length === 0 ? (
            <p className="text-sm">
              No periodic transaction reports were filed in the last {days}{" "}
              days.
            </p>
          ) : (
            <>
              {/* Below sm: one compact card per filing, so the PDF link stays on screen. */}
              <ul
                aria-label="Filings, newest first"
                className="divide-y divide-border border-border border-y sm:hidden"
              >
                {filings.map((filing) => (
                  <li
                    className="flex items-center justify-between gap-3 py-2"
                    key={filing.docId}
                  >
                    <div className="min-w-0 text-sm">
                      <p className="truncate font-medium">{filing.member}</p>
                      <p className="font-mono text-muted-foreground text-xs">
                        {filing.stateDistrict || "–"} · filed {filing.filedOn}
                      </p>
                    </div>
                    <a
                      aria-label={`PTR ${filing.docId} PDF for ${filing.member}, opens in a new tab`}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm underline-offset-2 hover:underline"
                      href={filing.pdfUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Report PDF
                      <ExternalLink aria-hidden="true" className="size-4" />
                    </a>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[560px] text-sm">
                  <caption className="sr-only">
                    Periodic transaction report filings, newest first
                  </caption>
                  <thead>
                    <tr className="border-border border-b text-left text-muted-foreground text-xs">
                      <th className="py-2 pr-3" scope="col">
                        Filed
                      </th>
                      <th className="py-2 pr-3" scope="col">
                        Member
                      </th>
                      <th className="py-2 pr-3" scope="col">
                        District
                      </th>
                      <th className="py-2 pr-3" scope="col">
                        Report
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filings.map((filing) => (
                      <tr
                        className="border-border border-b align-middle"
                        key={filing.docId}
                      >
                        <td className="pr-3 font-mono text-xs">
                          {filing.filedOn}
                        </td>
                        <th className="pr-3 text-left font-medium" scope="row">
                          {filing.member}
                        </th>
                        <td className="pr-3 font-mono text-xs">
                          {filing.stateDistrict || "–"}
                        </td>
                        <td>
                          <a
                            aria-label={`PTR ${filing.docId} PDF for ${filing.member}, opens in a new tab`}
                            className="inline-flex min-h-11 items-center gap-1 underline-offset-2 hover:underline"
                            href={filing.pdfUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            PTR {filing.docId}
                            <ExternalLink
                              aria-hidden="true"
                              className="size-4"
                            />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};
