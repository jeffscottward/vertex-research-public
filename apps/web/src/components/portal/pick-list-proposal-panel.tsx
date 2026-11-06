"use client";

import type {
  PickListOutput,
  PickListProposalOutput,
  PickListProposalRowOutput,
  PickListProposalTier,
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
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  describePickListFailure,
  type PickListGateway,
} from "./pick-lists-client.ts";

// Buy proposal from the bucketed pick lists (pickLists.proposal). Read-only: this panel has no
// order control and sends nothing but the proposal request. The optional NLV field stays in this
// browser tab; it only turns % NLV into dollars and a spread count.

type ProposalState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: PickListProposalOutput }>
  | Readonly<{ type: "error"; message: string }>;

const TIER_LABELS: Readonly<Record<PickListProposalTier, string>> = {
  full: "Full size",
  half: "Half size",
  none: "No entry",
};

const TIER_TONE: Readonly<
  Record<PickListProposalTier, StatusBadgeProps["status"]>
> = {
  full: "success",
  half: "warning",
  none: "neutral",
};

const usd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

const percent = (value: number): string => `${value.toFixed(2)}%`;

/** A positive NLV typed in the field (commas allowed), else null. */
export const parseNlv = (text: string): number | null => {
  const trimmed = text.replaceAll(",", "").trim();
  const value = Number(trimmed);
  return trimmed !== "" && Number.isFinite(value) && value > 0 ? value : null;
};

/** Whole spreads that fit the row's max-loss budget at this NLV; null without NLV or structure. */
export const spreadsFor = (
  row: PickListProposalRowOutput,
  nlv: number | null
): number | null => {
  const structure = row.structure;
  if (nlv === null || structure === null || structure.maxLossPerSpread <= 0)
    return null;
  return Math.floor(
    ((row.maxLossPctNlv / 100) * nlv) / structure.maxLossPerSpread
  );
};

/** Changes whenever a bucket is added, renamed or gets a new snapshot. */
export const bucketKey = (lists: readonly PickListOutput[]): string =>
  lists
    .flatMap((list) =>
      list.bucketSymbol === null
        ? []
        : [`${list.bucketSymbol}:${list.latest.id}`]
    )
    .sort()
    .join("|");

const StructureCell = ({
  row,
}: Readonly<{ row: PickListProposalRowOutput }>) => {
  const structure = row.structure;
  if (structure === null)
    return <TableCell className="text-muted-foreground">—</TableCell>;
  return (
    <TableCell className="min-w-44">
      <span className="block font-medium">Call debit spread</span>
      <span className="block">{`${structure.expiry} (${structure.dte} DTE)`}</span>
      <span className="block font-mono">{`Buy ${structure.longStrike}C / sell ${structure.shortStrike}C`}</span>
      <span className="block text-muted-foreground text-xs">{`Delta ${structure.longDelta.toFixed(2)} / ${structure.shortDelta.toFixed(2)}`}</span>
    </TableCell>
  );
};

const ProposalRow = ({
  row,
  nlv,
}: Readonly<{ row: PickListProposalRowOutput; nlv: number | null }>) => {
  const structure = row.structure;
  const spreads = spreadsFor(row, nlv);
  return (
    <TableRow data-tier={row.tier}>
      <TableHead className="font-medium font-mono" scope="row">
        {row.symbol}
      </TableHead>
      <TableCell className="font-mono">{row.buckets.join(", ")}</TableCell>
      <TableCell className="text-right">
        {row.last === null ? "—" : row.last.toFixed(2)}
      </TableCell>
      <TableCell>
        <StatusBadge status={TIER_TONE[row.tier]}>
          {TIER_LABELS[row.tier]}
        </StatusBadge>
      </TableCell>
      <StructureCell row={row} />
      <TableCell className="text-right">
        {structure === null ? "—" : usd.format(structure.estDebit)}
      </TableCell>
      <TableCell className="text-right">
        {structure === null ? (
          "—"
        ) : (
          <>
            <span className="block">
              {usd.format(structure.maxLossPerSpread)}
            </span>
            <span className="block text-muted-foreground text-xs">
              {`max profit ${usd.format(structure.maxProfitPerSpread)}`}
            </span>
          </>
        )}
      </TableCell>
      <TableCell className="text-right">
        {row.tier === "none" ? "—" : percent(row.maxLossPctNlv)}
      </TableCell>
      <TableCell className="text-right">
        {spreads === null ? "—" : String(spreads)}
      </TableCell>
      <TableCell className="min-w-64 text-sm">{row.notes}</TableCell>
    </TableRow>
  );
};

export const PickListProposalPanel = ({
  gateway,
  lists,
}: Readonly<{
  gateway: PickListGateway;
  lists: readonly PickListOutput[];
}>) => {
  const fieldId = useId();
  const key = bucketKey(lists);
  const [state, setState] = useState<ProposalState>({ type: "idle" });
  const [nlvText, setNlvText] = useState("");
  const request = useRef(0);

  const load = useCallback(async () => {
    request.current += 1;
    const current = request.current;
    setState({ type: "loading" });
    try {
      const data = await gateway.proposal();
      if (current === request.current) setState({ type: "ready", data });
    } catch (error) {
      if (current === request.current)
        setState({ type: "error", message: describePickListFailure(error) });
    }
  }, [gateway]);

  useEffect(() => {
    if (key !== "") void load();
  }, [key, load]);

  const nlv = parseNlv(nlvText);
  const data = state.type === "ready" ? state.data : null;
  const proposed = data?.rows.filter((row) => row.tier !== "none") ?? [];
  return (
    <Card aria-label="Buy proposal" role="region">
      <CardHeader>
        <CardTitle headingLevel={2}>Buy proposal</CardTitle>
        <CardDescription>
          Defined-risk option structures for the members of every bucket.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-3 rounded-md border border-warning-border bg-warning-subtle p-3 text-sm text-warning-foreground">
          <ShieldAlert aria-hidden="true" className="size-5 shrink-0" />
          <p>
            <strong>Proposal only — no orders.</strong> Nothing on this page
            places, stages or changes an order. Trading stays an owner decision.
          </p>
        </div>
        {key === "" ? (
          <p className="text-muted-foreground text-sm">
            No buckets yet. Make a bucket from a list below to get a buy
            proposal.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <label className="space-y-1 text-sm" htmlFor={fieldId}>
                <span className="block">
                  NLV for sizing (USD, optional; stays in this tab)
                </span>
                <Input
                  className="w-48 font-mono"
                  id={fieldId}
                  inputMode="decimal"
                  onChange={(event) => setNlvText(event.target.value)}
                  placeholder="100000"
                  value={nlvText}
                />
              </label>
              <Button
                loading={state.type === "loading"}
                loadingLabel="Building proposal"
                onClick={() => void load()}
                type="button"
                variant="secondary"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                Refresh proposal
              </Button>
            </div>
            {state.type === "error" ? (
              <p className="text-destructive text-sm" role="alert">
                {state.message}
              </p>
            ) : null}
            {data === null ? null : (
              <>
                <p className="text-sm" role="status">
                  {`${data.rows.length} names · ${proposed.length} proposed · total max loss ${percent(data.totalMaxLossPct)} NLV`}
                  {nlv === null
                    ? ""
                    : ` (${usd.format((data.totalMaxLossPct / 100) * nlv)})`}
                  {` · computed ${data.computedAt}`}
                </p>
                <p className="text-muted-foreground text-xs">
                  {`Rules: options only, defined risk. Max loss per new position ≤ ${data.rules.maxLossGatePct}% NLV; premium per name ≤ ${data.rules.namePremiumCapPct}% NLV (< 365 DTE). Full size ${data.rules.fullMaxLossPct}% NLV, half size ${data.rules.halfMaxLossPct}% NLV. Call debit spread ${data.rules.dteMin}-${data.rules.dteMax} DTE, long ~${data.rules.longDelta} delta, short ~${data.rules.shortDelta} delta. Estimates: Black-Scholes on 1-year realized volatility, r = ${data.rules.riskFreeRate * 100}%. Strikes and expiry are picked from the live chain at entry.`}
                </p>
                <Table>
                  <TableCaption className="sr-only">
                    Buy proposal by bucket member (proposal only, no orders)
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Symbol</TableHead>
                      <TableHead scope="col">Bucket</TableHead>
                      <TableHead className="text-right" scope="col">
                        Last
                      </TableHead>
                      <TableHead scope="col">Size</TableHead>
                      <TableHead scope="col">Structure</TableHead>
                      <TableHead className="text-right" scope="col">
                        Est. debit
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Max loss / spread
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Max loss % NLV
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Spreads at NLV
                      </TableHead>
                      <TableHead scope="col">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <ProposalRow key={row.symbol} nlv={nlv} row={row} />
                    ))}
                  </TableBody>
                </Table>
                {data.notProposed.length === 0 ? null : (
                  <p className="text-muted-foreground text-sm">
                    {`Not proposed (first 60 names per run): ${data.notProposed.join(", ")}.`}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
