"use client";

// Deploy panel: allocation of the portfolio to this strategy -> a PAPER deployment request in the
// existing approval flow. The server evaluates the master-rule and owner-cap gates with the live NLV.
// A rule conflict needs the owner's password and a typed explanation naming each rule (audited).
import type {
  AcademyDeployRequestOutput,
  AcademyGateOutput,
} from "@darkfactory/api";
import type { Lesson } from "@darkfactory/academy";
import { CircleAlert, CircleCheck, CircleX, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { type AcademyGateway, errorMessage } from "./academy-client.ts";
import { useAcademyTheme } from "./academy-theme.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";

// Status colors come from the Academy palette, not dark: utilities: the portal theme can be dark
// while the Academy is light, and dark: matches any dark ancestor.
const statusIcon = (
  status: "pass" | "warn" | "conflict",
  tokens: Readonly<Record<"green" | "amber" | "red", string>>
) =>
  status === "pass" ? (
    <CircleCheck aria-label="pass" className="size-4" color={tokens.green} />
  ) : status === "warn" ? (
    <CircleAlert aria-label="warning" className="size-4" color={tokens.amber} />
  ) : (
    <CircleX aria-label="conflict" className="size-4" color={tokens.red} />
  );

const field =
  "min-h-11 rounded-md border border-border bg-background px-2 text-sm text-foreground";

export const LessonDeploy = ({
  lesson,
  gateway,
}: {
  readonly lesson: Lesson;
  readonly gateway: AcademyGateway;
}) => {
  const preset = lesson.backtest;
  const [ticker, setTicker] = useState(preset?.tickers[0] ?? "SPY");
  const [allocationPct, setAllocationPct] = useState(5);
  const [riskPerTradePct, setRiskPerTradePct] = useState(20);
  const [tranches, setTranches] = useState(2);
  const [statedNlv, setStatedNlv] = useState("");
  const [gate, setGate] = useState<AcademyGateOutput | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [explanation, setExplanation] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AcademyDeployRequestOutput | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { palette } = useAcademyTheme();
  const input = useMemo(
    () => ({
      slug: lesson.slug,
      ticker,
      allocationPct,
      riskPerTradePct,
      tranches,
      ...(statedNlv.trim() === "" || !(Number(statedNlv) > 0)
        ? {}
        : { statedNlv: Number(statedNlv) }),
    }),
    [lesson.slug, ticker, allocationPct, riskPerTradePct, tranches, statedNlv]
  );

  useEffect(() => {
    if (!(allocationPct > 0 && riskPerTradePct > 0)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      gateway.deployPreview(input).then(
        (output) => {
          if (!active) return;
          setGate(output);
          setPreviewError(null);
          setAcknowledged((current) =>
            current.filter((id) => output.conflicts.includes(id))
          );
        },
        (error: unknown) => {
          if (active) setPreviewError(errorMessage(error));
        }
      );
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [gateway, input, allocationPct, riskPerTradePct]);

  if (preset === undefined) return null;
  const conflicts = gate?.conflicts ?? [];
  const blocked = conflicts.length > 0;
  // Without a live NLV the server sizes the paper limits from the stated NLV, so it is required.
  const nlvRequired = gate !== null && gate.nlv === null;
  const submit = () => {
    setSubmitting(true);
    setSubmitError(null);
    gateway
      .deployRequest(
        blocked
          ? { ...input, override: { password, acknowledged, explanation } }
          : input
      )
      .then(
        (output) => setResult(output),
        (error: unknown) => setSubmitError(errorMessage(error))
      )
      .finally(() => {
        setSubmitting(false);
        setPassword("");
      });
  };

  return (
    <div className="flex flex-col gap-4" data-lesson-deploy>
      <p
        className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
        role="note"
      >
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          This creates a <strong>paper</strong> deployment request in
          Deployments, where you approve it. Live routing to QuantVPS and IBKR
          is not enabled from here and needs your separate approval. No order is
          placed.
        </span>
      </p>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 sm:grid-cols-3 lg:grid-cols-5">
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="deploy-ticker"
        >
          Ticker
          <select
            className={field}
            id="deploy-ticker"
            onChange={(event) => setTicker(event.target.value)}
            value={ticker}
          >
            {preset.tickers.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="deploy-allocation"
        >
          Allocation (% of portfolio)
          <input
            className={field}
            data-deploy-allocation
            id="deploy-allocation"
            max={100}
            min={0.1}
            onChange={(event) => setAllocationPct(Number(event.target.value))}
            step={0.5}
            type="number"
            value={allocationPct}
          />
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="deploy-risk"
        >
          Max loss per position (% of allocation)
          <input
            className={field}
            id="deploy-risk"
            max={100}
            min={0.1}
            onChange={(event) => setRiskPerTradePct(Number(event.target.value))}
            step={1}
            type="number"
            value={riskPerTradePct}
          />
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="deploy-tranches"
        >
          Entry tranches
          <input
            className={field}
            id="deploy-tranches"
            max={10}
            min={1}
            onChange={(event) => setTranches(Number(event.target.value))}
            step={1}
            type="number"
            value={tranches}
          />
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="deploy-nlv"
          title="The gates always use the live IBKR portfolio feed. When the feed is down, this NLV sizes the paper limits of an overridden request and is recorded in the audit."
        >
          {nlvRequired
            ? "Your NLV ($, required: the live feed is down)"
            : "Your NLV ($, used only if the live feed is down)"}
          <input
            className={field}
            id="deploy-nlv"
            inputMode="decimal"
            min={1}
            onChange={(event) => setStatedNlv(event.target.value)}
            placeholder={nlvRequired ? "required" : "optional"}
            required={nlvRequired}
            type="number"
            value={statedNlv}
          />
        </label>
      </div>
      {previewError === null ? null : (
        <p
          className="rounded-md border border-destructive p-3 text-destructive text-sm"
          role="alert"
        >
          {previewError}
        </p>
      )}
      {gate === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          Checking the rule gates…
        </p>
      ) : (
        <div className="flex flex-col gap-3" data-gate-verdict={gate.verdict}>
          <p
            className={`rounded-md p-3 font-medium text-sm ${blocked ? "bg-red-500/10" : "bg-green-500/10"}`}
            style={{
              color: blocked ? palette.tokens.red : palette.tokens.green,
            }}
          >
            {blocked
              ? `Blocked by ${conflicts.length} rule(s): ${conflicts.join(", ")}.`
              : "All blocking gates pass."}{" "}
            Max loss per position $
            {Math.round(gate.premiumPerPositionUsd).toLocaleString("en-US")}
            {gate.premiumPerPositionPctNlv >= 0
              ? ` (${gate.premiumPerPositionPctNlv.toFixed(2)}% of NLV)`
              : ""}
            . NLV:{" "}
            {gate.nlv === null
              ? "unavailable"
              : `$${Math.round(gate.nlv).toLocaleString("en-US")}`}{" "}
            ({gate.nlvDetail}) Other Academy allocations:{" "}
            {gate.otherAllocationsPct.toFixed(1)}%.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table
              containerClassName="overflow-visible"
              className="w-full min-w-max text-sm"
              data-gate-checks
            >
              <TableCaption className="mt-0 caption-top px-3 py-2 text-left font-semibold text-foreground">
                Master-rule and owner-cap gates
              </TableCaption>
              <TableHeader className="bg-muted/60 text-muted-foreground text-xs">
                <TableRow>
                  <TableHead
                    className="px-3 py-2 text-left text-muted-foreground"
                    scope="col"
                  >
                    Status
                  </TableHead>
                  <TableHead
                    className="px-3 py-2 text-left text-muted-foreground"
                    scope="col"
                  >
                    Rule
                  </TableHead>
                  <TableHead
                    className="px-3 py-2 text-left text-muted-foreground"
                    scope="col"
                  >
                    Detail
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gate.checks.map((check) => (
                  <TableRow
                    className="border-border border-t"
                    data-gate-check={check.id}
                    data-gate-status={check.status}
                    key={check.id}
                  >
                    <TableCell className="whitespace-normal px-3 py-1.5">
                      {statusIcon(check.status, palette.tokens)}
                    </TableCell>
                    <TableCell className="whitespace-normal px-3 py-1.5 font-medium">
                      {check.id} · {check.title}
                    </TableCell>
                    <TableCell className="whitespace-normal px-3 py-1.5 text-muted-foreground">
                      {check.detail}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {blocked ? (
            <fieldset
              className="flex flex-col gap-3 rounded-lg border border-red-500/50 p-3"
              data-override-form
            >
              <legend className="px-1 font-semibold text-sm">
                Override (owner only, audited)
              </legend>
              <p className="text-muted-foreground text-sm">
                Tick each broken rule, write why you accept it (name each rule
                id, for example {conflicts[0]}), and enter your account
                password.
              </p>
              {conflicts.map((id) => {
                const check = gate.checks.find((entry) => entry.id === id);
                return (
                  <label
                    className="flex min-h-11 items-center gap-2 text-sm"
                    key={id}
                  >
                    <input
                      checked={acknowledged.includes(id)}
                      className="size-5"
                      data-ack={id}
                      onChange={(event) =>
                        setAcknowledged((current) =>
                          event.target.checked
                            ? [...current, id]
                            : current.filter((entry) => entry !== id)
                        )
                      }
                      type="checkbox"
                    />
                    I knowingly break {id}: {check?.title ?? id}
                  </label>
                );
              })}
              <label
                className="flex flex-col gap-1 text-muted-foreground text-xs"
                htmlFor="override-explanation"
              >
                Explanation (at least 40 characters, names each rule)
                <textarea
                  className="min-h-24 rounded-md border border-border bg-background p-2 text-foreground text-sm"
                  id="override-explanation"
                  maxLength={2000}
                  onChange={(event) => setExplanation(event.target.value)}
                  value={explanation}
                />
              </label>
              <label
                className="flex flex-col gap-1 text-muted-foreground text-xs"
                htmlFor="override-password"
              >
                Password
                <input
                  autoComplete="current-password"
                  className={field}
                  id="override-password"
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </label>
            </fieldset>
          ) : null}
          <button
            className="min-h-11 self-start rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60"
            data-deploy-submit
            disabled={
              submitting ||
              result !== null ||
              (nlvRequired && input.statedNlv === undefined) ||
              (blocked &&
                (password === "" ||
                  explanation.trim().length < 40 ||
                  conflicts.some((id) => !acknowledged.includes(id))))
            }
            onClick={submit}
            type="button"
          >
            {submitting
              ? "Creating…"
              : blocked
                ? "Override and create paper request"
                : "Create paper deployment request"}
          </button>
        </div>
      )}
      {submitError === null ? null : (
        <p
          className="rounded-md border border-destructive p-3 text-destructive text-sm"
          data-deploy-error
          role="alert"
        >
          {submitError}
        </p>
      )}
      {result === null ? null : (
        <p
          className="rounded-md border border-green-600/50 bg-green-500/10 p-3 text-sm"
          data-deploy-result={result.request.status}
          role="status"
        >
          Paper deployment request {result.request.id} is{" "}
          <strong>{result.request.status}</strong> for{" "}
          {result.request.strategySlug}
          {result.override.used
            ? ` with an audited override of ${result.override.rules.join(", ")}`
            : ""}
          . Approve or reject it in{" "}
          <Link
            className="underline"
            href="/deployments?view=requests"
            prefetch={false}
          >
            Deployments
          </Link>
          . Execution stays off.
        </p>
      )}
    </div>
  );
};
