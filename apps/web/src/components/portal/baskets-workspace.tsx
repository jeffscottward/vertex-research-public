"use client";

import type { BasketOutput, BasketValuationOutput } from "@darkfactory/api";
import { Button, Input } from "@darkfactory/ui";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  // Basket symbol to open first (from ?symbol=); defaults to the first basket.
  readonly initialSymbol?: string | null;
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
  provisional:
    "Provisional base (latest full close). The base is fixed at the first full session close after creation.",
  pending: "Base pending: no common daily close for all members yet.",
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
  original: "",
  symbol: "",
  name: "",
  members: [
    { symbol: "", weight: "" },
    { symbol: "", weight: "" },
  ],
});

const draftFrom = (basket: BasketOutput): FormDraft => ({
  id: basket.id,
  original: memberKey(basket.members),
  symbol: basket.symbol,
  name: basket.name,
  members: basket.members.map((member) => ({
    symbol: member.symbol,
    weight: member.weight,
  })),
});

const weightSum = (members: readonly MemberDraft[]): number =>
  members.reduce((total, member) => total + (Number(member.weight) || 0), 0);

const BasketDetail = ({ state }: { readonly state: ValuationState }) => {
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
  const latest = data.latest;
  return (
    <section aria-label={`${data.basket.symbol} detail`} className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h2 className="font-semibold text-xl">
          {data.basket.symbol}{" "}
          <span className="font-normal text-base text-muted-foreground">
            {data.basket.name}
          </span>
        </h2>
        <span className="font-mono text-2xl" data-testid="basket-latest-value">
          {formatIndex(latest?.value ?? null)}
        </span>
        <span className="text-sm">
          since base {formatPct(latest?.changePct ?? null)} · day{" "}
          {formatPct(latest?.dayChangePct ?? null)}
        </span>
        <span className="text-muted-foreground text-sm">
          {data.benchmarkSymbol} {formatIndex(latest?.benchmark ?? null)}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {BASE_STATE_TEXT[data.baseState]}
        {data.baseDate === null
          ? ""
          : ` Base date ${data.baseDate}, value ${data.basket.baseValue}.`}{" "}
        Last close {latest?.date ?? "—"}. Daily closes only (IBKR history); no
        intraday quotes.
      </p>
      {data.staleSymbols.length > 0 && (
        <p className="text-amber-600 text-sm dark:text-amber-400" role="status">
          Stale: {data.staleSymbols.join(", ")} has no close on the latest date.
          Dates without a close for every member are left out, never set to
          zero.
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
      <BasketChart
        benchmarkSymbol={data.benchmarkSymbol}
        points={data.points}
        symbol={data.basket.symbol}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <caption className="sr-only">Member contribution</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2" scope="col">
                Member
              </th>
              <th className="py-2 text-right" scope="col">
                Weight
              </th>
              <th className="py-2 text-right" scope="col">
                Base
              </th>
              <th className="py-2 text-right" scope="col">
                Last
              </th>
              <th className="py-2 text-right" scope="col">
                Return
              </th>
              <th className="py-2 text-right" scope="col">
                Contribution (pts)
              </th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => (
              <tr className="border-b last:border-0" key={member.symbol}>
                <th
                  className="py-2 text-left font-medium font-mono"
                  scope="row"
                >
                  {member.symbol}
                  {member.stale && (
                    <span className="ml-2 text-amber-600 text-xs dark:text-amber-400">
                      stale
                    </span>
                  )}
                </th>
                <td className="py-2 text-right font-mono">
                  {(member.weight * 100).toFixed(2)}%
                </td>
                <td className="py-2 text-right font-mono">
                  {formatIndex(member.basePrice)}
                </td>
                <td className="py-2 text-right font-mono">
                  {formatIndex(member.lastPrice)}
                </td>
                <td className="py-2 text-right font-mono">
                  {formatPct(member.returnPct)}
                </td>
                <td className="py-2 text-right font-mono">
                  {member.contribution === null
                    ? "—"
                    : `${member.contribution >= 0 ? "+" : ""}${member.contribution.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export const BasketsWorkspace = ({
  gateway: suppliedGateway,
  initialSymbol = null,
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
    async (id: string) => {
      setSelectedId(id);
      latestRequest.current = id;
      setValuation({ type: "loading", id });
      try {
        const data = await gateway.valuation(id);
        if (latestRequest.current !== id) return;
        return setValuation({ type: "ready", data });
      } catch (error) {
        if (latestRequest.current !== id) return;
        return setValuation({
          type: "error",
          id,
          message: describeBasketFailure(error),
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    void (async () => {
      const next = await load();
      const wanted = initialSymbol?.toUpperCase() ?? null;
      const first =
        next?.find((basket) => basket.symbol === wanted) ?? next?.[0];
      if (first !== undefined) await select(first.id);
    })();
  }, [initialSymbol, load, select]);

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
              symbol: form.symbol,
              name: form.name,
              members,
            })
          : await gateway.update({
              id: form.id,
              name: form.name,
              ...(memberKey(members) === form.original ? {} : { members }),
            });
      setDraft(null);
      setFormError(null);
      await load();
      await select(saved.id);
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

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Custom baskets track an equal- or custom-weighted price index of several
        stocks, like a private ETF. Tracking only: no orders.
      </p>
      {listError !== null && (
        <p className="text-destructive text-sm" role="alert">
          {listError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2" data-click-private="">
        {(items ?? []).map((basket) => (
          <span className="inline-flex items-center gap-1" key={basket.id}>
            <Button
              aria-pressed={selectedId === basket.id}
              onClick={() => void select(basket.id)}
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
        <Button
          onClick={() => {
            setFormError(null);
            return setDraft(blankDraft());
          }}
          type="button"
          variant="secondary"
        >
          <Plus aria-hidden="true" className="size-4" />
          New basket
        </Button>
      </div>
      {items !== null && items.length === 0 && draft === null && (
        <p className="text-muted-foreground text-sm">No baskets yet.</p>
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
      <BasketDetail state={valuation} />
    </div>
  );
};
