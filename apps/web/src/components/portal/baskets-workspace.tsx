"use client";

import type { BasketOutput, BasketValuationOutput } from "@darkfactory/api";
import {
  Button,
  Input,
  KpiCard,
  KpiRow,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { TickerLink } from "../ticker-link.tsx";
import { BasketChart } from "./basket-chart.tsx";
import {
  type BasketGateway,
  createBrowserBasketGateway,
  describeBasketFailure,
  equalWeights,
  formatIndex,
  formatPct,
} from "./baskets-client.ts";

export interface BasketsWorkspaceProps {
  readonly gateway?: BasketGateway;
  // Basket to open first (from ?basket=, by id, symbol or name; legacy ?symbol=); defaults to the first basket.
  readonly initialBasket?: string | null;
}

type MemberDraft = Readonly<{ symbol: string; weight: string }>;
type FormDraft = Readonly<{
  id: string | null;
  // Members as loaded; unchanged members are not sent, so a rename keeps the base.
  original: string;
  symbol: string;
  name: string;
  members: MemberDraft[];
}>;

type ValuationState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading"; id: string }>
  | Readonly<{ type: "ready"; data: BasketValuationOutput }>
  | Readonly<{ type: "error"; id: string; message: string }>;

const BASE_STATE_TEXT: Record<BasketValuationOutput["baseState"], string> = {
  fixed: "Base fixed",
  pending: "Base pending: no common daily close for all members yet.",
  provisional:
    "Provisional base (latest full close). The base is fixed at the first full session close after creation.",
};

const memberKey = (members: readonly MemberDraft[]): string =>
  JSON.stringify(
    members.map((member) => [
      member.symbol.trim().toUpperCase(),
      Number(member.weight),
    ])
  );

const blankDraft = (): FormDraft => ({
  id: null,
  members: [
    { symbol: "", weight: "" },
    { symbol: "", weight: "" },
  ],
  name: "",
  original: "",
  symbol: "",
});

const draftFrom = (basket: BasketOutput): FormDraft => ({
  id: basket.id,
  members: basket.members.map((member) => ({
    symbol: member.symbol,
    weight: member.weight,
  })),
  name: basket.name,
  original: memberKey(basket.members),
  symbol: basket.symbol,
});

const weightSum = (members: readonly MemberDraft[]): number =>
  members.reduce((total, member) => total + (Number(member.weight) || 0), 0);

// The basket a ?basket= value names: id, symbol or display name (case-insensitive).
export const findBasket = (
  baskets: readonly BasketOutput[],
  wanted: string | null
): BasketOutput | undefined => {
  const key = wanted?.trim().toLowerCase() ?? "";
  if (key === "") return undefined;
  return baskets.find(
    (basket) =>
      basket.id.toLowerCase() === key ||
      basket.symbol.toLowerCase() === key ||
      basket.name.toLowerCase() === key
  );
};

// Mirrors the selection into ?basket= (by symbol) without a navigation; drops the legacy ?symbol=.
const writeBasketParam = (symbol: string | null): void => {
  const url = new URL(window.location.href);
  url.searchParams.delete("symbol");
  if (symbol === null) url.searchParams.delete("basket");
  else url.searchParams.set("basket", symbol);
  window.history.replaceState(window.history.state, "", url);
};

const BasketKpis = ({ data }: { readonly data: BasketValuationOutput }) => {
  const latest = data.latest;
  if (latest === null) return null;
  return (
    <KpiRow label={`${data.basket.symbol} summary`}>
      <KpiCard
        data-testid="basket-latest-value"
        hint={`Last close ${latest.date}`}
        label="Level"
        value={formatIndex(latest.value)}
      />
      <KpiCard
        hint={
          data.baseDate === null ? "Base not fixed" : `Base ${data.baseDate}`
        }
        label="Since base"
        value={formatPct(latest.changePct)}
      />
      <KpiCard
        hint={`${data.benchmarkSymbol} ${formatIndex(latest.benchmark)}`}
        label="Day change"
        value={formatPct(latest.dayChangePct)}
      />
    </KpiRow>
  );
};

const BasketNotes = ({ data }: { readonly data: BasketValuationOutput }) => (
  <div className="space-y-2">
    <p className="text-muted-foreground text-xs">
      {BASE_STATE_TEXT[data.baseState]}
      {data.baseDate === null
        ? ""
        : ` Base date ${data.baseDate}, value ${data.basket.baseValue}.`}{" "}
      Last close {data.latest?.date ?? "—"}. Daily closes only (IBKR history);
      no intraday quotes.
    </p>
    {data.staleSymbols.length > 0 && (
      <p className="text-amber-600 text-sm dark:text-amber-400" role="status">
        Stale: {data.staleSymbols.join(", ")} has no close on the latest date.
        Dates without a close for every member are left out, never set to zero.
      </p>
    )}
    {data.unavailable.length > 0 && (
      <p className="text-destructive text-sm" role="status">
        History unavailable:{" "}
        {data.unavailable
          .map((entry) => `${entry.symbol} (${entry.reason})`)
          .join("; ")}
      </p>
    )}
  </div>
);

const BasketConstituents = ({
  data,
}: {
  readonly data: BasketValuationOutput;
}) => (
  <Panel
    description="Weight, base and last daily close, return and index points contributed."
    flush
    headingId="basket-constituents-heading"
    title="Constituents"
  >
    <TableScroll label="Basket constituents table" minWidth="40rem">
      <Table className="w-full text-sm">
        <TableCaption className="sr-only">Member contribution</TableCaption>
        <TableHeader>
          <TableRow className="text-left text-muted-foreground">
            <TableHead scope="col">Member</TableHead>
            <TableHead className="text-right" scope="col">
              Weight
            </TableHead>
            <TableHead className="text-right" scope="col">
              Base
            </TableHead>
            <TableHead className="text-right" scope="col">
              Last
            </TableHead>
            <TableHead className="text-right" scope="col">
              Return
            </TableHead>
            <TableHead className="text-right" scope="col">
              Contribution (pts)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.members.map((member) => (
            <TableRow key={member.symbol}>
              <TableHead className="text-left font-normal" scope="row">
                <TickerLink symbol={member.symbol} />
                {member.stale && (
                  <span className="ml-2 text-amber-600 text-xs dark:text-amber-400">
                    stale
                  </span>
                )}
              </TableHead>
              <TableCell className="text-right font-mono">
                {(member.weight * 100).toFixed(2)}%
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatIndex(member.basePrice)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatIndex(member.lastPrice)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatPct(member.returnPct)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {member.contribution === null
                  ? "—"
                  : `${member.contribution >= 0 ? "+" : ""}${member.contribution.toFixed(2)}`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  </Panel>
);

const ValuationBody = ({ state }: { readonly state: ValuationState }) => {
  if (state.type === "idle") return null;
  if (state.type === "loading") {
    return (
      <p
        aria-live="polite"
        className="text-muted-foreground text-sm"
        role="status"
      >
        Loading index from daily closes…
      </p>
    );
  }
  if (state.type === "error") {
    return (
      <p className="text-destructive text-sm" role="alert">
        {state.message}
      </p>
    );
  }
  const { data } = state;
  return (
    <div className="space-y-4">
      <BasketChart
        benchmarkSymbol={data.benchmarkSymbol}
        points={data.points}
        symbol={data.basket.symbol}
      />
      <BasketNotes data={data} />
    </div>
  );
};

export const BasketsWorkspace = ({
  gateway: suppliedGateway,
  initialBasket = null,
}: BasketsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserBasketGateway()
  );
  const [items, setItems] = useState<BasketOutput[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [valuation, setValuation] = useState<ValuationState>({ type: "idle" });
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Only the latest selection may write the detail panel (responses can arrive out of order).
  const latestRequest = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await gateway.list();
      setItems(next);
      setListError(null);
      return next;
    } catch (error) {
      setListError(describeBasketFailure(error));
      return null;
    }
  }, [gateway]);

  const select = useCallback(
    async (id: string, symbol: string) => {
      setSelectedId(id);
      writeBasketParam(symbol);
      latestRequest.current = id;
      setValuation({ id, type: "loading" });
      try {
        const data = await gateway.valuation(id);
        if (latestRequest.current !== id) return;
        return setValuation({ data, type: "ready" });
      } catch (error) {
        if (latestRequest.current !== id) return;
        return setValuation({
          id,
          message: describeBasketFailure(error),
          type: "error",
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    void (async () => {
      const next = await load();
      const first = findBasket(next ?? [], initialBasket) ?? next?.[0];
      if (first !== undefined) await select(first.id, first.symbol);
    })();
  }, [initialBasket, load, select]);

  const save = async (form: FormDraft) => {
    const sum = weightSum(form.members);
    if (Math.abs(sum - 1) > 0.000_001) {
      return setFormError(
        `Weights must sum to 1 (now ${sum.toFixed(6)}). Use Equal weights or edit them.`
      );
    }
    const members = form.members.map((member) => ({
      symbol: member.symbol,
      weight: member.weight,
    }));
    setBusy(true);
    try {
      const saved =
        form.id === null
          ? await gateway.create({
              members,
              name: form.name,
              symbol: form.symbol,
            })
          : await gateway.update({
              id: form.id,
              name: form.name,
              ...(memberKey(members) === form.original ? {} : { members }),
            });
      setDraft(null);
      setFormError(null);
      await load();
      await select(saved.id, saved.symbol);
    } catch (error) {
      setFormError(describeBasketFailure(error));
    }
    return setBusy(false);
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await gateway.remove(id);
      setConfirmRemoveId(null);
      if (selectedId === id) {
        latestRequest.current = null;
        setSelectedId(null);
        writeBasketParam(null);
        setValuation({ type: "idle" });
      }
      await load();
    } catch (error) {
      setListError(describeBasketFailure(error));
    }
    return setBusy(false);
  };

  const setMember = (
    form: FormDraft,
    index: number,
    patch: Partial<MemberDraft>
  ) => {
    return setDraft({
      ...form,
      members: form.members.map((member, position) =>
        position === index ? { ...member, ...patch } : member
      ),
    });
  };

  const selected = items?.find((basket) => basket.id === selectedId);
  const ready = valuation.type === "ready" ? valuation.data : null;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            onClick={() => {
              setFormError(null);
              return setDraft(blankDraft());
            }}
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
            New basket
          </Button>
        }
        description="Custom baskets track an equal- or custom-weighted price index of several stocks, like a private ETF. Tracking only: no orders."
        status={
          <StatusBadge data-testid="baskets-status" status="neutral">
            {items === null
              ? listError === null
                ? "Loading"
                : "Unavailable"
              : `${items.length} ${items.length === 1 ? "basket" : "baskets"}`}
          </StatusBadge>
        }
        title="Baskets"
      />
      {listError !== null && (
        <p className="text-destructive text-sm" role="alert">
          {listError}
        </p>
      )}
      {draft !== null && (
        <form
          aria-label={draft.id === null ? "New basket" : `Edit ${draft.symbol}`}
          className="space-y-3 rounded-lg border p-4"
          data-click-private=""
          onSubmit={(event) => {
            event.preventDefault();
            return void save(draft);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>Symbol</span>
              <Input
                disabled={draft.id !== null}
                maxLength={10}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    symbol: event.target.value.toUpperCase(),
                  })
                }
                placeholder="TITY"
                required
                value={draft.symbol}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>Name</span>
              <Input
                maxLength={80}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                required
                value={draft.name}
              />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm">
              Members (weights sum to 1; now{" "}
              {weightSum(draft.members).toFixed(4)})
            </legend>
            {draft.members.map((member, index) => (
              <div className="flex gap-2" key={index}>
                <Input
                  aria-label={`Member ${index + 1} ticker`}
                  className="font-mono"
                  maxLength={10}
                  onChange={(event) =>
                    setMember(draft, index, {
                      symbol: event.target.value.toUpperCase(),
                    })
                  }
                  required
                  value={member.symbol}
                />
                <Input
                  aria-label={`Member ${index + 1} weight`}
                  inputMode="decimal"
                  onChange={(event) =>
                    setMember(draft, index, { weight: event.target.value })
                  }
                  placeholder="0.5"
                  required
                  value={member.weight}
                />
                <Button
                  aria-label={`Remove member ${index + 1}`}
                  disabled={draft.members.length <= 1}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      members: draft.members.filter(
                        (_, position) => position !== index
                      ),
                    })
                  }
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  setDraft({
                    ...draft,
                    members: [...draft.members, { symbol: "", weight: "" }],
                  })
                }
                type="button"
                variant="secondary"
              >
                <Plus aria-hidden="true" className="size-4" />
                Add member
              </Button>
              <Button
                onClick={() => {
                  const weights = equalWeights(draft.members.length);
                  return setDraft({
                    ...draft,
                    members: draft.members.map((entry, position) => ({
                      ...entry,
                      weight: weights[position] as string,
                    })),
                  });
                }}
                type="button"
                variant="secondary"
              >
                Equal weights
              </Button>
            </div>
          </fieldset>
          {draft.id !== null && (
            <p className="text-muted-foreground text-xs">
              Changing members resets the base. It is fixed again at the next
              full session close.
            </p>
          )}
          {formError !== null && (
            <p className="text-destructive text-sm" role="alert">
              {formError}
            </p>
          )}
          <div className="flex gap-2">
            <Button disabled={busy} type="submit">
              Save basket
            </Button>
            <Button
              onClick={() => setDraft(null)}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {items !== null && items.length === 0 && draft === null && (
        <p className="text-muted-foreground text-sm">No baskets yet.</p>
      )}
      {ready !== null && <BasketKpis data={ready} />}
      {items !== null && items.length > 0 && (
        <Panel
          actions={
            <div
              className="flex flex-wrap items-center gap-2"
              data-click-private=""
            >
              {items.map((basket) => (
                <span
                  className="inline-flex items-center gap-1"
                  key={basket.id}
                >
                  <Button
                    aria-pressed={selectedId === basket.id}
                    onClick={() => void select(basket.id, basket.symbol)}
                    type="button"
                    variant={selectedId === basket.id ? "default" : "secondary"}
                  >
                    <span className="font-mono">{basket.symbol}</span>
                  </Button>
                  <Button
                    aria-label={`Edit ${basket.symbol}`}
                    onClick={() => {
                      setFormError(null);
                      return setDraft(draftFrom(basket));
                    }}
                    type="button"
                    variant="ghost"
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                  {confirmRemoveId === basket.id ? (
                    <Button
                      aria-label={`Confirm delete ${basket.symbol}`}
                      disabled={busy}
                      onClick={() => void remove(basket.id)}
                      type="button"
                      variant="destructive"
                    >
                      Confirm delete
                    </Button>
                  ) : (
                    <Button
                      aria-label={`Delete ${basket.symbol}`}
                      onClick={() => setConfirmRemoveId(basket.id)}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                </span>
              ))}
            </div>
          }
          // Panel actions do not shrink; let the basket picker wrap to the panel width on phones.
          className="[&>header>div:last-child]:min-w-0 [&>header>div:last-child]:shrink"
          headingId="basket-chart-heading"
          title={
            selected === undefined ? (
              "Index"
            ) : (
              <>
                <span className="font-mono">{selected.symbol}</span>{" "}
                <span className="font-normal text-muted-foreground text-sm">
                  {selected.name}
                </span>
              </>
            )
          }
        >
          <ValuationBody state={valuation} />
        </Panel>
      )}
      {ready !== null && <BasketConstituents data={ready} />}
    </div>
  );
};
