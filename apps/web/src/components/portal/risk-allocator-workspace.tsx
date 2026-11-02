"use client";

import type {
  OwnerRiskCaps,
  RiskAllocatorInput,
  RiskAllocatorRow,
  RiskAllocatorSuggestion,
} from "@darkfactory/api";
import { Badge, Button, Input, Label } from "@darkfactory/ui";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";
import {
  createBrowserRiskAllocatorGateway,
  type RiskAllocatorGateway,
} from "./risk-allocator-client.ts";

// Advisory risk allocator (Gamma Forge engines/risk_allocator.py port). It shows the owner's caps and
// the largest size one candidate may use under them. Advisory only: it does not enforce or change the
// caps, and it cannot place, change or cancel an order.

export interface RiskAllocatorForm {
  asOf: string;
  copyNameExposure: string;
  copyTotalExposure: string;
  crownCopy: boolean;
  expiry: string;
  kind: "option" | "share";
  nlv: string;
  openPremium: string;
  symbol: string;
  unitCost: string;
}

// A plain non-negative decimal; commas only as thousands separators ("1,500.25"). Empty means 0.
const AMOUNT_PATTERN = /^(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?$/u;

/** Parse a USD amount, or null when the text is not a finite number >= 0. */
export const parseAmount = (value: string): number | null => {
  const text = value.trim();
  if (text === "") return 0;
  if (!AMOUNT_PATTERN.test(text)) return null;
  const parsed = Number(text.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const amount = (value: string): number => parseAmount(value) ?? 0;

const unitCostLabel = (kind: RiskAllocatorForm["kind"]): string =>
  kind === "option" ? "Premium per contract (USD)" : "Price per share (USD)";

/**
 * Labels of amount fields whose text does not parse. An unparseable exposure must not silently
 * become 0, or the allocator would suggest more room than the caps allow.
 */
export const invalidAmountFields = (form: RiskAllocatorForm): string[] => {
  const checks: [string, string][] = [
    [form.unitCost, unitCostLabel(form.kind)],
    [form.nlv, "Net liquidation value (USD)"],
    [form.openPremium, "Option premium already open in this name"],
  ];
  if (form.crownCopy)
    checks.push(
      [form.copyNameExposure, "Copy book exposure in this name"],
      [form.copyTotalExposure, "Copy book exposure, all names"]
    );
  return checks
    .filter(([value]) => parseAmount(value) === null)
    .map(([, label]) => label);
};

/** Turn the form into the oRPC input. Open premium and copy exposure become synthetic positions. */
export const toAllocatorInput = (
  form: RiskAllocatorForm
): RiskAllocatorInput => {
  const symbol = form.symbol.trim().toUpperCase();
  const copyName = amount(form.copyNameExposure);
  const copyOther = Math.max(0, amount(form.copyTotalExposure) - copyName);
  const positions: NonNullable<RiskAllocatorInput["positions"]> = [];
  if (amount(form.openPremium) > 0)
    positions.push({ kind: "option", symbol, value: amount(form.openPremium) });
  if (form.crownCopy && copyName > 0)
    positions.push({ crownCopy: true, kind: "share", symbol, value: copyName });
  // Copy exposure in other names: one aggregate position under a placeholder symbol.
  if (form.crownCopy && copyOther > 0)
    positions.push({
      crownCopy: true,
      kind: "share",
      symbol: symbol === "OTHER" ? "OTHRS" : "OTHER",
      value: copyOther,
    });
  return {
    asOf: form.asOf,
    candidates: [
      {
        crownCopy: form.crownCopy,
        expiry:
          form.kind === "option" && form.expiry !== "" ? form.expiry : null,
        kind: form.kind,
        symbol,
        unitCost: amount(form.unitCost),
      },
    ],
    nlv: amount(form.nlv),
    positions,
  };
};

const usd = (value: number): string =>
  value.toLocaleString("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  });

const RULE_SET_LABEL: Readonly<Record<RiskAllocatorRow["ruleSet"], string>> = {
  "crown-copy": "Crown copy book",
  "options-only": "Options only",
};

// Local calendar date, as market-watch-bot uses date.today() (UTC can already be tomorrow).
const today = (): string => new Date().toLocaleDateString("en-CA");

const describeFailure = (error: unknown): string => {
  if (isOperatorAccessDenied(error)) return "Operator access required.";
  return error instanceof Error && error.message.trim() !== ""
    ? error.message.trim()
    : "Request failed.";
};

const CapsPanel = ({ caps }: { readonly caps: OwnerRiskCaps }) => (
  <section
    aria-labelledby="owner-caps-heading"
    className="space-y-3 rounded-lg border border-border p-4"
  >
    <h2 className="font-semibold text-lg" id="owner-caps-heading">
      Owner risk caps
    </h2>
    <dl className="grid gap-3 sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground text-sm">
          Every name except Crown copy legs
        </dt>
        <dd>
          {caps.optionsOnly ? "Options only. " : ""}Premium per name:{" "}
          {caps.leapsPremiumPct}% NLV for LEAPS ({caps.leapsMinDte}+ days),{" "}
          {caps.shortPremiumPct}% NLV for shorter-dated options. Open premium in
          the name counts.
          {caps.leapsPremiumPending === null ? null : (
            <span className="mt-1 block text-sm" data-testid="leaps-pending">
              Pending: {caps.leapsPremiumPending.pct}% NLV for LEAPS (
              {caps.leapsPremiumPending.commit}). The live gateway accepts{" "}
              {caps.leapsPremiumPct}% until it is deployed (
              {caps.leapsPremiumPending.tracking}). Sizes here use{" "}
              {caps.leapsPremiumPct}%.
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-sm">Crown copy book legs</dt>
        <dd>
          Shares and options allowed. {caps.copyBookNamePct}% NLV per name,{" "}
          {caps.copyBookTotalPct}% NLV total. The premium caps also apply to
          options.
        </dd>
      </div>
    </dl>
    <p className="text-muted-foreground text-sm">
      Source: {caps.source.repository} ({caps.source.files.join(", ")}).
      Decided:{" "}
      {caps.source.decided
        .map((item) => `${item.date} ${item.rule}`)
        .join("; ")}
      . Vertex shows these caps. It does not enforce or change them.
    </p>
  </section>
);

const ResultRow = ({ row }: { readonly row: RiskAllocatorRow }) => (
  <section
    aria-label={`Suggestion for ${row.symbol}`}
    className="space-y-3 rounded-lg border border-border p-4"
  >
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-semibold text-lg">
        {row.symbol} {row.kind === "option" ? "option" : "shares"}
      </h2>
      <Badge data-rule-set={row.ruleSet} variant="secondary">
        Rule set: {RULE_SET_LABEL[row.ruleSet]}
      </Badge>
      {row.isLeaps ? <Badge variant="outline">LEAPS</Badge> : null}
    </div>
    <p className="text-2xl" data-testid="max-units">
      Max {row.maxUnits.toLocaleString("en-US")}{" "}
      {row.kind === "option" ? "contracts" : "shares"} ({usd(row.maxUsd)})
    </p>
    {row.blockedReasons.length > 0 ? (
      <ul className="list-disc pl-5 text-sm">
        {row.blockedReasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    ) : null}
    {row.limits.length > 0 ? (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <thead>
            <tr className="border-border border-b">
              <th className="py-2 pr-3" scope="col">
                Limit
              </th>
              <th className="py-2 pr-3" scope="col">
                Cap
              </th>
              <th className="py-2 pr-3" scope="col">
                Used
              </th>
              <th className="py-2" scope="col">
                Room
              </th>
            </tr>
          </thead>
          <tbody>
            {row.limits.map((item) => (
              <tr className="border-border border-b" key={item.id}>
                <th className="py-2 pr-3 font-normal" scope="row">
                  {item.label}
                  {item.id === row.bindingLimit ? " (binding)" : ""}
                </th>
                <td className="py-2 pr-3">
                  {item.capPct}% = {usd(item.capUsd)}
                </td>
                <td className="py-2 pr-3">{usd(item.usedUsd)}</td>
                <td className="py-2">{usd(item.roomUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : null}
  </section>
);

export const RiskAllocatorWorkspace = ({
  gateway: provided,
  initialAsOf,
}: {
  readonly gateway?: RiskAllocatorGateway;
  readonly initialAsOf?: string;
}) => {
  const gateway = useMemo(
    () => provided ?? createBrowserRiskAllocatorGateway(),
    [provided]
  );
  const [caps, setCaps] = useState<OwnerRiskCaps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RiskAllocatorSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<RiskAllocatorForm>({
    asOf: initialAsOf ?? today(),
    copyNameExposure: "",
    copyTotalExposure: "",
    crownCopy: false,
    expiry: "",
    kind: "option",
    nlv: "",
    openPremium: "",
    symbol: "",
    unitCost: "",
  });

  useEffect(() => {
    let active = true;
    gateway.caps().then(
      (loaded) => {
        if (active) setCaps(loaded);
      },
      (failure: unknown) => {
        if (active) setError(describeFailure(failure));
      }
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  const update =
    (key: keyof RiskAllocatorForm) => (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invalid = invalidAmountFields(form);
    if (invalid.length > 0) {
      setResult(null);
      setError(
        `Enter a number of 0 or more (commas allowed) for: ${invalid.join(", ")}.`
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await gateway.suggest(toAllocatorInput(form)));
    } catch (failure) {
      setResult(null);
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof RiskAllocatorForm,
    label: string,
    props: { inputMode?: "decimal"; type?: string; required?: boolean } = {}
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`risk-${key}`}>{label}</Label>
      <Input
        id={`risk-${key}`}
        inputMode={props.inputMode}
        onChange={update(key)}
        required={props.required}
        type={props.type ?? "text"}
        value={String(form[key])}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Advisory only. This page computes sizes from the numbers you enter. It
        sends no order and changes no setting.
      </p>
      {caps === null ? null : <CapsPanel caps={caps} />}
      <form
        aria-label="Risk allocator"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={submit}
      >
        {field("symbol", "Symbol", { required: true })}
        <div className="space-y-1">
          <Label htmlFor="risk-kind">Instrument</Label>
          <select
            className="min-h-11 w-full rounded-md border border-input bg-background px-3"
            id="risk-kind"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                kind: event.target.value === "share" ? "share" : "option",
              }))
            }
            value={form.kind}
          >
            <option value="option">Option</option>
            <option value="share">Shares</option>
          </select>
        </div>
        {form.kind === "option"
          ? field("expiry", "Expiry", { type: "date" })
          : null}
        {field("unitCost", unitCostLabel(form.kind), {
          inputMode: "decimal",
          required: true,
        })}
        {field("nlv", "Net liquidation value (USD)", {
          inputMode: "decimal",
          required: true,
        })}
        {field("asOf", "As of", { required: true, type: "date" })}
        {field("openPremium", "Option premium already open in this name", {
          inputMode: "decimal",
        })}
        <label
          className="flex min-h-11 items-center gap-3"
          htmlFor="risk-crownCopy"
        >
          <input
            checked={form.crownCopy}
            className="size-5"
            id="risk-crownCopy"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                crownCopy: event.target.checked,
              }))
            }
            type="checkbox"
          />
          <span className="text-sm">Crown copy book leg</span>
        </label>
        {form.crownCopy
          ? field("copyNameExposure", "Copy book exposure in this name", {
              inputMode: "decimal",
            })
          : null}
        {form.crownCopy
          ? field("copyTotalExposure", "Copy book exposure, all names", {
              inputMode: "decimal",
            })
          : null}
        <div className="flex items-end">
          <Button disabled={busy} type="submit">
            Compute size
          </Button>
        </div>
      </form>
      {error === null ? null : (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      {result === null ? null : (
        <div aria-live="polite" className="space-y-4">
          {result.rows.map((row) => (
            <ResultRow key={`${row.symbol}-${row.kind}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
};
