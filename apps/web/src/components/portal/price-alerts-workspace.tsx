"use client";

import {
  PRICE_ALERT_KINDS,
  PRICE_ALERT_NOTE_MAX_LENGTH,
  PRICE_ALERT_ROLES,
  type PriceAlertCheckOutput,
  type PriceAlertDelivery,
  type PriceAlertKind,
  type PriceAlertListOutput,
  type PriceAlertRole,
  type PriceAlertRule,
} from "@darkfactory/api";
import { Badge, Button, Input } from "@darkfactory/ui";
import { BellRing, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import {
  createBrowserPriceAlertsGateway,
  describePriceAlertFailure,
  type PriceAlertsGateway,
} from "./price-alerts-client.ts";

// Price alerts page: a rule watches one watchlist symbol for a price at or above / at or below a
// level. Check now evaluates the active rules; a trigger is shown here with the price that reached
// the level and sends one fixed-text phone notification when configured. Research only; no orders.

export interface PriceAlertsWorkspaceProps {
  readonly gateway?: PriceAlertsGateway;
}

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: PriceAlertListOutput }>
  | Readonly<{ type: "error"; message: string }>;

const KIND_LABELS: Readonly<Record<PriceAlertKind, string>> = {
  above: "At or above",
  below: "At or below",
};
const ROLE_LABELS: Readonly<Record<PriceAlertRole, string>> = {
  price: "Price",
  stop: "Stop",
  target: "Target",
};
const DELIVERY_LABELS: Readonly<Record<PriceAlertDelivery, string>> = {
  failed: "Notification failed",
  "not-configured": "Notification not configured",
  pending: "Notification pending",
  sent: "Notification sent",
};
const CHECK_DELIVERY_LABELS: Readonly<
  Record<PriceAlertCheckOutput["delivery"], string>
> = {
  ...DELIVERY_LABELS,
  none: "no notification needed",
};

const utc = (date: Date): string =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One line summary of a check run. */
export const describePriceAlertCheck = (
  result: PriceAlertCheckOutput
): string => {
  const parts = [
    `Checked ${result.checked} rule${result.checked === 1 ? "" : "s"}`,
    `${result.triggered.length} triggered`,
    CHECK_DELIVERY_LABELS[result.delivery].toLowerCase(),
  ];
  if (result.quoteErrors.length > 0)
    parts.push(
      `no quote for ${result.quoteErrors.map((error) => `${error.symbol} (${error.reason})`).join(", ")}`
    );
  return parts.join(" · ");
};

const selectClass =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm";

const RuleItem = ({
  rule,
  busy,
  onRemove,
}: {
  readonly rule: PriceAlertRule;
  readonly busy: boolean;
  readonly onRemove: (rule: PriceAlertRule) => void;
}) => (
  <li
    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
    data-rule={rule.id}
  >
    <div className="min-w-0 space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{rule.symbol}</span>
        <span>
          {KIND_LABELS[rule.kind].toLowerCase()}{" "}
          <span className="font-mono">{rule.level}</span>
        </span>
        <Badge variant="secondary">{ROLE_LABELS[rule.role]}</Badge>
      </p>
      {rule.note === null ? null : (
        <p className="break-words text-muted-foreground text-sm">{rule.note}</p>
      )}
      <p className="text-muted-foreground text-xs">
        {rule.state.status === "triggered"
          ? `Triggered at ${rule.state.triggerPrice} on ${utc(rule.state.triggeredAt)} · ${DELIVERY_LABELS[rule.state.delivery]}`
          : `Last checked ${rule.state.lastCheckedAt === null ? "never" : utc(rule.state.lastCheckedAt)}`}
      </p>
    </div>
    <Button
      aria-label={`Remove ${rule.symbol} ${KIND_LABELS[rule.kind].toLowerCase()} ${rule.level}`}
      className="min-h-11"
      disabled={busy}
      onClick={() => onRemove(rule)}
      type="button"
      variant="secondary"
    >
      <Trash2 aria-hidden="true" className="size-4" />
      Remove
    </Button>
  </li>
);

export const PriceAlertsWorkspace = ({
  gateway: suppliedGateway,
}: PriceAlertsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserPriceAlertsGateway()
  );
  const ids = useId();
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const [symbol, setSymbol] = useState("");
  const [kind, setKind] = useState<PriceAlertKind>("above");
  const [role, setRole] = useState<PriceAlertRole>("price");
  const [level, setLevel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      const data = await gateway.list();
      setSymbol(data.symbols[0] ?? "");
      return setState({ data, type: "ready" });
    } catch (error) {
      return setState({
        message: describePriceAlertFailure(error),
        type: "error",
      });
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  if (state.type === "loading")
    return (
      <p aria-busy="true" className="text-muted-foreground text-sm">
        Loading price alerts…
      </p>
    );
  if (state.type === "error")
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm">{state.message}</p>
        <Button
          className="min-h-11"
          onClick={() => void load()}
          type="button"
          variant="secondary"
        >
          Retry
        </Button>
      </div>
    );

  const { data } = state;
  const withRules = (rules: PriceAlertRule[]) =>
    setState({ data: { ...data, rules }, type: "ready" });

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setFeedback(await action());
    } catch (error) {
      setFeedback(describePriceAlertFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      if (level.trim() === "") return "Enter a level.";
      const rule = await gateway.create({
        kind,
        level: level.trim(),
        note,
        role,
        symbol,
      });
      withRules([rule, ...data.rules]);
      setLevel("");
      setNote("");
      return `Alert created for ${rule.symbol}.`;
    });

  const check = () =>
    run(async () => {
      const result = await gateway.check();
      withRules(result.rules);
      return describePriceAlertCheck(result);
    });

  const remove = (rule: PriceAlertRule) =>
    run(async () => {
      await gateway.remove(rule.id);
      withRules(data.rules.filter((entry) => entry.id !== rule.id));
      return `Alert for ${rule.symbol} removed.`;
    });

  const active = data.rules.filter((rule) => rule.state.status === "active");
  const triggered = data.rules.filter(
    (rule) => rule.state.status === "triggered"
  );
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Alerts are research notices, not instructions to trade. Phone
        notifications:{" "}
        {data.notifications === "configured"
          ? "on (fixed text; details stay on this page)."
          : "not configured; triggered alerts show here only."}
      </p>
      <section
        aria-labelledby={`${ids}-create`}
        className="space-y-3 rounded-md border border-border p-4"
      >
        <h2 className="font-semibold" id={`${ids}-create`}>
          New alert
        </h2>
        {data.symbols.length === 0 ? (
          <p className="text-sm">
            Your watchlist is empty. Add symbols on the{" "}
            <a className="underline" href="/watchlist">
              watchlist
            </a>{" "}
            first; alerts watch watchlist symbols only.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1">
                <label className="text-sm" htmlFor={`${ids}-symbol`}>
                  Symbol
                </label>
                <select
                  className={selectClass}
                  id={`${ids}-symbol`}
                  onChange={(event) => setSymbol(event.target.value)}
                  value={symbol}
                >
                  {data.symbols.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm" htmlFor={`${ids}-kind`}>
                  Condition
                </label>
                <select
                  className={selectClass}
                  id={`${ids}-kind`}
                  onChange={(event) =>
                    setKind(event.target.value as PriceAlertKind)
                  }
                  value={kind}
                >
                  {PRICE_ALERT_KINDS.map((entry) => (
                    <option key={entry} value={entry}>
                      {KIND_LABELS[entry]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm" htmlFor={`${ids}-level`}>
                  Level
                </label>
                <Input
                  className="min-h-11"
                  id={`${ids}-level`}
                  inputMode="decimal"
                  onChange={(event) => setLevel(event.target.value)}
                  placeholder="54.00"
                  value={level}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm" htmlFor={`${ids}-role`}>
                  Role
                </label>
                <select
                  className={selectClass}
                  id={`${ids}-role`}
                  onChange={(event) =>
                    setRole(event.target.value as PriceAlertRole)
                  }
                  value={role}
                >
                  {PRICE_ALERT_ROLES.map((entry) => (
                    <option key={entry} value={entry}>
                      {ROLE_LABELS[entry]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm" htmlFor={`${ids}-note`}>
                  Note (optional)
                </label>
                <Input
                  className="min-h-11"
                  id={`${ids}-note`}
                  maxLength={PRICE_ALERT_NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  value={note}
                />
              </div>
            </div>
            <Button
              className="min-h-11"
              disabled={busy}
              onClick={() => void create()}
              type="button"
            >
              <Plus aria-hidden="true" className="size-4" />
              Create alert
            </Button>
          </>
        )}
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          disabled={busy || active.length === 0}
          onClick={() => void check()}
          type="button"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Check now
        </Button>
        <div aria-live="polite" className="min-h-5 text-sm" role="status">
          {feedback}
        </div>
      </div>
      <section aria-labelledby={`${ids}-active`} className="space-y-2">
        <h2 className="font-semibold" id={`${ids}-active`}>
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active alerts.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((rule) => (
              <RuleItem
                busy={busy}
                key={rule.id}
                onRemove={(entry) => void remove(entry)}
                rule={rule}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={`${ids}-triggered`} className="space-y-2">
        <h2
          className="flex items-center gap-2 font-semibold"
          id={`${ids}-triggered`}
        >
          <BellRing aria-hidden="true" className="size-4" />
          Triggered ({triggered.length})
        </h2>
        {triggered.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No alert has triggered yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {triggered.map((rule) => (
              <RuleItem
                busy={busy}
                key={rule.id}
                onRemove={(entry) => void remove(entry)}
                rule={rule}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
