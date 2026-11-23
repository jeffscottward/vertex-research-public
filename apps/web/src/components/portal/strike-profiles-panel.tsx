"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { centerMarkedRow } from "./center-marked-row.ts";
import {
  buildStrikeProfile,
  STRIKE_PROFILE_LABELS,
  STRIKE_PROFILE_METRICS,
  type StrikeProfileBarRow,
  type StrikeProfileMetric,
  type StrikeProfileSnapshot,
} from "./strike-profiles-model.ts";

// "Strike profiles" section of the options analytics panel: open interest, flow volume, net
// premium and max pain by strike on one ladder (highest strike at the top) with a spot line.
// Research only; nothing here places or changes orders.

const headCell = "py-1 pr-3 text-right font-normal text-muted-foreground";
const numCell = "py-1 pr-3 text-right font-mono";

const SplitBar = ({
  row,
  metric,
}: {
  readonly row: StrikeProfileBarRow;
  readonly metric: StrikeProfileMetric;
}) => (
  <div aria-hidden="true" className="flex h-3">
    <div className="flex w-1/2 justify-end border-border border-r">
      <div
        className="h-full rounded-l-sm bg-destructive/70"
        data-bar={metric === "netPremium" ? "bearish" : "puts"}
        style={{ width: `${row.left * 100}%` }}
      />
    </div>
    <div className="flex w-1/2">
      <div
        className="h-full rounded-r-sm bg-success/70"
        data-bar={metric === "netPremium" ? "bullish" : "calls"}
        style={{ width: `${row.right * 100}%` }}
      />
    </div>
  </div>
);

export interface StrikeProfilesPanelProps {
  readonly snapshot: StrikeProfileSnapshot;
}

export const StrikeProfilesPanel = ({ snapshot }: StrikeProfilesPanelProps) => {
  const id = useId();
  const group = useId();
  const [metric, setMetric] = useState<StrikeProfileMetric>("openInterest");
  const scroller = useRef<HTMLDivElement>(null);
  const view = buildStrikeProfile(metric, snapshot);
  // Centre the spot line when the data or the profile changes.
  useEffect(() => {
    centerMarkedRow(scroller.current, "[data-spot-line]");
  }, [snapshot, metric]);
  const spotRow =
    view.kind === "ladder" && view.spotLabel !== null ? (
      <TableRow className="border-0 hover:bg-transparent" data-spot-line="">
        <TableCell className="p-0" colSpan={view.layout === "split" ? 4 : 3}>
          {/* Label first, so a narrow screen shows it without scrolling the table. */}
          <div className="flex items-center gap-2 py-1">
            <span className="font-mono text-primary text-xs">
              {view.spotLabel}
            </span>
            <div className="h-0 flex-1 border-primary border-t-2 border-dashed" />
          </div>
        </TableCell>
      </TableRow>
    ) : null;
  return (
    <section
      aria-labelledby={id}
      className="space-y-2 rounded-md border border-border p-4"
      data-strike-profiles={metric}
    >
      <h3 className="font-medium text-sm" id={id}>
        Strike profiles
      </h3>
      <fieldset className="space-y-1">
        <legend className="text-muted-foreground text-xs">Profile</legend>
        <div className="inline-flex flex-wrap gap-1 rounded-md border border-border p-0.5">
          {STRIKE_PROFILE_METRICS.map((option) => (
            <label
              className="inline-flex min-h-11 min-w-11 cursor-pointer items-center rounded px-3 text-sm has-[:checked]:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              key={option}
            >
              <input
                checked={metric === option}
                className="sr-only"
                name={group}
                onChange={() => setMetric(option)}
                type="radio"
                value={option}
              />
              {STRIKE_PROFILE_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-0.5">
        {view.captions.map((caption) => (
          <p className="text-muted-foreground text-xs" key={caption}>
            {caption}
          </p>
        ))}
      </div>
      {view.kind === "message" ? (
        <p className="text-muted-foreground text-xs" role="status">
          {view.message}
        </p>
      ) : (
        <div className="max-h-96 overflow-auto" ref={scroller}>
          <Table
            className="w-full whitespace-nowrap text-xs"
            containerClassName="overflow-visible"
          >
            <TableHeader className="sticky top-0 bg-background">
              <TableRow className="border-border border-b">
                <TableHead className={headCell} scope="col">
                  {view.columns[0]}
                </TableHead>
                <TableHead className={headCell} scope="col">
                  {view.columns[1]}
                </TableHead>
                <TableHead className={headCell} scope="col">
                  <span className="sr-only">Bar</span>
                </TableHead>
                {view.layout === "split" ? (
                  <TableHead
                    className="py-1 pl-3 text-left font-normal text-muted-foreground"
                    scope="col"
                  >
                    {view.columns[2]}
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.spotAfter === -1 ? spotRow : null}
              {view.rows.map((row, index) => (
                <ProfileRow
                  after={index === view.spotAfter ? spotRow : null}
                  key={row.strike}
                  layout={view.layout}
                  metric={metric}
                  row={row}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};

const ProfileRow = ({
  row,
  layout,
  metric,
  after,
}: {
  readonly row: StrikeProfileBarRow;
  readonly layout: "split" | "single";
  readonly metric: StrikeProfileMetric;
  readonly after: ReactNode;
}) => (
  <>
    <TableRow
      className={`border-border border-b ${row.maxPain ? "bg-muted" : ""}`}
      data-max-pain-row={row.maxPain ? "" : undefined}
      title={row.title}
    >
      <TableCell className={numCell}>
        {row.strike}
        {row.maxPain ? (
          <span className="ml-2 font-sans text-primary">max pain</span>
        ) : null}
      </TableCell>
      <TableCell className={numCell}>{row.leftText}</TableCell>
      <TableCell className="w-1/2 min-w-24 py-1">
        {row.barText === null ? null : (
          <span className="sr-only">{row.barText}</span>
        )}
        {layout === "split" ? (
          <SplitBar metric={metric} row={row} />
        ) : (
          <div aria-hidden="true" className="flex h-3">
            <div
              className={`h-full rounded-sm ${row.maxPain ? "bg-primary/80" : "bg-muted-foreground/40"}`}
              data-bar="payout"
              style={{ width: `${row.right * 100}%` }}
            />
          </div>
        )}
      </TableCell>
      {layout === "split" ? (
        <TableCell className="py-1 pl-3 text-left font-mono">
          {row.rightText}
        </TableCell>
      ) : null}
    </TableRow>
    {after}
  </>
);
