"use client";

import type {
  OwnerRiskCaps,
  RiskAllocatorInput,
  RiskAllocatorRow,
  RiskAllocatorSuggestion,
  WatchlistItemOutput,
} from "@darkfactory/api";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  KpiCard,
  KpiRow,
  Label,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { CalendarRange, Copy, ListPlus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";
import { writeQuery } from "./backtest-lab-query.ts";
import {
  createBrowserRiskAllocatorGateway,
  type RiskAllocatorGateway,
} from "./risk-allocator-client.ts";
import {
  parseRiskAllocatorParams,
  type RiskAllocatorSettings,
} from "./risk-allocator-params.ts";
import {
  createBrowserWatchlistGateway,
  describeWatchlistFailure,
  type WatchlistGateway,
} from "./watchlist-client.ts";

// Advisory risk allocator (Gamma Forge engines/risk_allocator.py port). It shows the owner's caps and
// the largest size one candidate may use under them. Advisory only: it does not enforce or change the
// caps, and it cannot place, change or cancel an order. By default it sizes the first watchlist symbol
// with the labelled default inputs below; `?symbol=` picks another symbol.

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

/**
 * Example inputs for the default suggestion. They are shown in the form and labelled as defaults;
 * the owner replaces them with the real premium and net liquidation value.
 */
export const RISK_ALLOCATOR_DEFAULTS = {
  kind: "option",
  nlv: "100,000",
  unitCost: "500",
} as const satisfies Pick<RiskAllocatorForm, "kind" | "nlv" | "unitCost">;

/** Read-only view of the watchlist: the allocator only needs the symbols, in list order. */
export type RiskAllocatorWatchlist = Pick<WatchlistGateway, "list">;

/** The browser watchlist narrowed to `list`, so no write handle reaches the allocator. */
export const createBrowserRiskAllocatorWatchlist =
  (): RiskAllocatorWatchlist => {
    const { list } = createBrowserWatchlistGateway();
    return Object.freeze({ list });
  };

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

const CapsRules = ({ caps }: { readonly caps: OwnerRiskCaps }) => (
  <>
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
  </>
);

const CapsKpis = ({ caps }: { readonly caps: OwnerRiskCaps }) => (
  <KpiRow label="Owner risk caps">
    <KpiCard
      data-kpi="leaps"
      hint={`Premium per name, ${caps.leapsMinDte}+ days to expiry`}
      icon={<CalendarRange />}
      label="LEAPS premium cap"
      value={`${caps.leapsPremiumPct}% NLV`}
    />
    <KpiCard
      data-kpi="short"
      hint="Premium per name, shorter-dated options"
      icon={<ShieldCheck />}
      label="Shorter-dated premium cap"
      value={`${caps.shortPremiumPct}% NLV`}
    />
    <KpiCard
      data-kpi="copy"
      hint="NLV per name / total"
      icon={<Copy />}
      label="Crown copy book caps"
      value={`${caps.copyBookNamePct}% / ${caps.copyBookTotalPct}%`}
    />
  </KpiRow>
);

const ResultRow = ({ row }: { readonly row: RiskAllocatorRow }) => (
  <section
    aria-label={`Suggestion for ${row.symbol}`}
    className="space-y-3 rounded-lg border border-border p-4"
  >
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold text-lg">
        {row.symbol} {row.kind === "option" ? "option" : "shares"}
      </h3>
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
      <TableScroll label={`Limits for ${row.symbol}`} minWidth="28rem">
        <Table className="w-full text-left text-sm">
          <TableHeader>
            <TableRow className="border-border border-b">
              <TableHead
                className="py-2 pr-3 text-muted-foreground"
                scope="col"
              >
                Limit
              </TableHead>
              <TableHead
                className="py-2 pr-3 text-muted-foreground"
                scope="col"
              >
                Cap
              </TableHead>
              <TableHead
                className="py-2 pr-3 text-muted-foreground"
                scope="col"
              >
                Used
              </TableHead>
              <TableHead className="py-2 text-muted-foreground" scope="col">
                Room
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {row.limits.map((item) => (
              <TableRow className="border-border border-b" key={item.id}>
                <TableHead
                  className="h-auto whitespace-normal py-2 pr-3 font-normal"
                  scope="row"
                >
                  {item.label}
                  {item.id === row.bindingLimit ? " (binding)" : ""}
                </TableHead>
                <TableCell className="whitespace-normal py-2 pr-3">
                  {item.capPct}% = {usd(item.capUsd)}
                </TableCell>
                <TableCell className="whitespace-normal py-2 pr-3">
                  {usd(item.usedUsd)}
                </TableCell>
                <TableCell className="whitespace-normal py-2">
                  {usd(item.roomUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    ) : null}
  </section>
);

const DEFAULTS_NOTE =
  "Fields marked Default use example values: replace them and select Compute size.";

const suggestionDescription = (
  source: SymbolSource,
  symbol: string
): string | undefined => {
  if (source === "url")
    return `Sizing ${symbol} from the link. ${DEFAULTS_NOTE}`;
  if (source === "watchlist")
    return `Sizing ${symbol}, the first symbol on your watchlist. ${DEFAULTS_NOTE}`;
  return undefined;
};

type CapsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; caps: OwnerRiskCaps }>;

type WatchlistState =
  // `?symbol=` names the symbol: the watchlist is not read.
  | Readonly<{ type: "skipped" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; items: readonly WatchlistItemOutput[] }>;

// Where the symbol of the current suggestion came from.
type SymbolSource = "url" | "watchlist" | "form";

export const RiskAllocatorWorkspace = ({
  gateway: provided,
  initial,
  initialAsOf,
  watchlist: providedWatchlist,
}: {
  readonly gateway?: RiskAllocatorGateway;
  /** Settings restored from the URL (`?symbol=`). */
  readonly initial?: RiskAllocatorSettings;
  readonly initialAsOf?: string;
  /** Read-only watchlist; its first symbol is sized by default. */
  readonly watchlist?: RiskAllocatorWatchlist;
}) => {
  const gateway = useMemo(
    () => provided ?? createBrowserRiskAllocatorGateway(),
    [provided]
  );
  const watchlist = useMemo(
    () => providedWatchlist ?? createBrowserRiskAllocatorWatchlist(),
    [providedWatchlist]
  );
  const initialSymbol = initial?.symbol ?? null;
  const [caps, setCaps] = useState<CapsState>({ type: "loading" });
  const [list, setList] = useState<WatchlistState>(
    initialSymbol === null ? { type: "loading" } : { type: "skipped" }
  );
  // The symbol and source of the latest computed suggestion (not the live form).
  const [subject, setSubject] = useState<
    Readonly<{ source: SymbolSource; symbol: string }>
  >({
    source: initialSymbol === null ? "form" : "url",
    symbol: initialSymbol ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RiskAllocatorSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<RiskAllocatorForm>({
    asOf: initialAsOf ?? today(),
    copyNameExposure: "",
    copyTotalExposure: "",
    crownCopy: false,
    expiry: "",
    kind: RISK_ALLOCATOR_DEFAULTS.kind,
    nlv: RISK_ALLOCATOR_DEFAULTS.nlv,
    openPremium: "",
    symbol: initialSymbol ?? "",
    unitCost: RISK_ALLOCATOR_DEFAULTS.unitCost,
  });
  // The latest form, for the default suggestion that starts after the watchlist loads.
  const formRef = useRef(form);
  formRef.current = form;

  useEffect(() => {
    let active = true;
    gateway.caps().then(
      (loaded) => {
        if (active) setCaps({ caps: loaded, type: "ready" });
      },
      (failure: unknown) => {
        if (active)
          setCaps({ message: describeFailure(failure), type: "error" });
      }
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  const suggest = useCallback(
    async (next: RiskAllocatorForm, source: SymbolSource) => {
      // The panel text names the symbol of the result on screen, so it is set with the result.
      const computed = { source, symbol: next.symbol.trim().toUpperCase() };
      const invalid = invalidAmountFields(next);
      if (invalid.length > 0) {
        setResult(null);
        setSubject({ source: "form", symbol: "" });
        setError(
          `Enter a number of 0 or more (commas allowed) for: ${invalid.join(", ")}.`
        );
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const suggestion = await gateway.suggest(toAllocatorInput(next));
        setResult(suggestion);
        setSubject(computed);
      } catch (failure) {
        setResult(null);
        setSubject({ source: "form", symbol: "" });
        setError(describeFailure(failure));
      } finally {
        setBusy(false);
      }
    },
    [gateway]
  );

  // Default suggestion: the URL symbol, else the first watchlist symbol, with the default inputs.
  useEffect(() => {
    if (initialSymbol !== null) {
      void suggest(formRef.current, "url");
      return;
    }
    let active = true;
    watchlist.list().then(
      (items) => {
        if (!active) return;
        setList({ items, type: "ready" });
        const first = items[0]?.symbol;
        // Nothing to size, or the owner already typed a symbol: leave the form alone.
        if (first === undefined || formRef.current.symbol.trim() !== "") return;
        const next = { ...formRef.current, symbol: first };
        setForm(next);
        void suggest(next, "watchlist");
      },
      (failure: unknown) => {
        if (active)
          setList({
            message: describeWatchlistFailure(failure),
            type: "error",
          });
      }
    );
    return () => {
      active = false;
    };
  }, [initialSymbol, suggest, watchlist]);

  const update =
    (key: keyof RiskAllocatorForm) => (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Only the allocator's own key changes; foreign parameters (e.g. `theme`) are kept.
    writeQuery({
      symbol: parseRiskAllocatorParams({ symbol: form.symbol }).symbol,
    });
    void suggest(form, "form");
  };

  const field = (
    key: keyof RiskAllocatorForm,
    label: string,
    props: {
      hint?: string;
      inputMode?: "decimal";
      required?: boolean;
      type?: string;
    } = {}
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`risk-${key}`}>{label}</Label>
      <Input
        aria-describedby={
          props.hint === undefined ? undefined : `risk-${key}-default`
        }
        id={`risk-${key}`}
        inputMode={props.inputMode}
        onChange={update(key)}
        required={props.required}
        type={props.type ?? "text"}
        value={String(form[key])}
      />
      {props.hint === undefined ? null : (
        <p
          className="text-muted-foreground text-xs"
          data-default-for={key}
          id={`risk-${key}-default`}
        >
          {props.hint}
        </p>
      )}
    </div>
  );

  const description = suggestionDescription(subject.source, subject.symbol);
  const watchlistEmpty =
    list.type === "ready" && list.items.length === 0 && result === null;

  return (
    <div className="space-y-6">
      <PageHeader
        description="Your premium caps and a position size that fits them for one symbol. It never places orders or changes caps."
        status={<StatusBadge status="neutral">Advisory only</StatusBadge>}
        title="Risk allocator"
      />

      {caps.type === "ready" ? <CapsKpis caps={caps.caps} /> : null}

      <Panel
        contentClassName="space-y-3"
        description="Read only."
        headingId="owner-caps-heading"
        title="Owner risk caps"
      >
        {caps.type === "loading" ? (
          <p
            aria-busy="true"
            className="text-muted-foreground text-sm"
            role="status"
          >
            Loading caps…
          </p>
        ) : null}
        {caps.type === "error" ? (
          <p className="text-destructive" role="alert">
            {caps.message}
          </p>
        ) : null}
        {caps.type === "ready" ? <CapsRules caps={caps.caps} /> : null}
      </Panel>

      <Panel
        contentClassName="space-y-4"
        description={description}
        headingId="risk-suggestion-heading"
        title="Sizing suggestion"
      >
        {list.type === "loading" ? (
          <p className="text-muted-foreground text-sm">Loading watchlist…</p>
        ) : null}
        {list.type === "error" ? (
          <p className="text-sm" role="alert">
            Watchlist unavailable: {list.message} Enter a symbol below to get a
            suggestion.
          </p>
        ) : null}
        {watchlistEmpty ? (
          <EmptyState
            action={
              <Button asChild variant="outline">
                <Link href="/watchlist" prefetch={false}>
                  Open watchlist
                </Link>
              </Button>
            }
            description="The default suggestion sizes the first symbol on your watchlist. Add a symbol there, open this page with ?symbol=MSFT, or enter a symbol below and select Compute size."
            headingLevel={3}
            icon={<ListPlus />}
            title="No watchlist symbol to size"
          />
        ) : null}
        <form
          aria-label="Risk allocator"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={submit}
        >
          {field("symbol", "Symbol", { required: true })}
          <div className="space-y-1">
            <Label htmlFor="risk-kind">Instrument</Label>
            <select
              aria-describedby="risk-kind-default"
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
            <p
              className="text-muted-foreground text-xs"
              data-default-for="kind"
              id="risk-kind-default"
            >
              Default: Option
            </p>
          </div>
          {form.kind === "option"
            ? field("expiry", "Expiry", {
                hint: "Default: blank (sized with the shorter-dated cap)",
                type: "date",
              })
            : null}
          {field("unitCost", unitCostLabel(form.kind), {
            hint: `Default: ${RISK_ALLOCATOR_DEFAULTS.unitCost} (example cost, not a quote)`,
            inputMode: "decimal",
            required: true,
          })}
          {field("nlv", "Net liquidation value (USD)", {
            hint: `Default: ${RISK_ALLOCATOR_DEFAULTS.nlv} (example account size, not yours)`,
            inputMode: "decimal",
            required: true,
          })}
          {field("asOf", "As of", {
            hint: "Default: today",
            required: true,
            type: "date",
          })}
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
        {/* Always mounted so the first result is announced. */}
        <div aria-live="polite" className="space-y-4" data-risk-results="">
          {result?.rows.map((row) => (
            <ResultRow key={`${row.symbol}-${row.kind}`} row={row} />
          ))}
        </div>
      </Panel>

      <p className="text-muted-foreground text-sm">
        Advisory only. This page computes sizes from the numbers shown in the
        form. It sends no order and changes no cap or setting.
      </p>
    </div>
  );
};
