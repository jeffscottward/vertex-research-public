"use client";

import {
  SIGNAL_ALERT_FREQUENCIES,
  SIGNAL_ALERT_TIMEFRAMES,
  type SignalAlertBackfillOutput,
  type SignalAlertCondition,
  type SignalAlertEvent,
  type SignalAlertFrequency,
  type SignalAlertListOutput,
  type SignalAlertProposeOutput,
  type SignalAlertRule,
  type SignalAlertTimeframe,
} from "@darkfactory/api";
import { Badge, Button, Input } from "@darkfactory/ui";
import { Bell, Eye, Play, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { describePriceAlertFailure } from "./price-alerts-client.ts";
import {
  createBrowserSignalAlertsGateway,
  describeBackfill,
  type SignalAlertsGateway,
} from "./signal-alerts-client.ts";

// Signal alerts and watch mode (LuxAlgo P4). A signal alert compares two lines on one symbol's bars
// (a strategy preset or a custom crossing), with LuxAlgo's frequencies and a backfill count. Watch
// mode: Quant turns a plain-language request into a proposed watch card; it runs only after Start
// watching, as a scheduled server job. Fires appear under Recent fires and, once allowed, as
// browser/OS notifications while a Vertex tab is open. Research only; no orders.

export interface SignalAlertsSectionProps {
  readonly gateway?: SignalAlertsGateway;
  /** Browser notification surface; injectable for tests. */
  readonly notifier?: BrowserNotifier;
  /** Event polling interval in milliseconds (0 disables polling). */
  readonly pollMs?: number;
}

export type BrowserNotifier = Readonly<{
  permission: () => NotificationPermission | "unsupported";
  request: () => Promise<NotificationPermission | "unsupported">;
  show: (title: string, body: string) => void;
}>;

export const browserNotifier: BrowserNotifier = {
  permission: () =>
    typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission,
  request: async () =>
    typeof Notification === "undefined"
      ? "unsupported"
      : await Notification.requestPermission(),
  show: (title, body) => {
    if (typeof Notification === "undefined") return;
    const notification = new Notification(title, { body });
    notification.onclick = () => window.focus();
  },
};

const PRESETS = [
  "sma-cross",
  "breakout",
  "breakdown",
  "opening-range",
  "price-level",
] as const;
type Preset = (typeof PRESETS)[number];

const PRESET_LABELS: Readonly<Record<Preset, string>> = {
  breakdown: "Strategy: breakdown (close below N-bar low)",
  breakout: "Strategy: breakout (close above N-bar high)",
  "opening-range": "Strategy: opening range breakout",
  "price-level": "Custom: price crosses a value",
  "sma-cross": "Strategy: SMA cross (fast crosses slow)",
};

const FREQUENCY_LABELS: Readonly<Record<SignalAlertFrequency, string>> = {
  once: "Only once",
  "per-bar": "Once per bar",
  "per-bar-close": "Once per bar close",
};

const DIRECTIONS = ["crosses-above", "crosses-below", "crosses"] as const;
type Direction = (typeof DIRECTIONS)[number];
const DIRECTION_LABELS: Readonly<Record<Direction, string>> = {
  crosses: "Crossing (either way)",
  "crosses-above": "Crossing up",
  "crosses-below": "Crossing down",
};

const selectClass =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm";

export type SignalAlertForm = Readonly<{
  preset: Preset;
  direction: Direction;
  period: string;
  slowPeriod: string;
  value: string;
}>;

const intOr = (text: string, fallback: number): number => {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : fallback;
};

/** The condition a preset form stands for. */
export const conditionOfForm = (
  form: SignalAlertForm
): SignalAlertCondition => {
  const close = { field: "close", type: "price" } as const;
  switch (form.preset) {
    case "sma-cross":
      return {
        left: { period: intOr(form.period, 20), type: "sma" },
        operator: form.direction,
        right: { period: intOr(form.slowPeriod, 50), type: "sma" },
      };
    case "breakout":
      return {
        left: close,
        operator: "crosses-above",
        right: { period: intOr(form.period, 20), type: "highest" },
      };
    case "breakdown":
      return {
        left: close,
        operator: "crosses-below",
        right: { period: intOr(form.period, 20), type: "lowest" },
      };
    case "opening-range":
      return {
        left: close,
        operator:
          form.direction === "crosses-below"
            ? "crosses-below"
            : "crosses-above",
        right: {
          minutes: intOr(form.period, 30),
          side: form.direction === "crosses-below" ? "low" : "high",
          type: "opening-range",
        },
      };
    default:
      return {
        left: close,
        operator: form.direction,
        right: { type: "value", value: form.value.trim() || "0" },
      };
  }
};

const utc = (date: Date): string =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const STATUS_LABELS: Readonly<Record<SignalAlertRule["status"], string>> = {
  active: "Watching",
  dismissed: "Stopped",
  done: "Fired (once)",
  proposed: "Proposed",
};

type Proposal = Extract<SignalAlertProposeOutput, { ok: true }>;

export function SignalAlertsSection({
  gateway: injected,
  notifier = browserNotifier,
  pollMs = 60_000,
}: SignalAlertsSectionProps) {
  const [gateway] = useState(
    () => injected ?? createBrowserSignalAlertsGateway()
  );
  const ids = useId();
  const [data, setData] = useState<SignalAlertListOutput>({
    notifications: "not-configured",
    rules: [],
  });
  const [events, setEvents] = useState<SignalAlertEvent[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [symbol, setSymbol] = useState("SPY");
  const [timeframe, setTimeframe] = useState<SignalAlertTimeframe>("15m");
  const [frequency, setFrequency] =
    useState<SignalAlertFrequency>("per-bar-close");
  const [form, setForm] = useState<SignalAlertForm>({
    direction: "crosses-above",
    period: "20",
    preset: "sma-cross",
    slowPeriod: "50",
    value: "",
  });
  const [backfill, setBackfill] = useState<SignalAlertBackfillOutput | null>(
    null
  );
  const [permission, setPermission] = useState(() => notifier.permission());
  const seenRef = useRef<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, recent] = await Promise.all([
        gateway.list(),
        gateway.events(null),
      ]);
      setData(list);
      setEvents(recent);
      seenRef.current = recent[0]?.firedAt ?? new Date();
    } catch (error) {
      setFeedback(describePriceAlertFailure(error));
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  // New fires since the last poll become in-app rows and, when allowed, browser/OS notifications.
  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await gateway.events(seenRef.current);
          const [newest] = fresh;
          if (newest === undefined) return;
          seenRef.current = newest.firedAt;
          setEvents((current) => [...fresh, ...current].slice(0, 50));
          if (notifier.permission() === "granted")
            for (const event of fresh)
              notifier.show(
                event.kind === "watch"
                  ? "Vertex watch fired"
                  : "Vertex signal alert",
                `${event.name} at ${event.price}. Research only, not an instruction to trade.`
              );
        } catch {
          // Polling is best effort; the next interval retries.
        }
      })();
    }, pollMs);
    return () => clearInterval(timer);
  }, [gateway, notifier, pollMs]);

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

  const withRule = (rule: SignalAlertRule) =>
    setData((current) => ({
      ...current,
      rules: [rule, ...current.rules.filter((entry) => entry.id !== rule.id)],
    }));

  const draft = () => ({
    condition: conditionOfForm(form),
    symbol: symbol.trim().toUpperCase(),
    timeframe,
  });

  const propose = () =>
    run(async () => {
      const result = await gateway.propose(request);
      if (!result.ok)
        return `Quant could not turn that into a watch: ${result.reason}`;
      setProposal(result);
      withRule(result.rule);
      return "Quant suggests a watch.";
    });

  const startWatch = (id: string) =>
    run(async () => {
      const rule = await gateway.start(id);
      withRule(rule);
      setProposal(null);
      return `Watching ${rule.symbol}.`;
    });

  const dismiss = (id: string) =>
    run(async () => {
      const rule = await gateway.dismiss(id);
      withRule(rule);
      if (proposal?.rule.id === id) setProposal(null);
      return `${rule.kind === "watch" ? "Watch" : "Alert"} stopped.`;
    });

  const remove = (rule: SignalAlertRule) =>
    run(async () => {
      await gateway.remove(rule.id);
      setData((current) => ({
        ...current,
        rules: current.rules.filter((entry) => entry.id !== rule.id),
      }));
      return "Removed.";
    });

  const previewBackfill = () =>
    run(async () => {
      const result = await gateway.backfill(draft());
      setBackfill(result);
      return describeBackfill(result.backfill);
    });

  const create = () =>
    run(async () => {
      const rule = await gateway.create({
        ...draft(),
        frequency,
        origin: form.preset === "price-level" ? "manual" : "strategy",
      });
      withRule(rule);
      return `Alert created: ${rule.name}.`;
    });

  const check = () =>
    run(async () => {
      const result = await gateway.check();
      if (result.events.length > 0)
        setEvents((current) => [...result.events, ...current].slice(0, 50));
      setData(await gateway.list());
      const errors =
        result.seriesErrors.length === 0
          ? ""
          : ` ${result.seriesErrors.length} series unavailable.`;
      return `Checked ${result.checked}; ${result.events.length} fired.${errors}`;
    });

  const enableNotifications = () =>
    run(async () => {
      const next = await notifier.request();
      setPermission(next);
      return next === "granted"
        ? "Browser notifications on while a Vertex tab is open."
        : "Browser notifications are not allowed.";
    });

  const needsPeriod = form.preset !== "price-level";
  const needsDirection =
    form.preset === "sma-cross" ||
    form.preset === "price-level" ||
    form.preset === "opening-range";

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-semibold text-lg" id={`${ids}-title`}>
          Signal alerts and watch mode
        </h2>
        <p className="text-muted-foreground text-sm">
          Strategy and signal alerts evaluate on bar data in a scheduled server
          job; no model runs in the check loop. Phone push:{" "}
          {data.notifications === "configured" ? "on" : "not configured"}.
          Browser notifications:{" "}
          {permission === "granted"
            ? "on"
            : permission === "unsupported"
              ? "unsupported here"
              : "off"}
          .{" "}
          {permission === "default" || permission === "denied" ? (
            <Button
              disabled={busy || permission === "denied"}
              onClick={enableNotifications}
              size="sm"
              variant="outline"
            >
              <Bell aria-hidden="true" className="size-4" /> Enable browser
              notifications
            </Button>
          ) : null}
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-border p-4">
        <h3 className="font-semibold" id={`${ids}-watch`}>
          Watch mode
        </h3>
        <label className="text-sm" htmlFor={`${ids}-request`}>
          Ask Quant to watch
        </label>
        <Input
          className="min-h-11"
          id={`${ids}-request`}
          maxLength={500}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="Watch NQ and wake me when a 15m bar closes above the opening range"
          value={request}
        />
        <Button disabled={busy || request.trim().length < 3} onClick={propose}>
          <Eye aria-hidden="true" className="size-4" /> Suggest a watch
        </Button>
        {proposal === null ? null : (
          <div
            aria-label="Quant suggests a watch"
            className="space-y-2 rounded-md border border-primary/40 bg-muted/30 p-3"
            role="group"
          >
            <p className="font-medium text-sm">Quant suggests a watch</p>
            <p className="text-sm">{proposal.summary}</p>
            <p className="text-muted-foreground text-xs">
              {proposal.backfill === null
                ? "Backfill unavailable (market data)."
                : describeBackfill(proposal.backfill)}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() => startWatch(proposal.rule.id)}
                size="sm"
              >
                <Play aria-hidden="true" className="size-4" /> Start watching
              </Button>
              <Button
                disabled={busy}
                onClick={() => dismiss(proposal.rule.id)}
                size="sm"
                variant="outline"
              >
                <X aria-hidden="true" className="size-4" /> Dismiss
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-border p-4">
        <h3 className="font-semibold">New signal alert</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <label className="text-sm" htmlFor={`${ids}-symbol`}>
              Symbol
            </label>
            <Input
              className="min-h-11"
              id={`${ids}-symbol`}
              maxLength={12}
              onChange={(event) => setSymbol(event.target.value)}
              value={symbol}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm" htmlFor={`${ids}-timeframe`}>
              Timeframe
            </label>
            <select
              className={selectClass}
              id={`${ids}-timeframe`}
              onChange={(event) =>
                setTimeframe(event.target.value as SignalAlertTimeframe)
              }
              value={timeframe}
            >
              {SIGNAL_ALERT_TIMEFRAMES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="text-sm" htmlFor={`${ids}-preset`}>
              Alert on
            </label>
            <select
              className={selectClass}
              id={`${ids}-preset`}
              onChange={(event) =>
                setForm({ ...form, preset: event.target.value as Preset })
              }
              value={form.preset}
            >
              {PRESETS.map((entry) => (
                <option key={entry} value={entry}>
                  {PRESET_LABELS[entry]}
                </option>
              ))}
            </select>
          </div>
          {needsDirection ? (
            <div className="space-y-1">
              <label className="text-sm" htmlFor={`${ids}-direction`}>
                Condition
              </label>
              <select
                className={selectClass}
                id={`${ids}-direction`}
                onChange={(event) =>
                  setForm({
                    ...form,
                    direction: event.target.value as Direction,
                  })
                }
                value={form.direction}
              >
                {DIRECTIONS.map((entry) => (
                  <option key={entry} value={entry}>
                    {DIRECTION_LABELS[entry]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {needsPeriod ? (
            <div className="space-y-1">
              <label className="text-sm" htmlFor={`${ids}-period`}>
                {form.preset === "sma-cross"
                  ? "Fast SMA"
                  : form.preset === "opening-range"
                    ? "Range minutes"
                    : "Bars"}
              </label>
              <Input
                className="min-h-11"
                id={`${ids}-period`}
                inputMode="numeric"
                onChange={(event) =>
                  setForm({ ...form, period: event.target.value })
                }
                value={form.period}
              />
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-sm" htmlFor={`${ids}-value`}>
                Value
              </label>
              <Input
                className="min-h-11"
                id={`${ids}-value`}
                inputMode="decimal"
                onChange={(event) =>
                  setForm({ ...form, value: event.target.value })
                }
                value={form.value}
              />
            </div>
          )}
          {form.preset === "sma-cross" ? (
            <div className="space-y-1">
              <label className="text-sm" htmlFor={`${ids}-slow`}>
                Slow SMA
              </label>
              <Input
                className="min-h-11"
                id={`${ids}-slow`}
                inputMode="numeric"
                onChange={(event) =>
                  setForm({ ...form, slowPeriod: event.target.value })
                }
                value={form.slowPeriod}
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <label className="text-sm" htmlFor={`${ids}-frequency`}>
              Frequency
            </label>
            <select
              className={selectClass}
              id={`${ids}-frequency`}
              onChange={(event) =>
                setFrequency(event.target.value as SignalAlertFrequency)
              }
              value={frequency}
            >
              {SIGNAL_ALERT_FREQUENCIES.map((entry) => (
                <option key={entry} value={entry}>
                  {FREQUENCY_LABELS[entry]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Send to: in-app, browser and phone push.
        </p>
        {backfill === null ? null : (
          <p className="text-sm">
            {backfill.description}: {describeBackfill(backfill.backfill)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={previewBackfill} variant="outline">
            Preview backfill
          </Button>
          <Button disabled={busy} onClick={create}>
            Create alert
          </Button>
        </div>
      </div>

      {feedback === null ? null : (
        <p aria-live="polite" className="text-sm" role="status">
          {feedback}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Signal alerts and watches</h3>
          <Button disabled={busy} onClick={check} size="sm" variant="outline">
            <RefreshCw aria-hidden="true" className="size-4" /> Check now
          </Button>
        </div>
        {data.rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.rules.map((rule) => (
              <li
                className="flex flex-wrap items-center gap-2 p-3 text-sm"
                key={rule.id}
              >
                <Badge variant="outline">
                  {rule.kind === "watch" ? "Watch" : "Alert"}
                </Badge>
                <span className="font-medium">{rule.symbol}</span>
                <span>{rule.timeframe}</span>
                <span className="text-muted-foreground">
                  {rule.description}
                </span>
                <span className="text-muted-foreground">
                  {FREQUENCY_LABELS[rule.frequency]}
                </span>
                <Badge>{STATUS_LABELS[rule.status]}</Badge>
                <span className="text-muted-foreground">
                  fired {rule.fireCount}
                  {rule.lastFiredAt === null
                    ? ""
                    : `, last ${utc(rule.lastFiredAt)}`}
                </span>
                <span className="ml-auto flex gap-1">
                  {rule.status === "proposed" ? (
                    <Button
                      disabled={busy}
                      onClick={() => startWatch(rule.id)}
                      size="sm"
                    >
                      Start watching
                    </Button>
                  ) : null}
                  {rule.status === "proposed" || rule.status === "active" ? (
                    <Button
                      disabled={busy}
                      onClick={() => dismiss(rule.id)}
                      size="sm"
                      variant="outline"
                    >
                      {rule.status === "proposed" ? "Dismiss" : "Stop"}
                    </Button>
                  ) : null}
                  <Button
                    aria-label={`Remove ${rule.name}`}
                    disabled={busy}
                    onClick={() => remove(rule)}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="font-semibold">Recent fires</h3>
        {events.length === 0 ? (
          <p className="text-muted-foreground text-sm">No fires yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {events.map((event) => (
              <li key={event.id}>
                {utc(event.firedAt)}: {event.name} at {event.price} (bar{" "}
                {utc(event.barAt)})
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
