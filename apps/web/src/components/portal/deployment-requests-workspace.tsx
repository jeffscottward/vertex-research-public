"use client";

import {
  DEPLOYMENT_REQUEST_STATUS_VALUES,
  type DeploymentRequestOutput,
  type DeploymentRequestStatusValue,
  type StrategyGetOutput,
  type StrategySummaryOutput,
} from "@darkfactory/api";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from "@darkfactory/ui";
import { Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  OperatorAccessRequired,
  createBrowserDeploymentRequestsGateway,
  createBrowserStrategyLibraryGateway,
  describeAgentOpsFailure,
  formatTimestamp,
  isOperatorAccessDenied,
  type DeploymentRequestsGateway,
  type StrategyLibraryGateway,
} from "./agent-ops-client.tsx";
import {
  EMPTY_LIMITS_FORM,
  LIMIT_FIELDS,
  NOT_DISPATCHED_LABEL,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONE,
  TIMEFRAME_OPTIONS,
  TONE_CLASS,
  formatParams,
  limitsFromForm,
  limitsToForm,
  requestActions,
  slugConfirmed,
  type LimitsForm,
} from "./deployment-requests-model.ts";
import {
  presetFormValues,
  presetValuesFromForm,
  type PresetFormValues,
} from "./strategy-library-model.ts";
import { ParamField, selectClass } from "./strategy-param-field.tsx";

// Paper deployment requests: records only. Approve records a decision; nothing is dispatched to the
// Quant VPS or a broker, and the dispatch chip below is always shown.

export interface DeploymentRequestsWorkspaceProps {
  readonly gateway?: DeploymentRequestsGateway;
  readonly strategies?: StrategyLibraryGateway;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; rows: DeploymentRequestOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

// What the panel above the list shows.
export type RequestPanel =
  | Readonly<{ type: "none" }>
  | Readonly<{ type: "new"; strategyId: string }>
  | Readonly<{ type: "edit"; request: DeploymentRequestOutput }>
  | Readonly<{ type: "detail"; id: string }>;

type Message = Readonly<{ text: string; tone: "status" | "alert" }>;
const NO_MESSAGE: Message = { text: "", tone: "status" };

const cell = "px-2 py-1.5 align-top";
const filterSelectClass =
  "h-11 w-auto min-w-36 rounded-sm border border-border-strong bg-surface px-2 text-sm";

const describeRequestFailure = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    const message = Reflect.get(error, "message");
    if (code === "CONFLICT" && typeof message === "string" && message !== "")
      return message;
    if (code === "STORAGE_ERROR") {
      return "Deployment request storage unavailable (503). Apply migration 0021 if the table is missing.";
    }
  }
  return describeAgentOpsFailure(error);
};

export const readRequestPanel = (search: string): RequestPanel => {
  const params = new URLSearchParams(search);
  const request = params.get("request");
  if (request !== null && request !== "")
    return { type: "detail", id: request };
  const fresh = params.get("new");
  if (fresh !== null)
    return { type: "new", strategyId: fresh === "1" ? "" : fresh };
  return { type: "none" };
};

// Keeps ?request= or ?new= in the address bar so a request can be linked and restored.
const writeRequestPanel = (panel: RequestPanel): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("request");
  url.searchParams.delete("new");
  if (panel.type === "detail") {
    url.searchParams.set("request", panel.id);
  } else if (panel.type === "edit") {
    url.searchParams.set("request", panel.request.id);
  } else if (panel.type === "new")
    url.searchParams.set(
      "new",
      panel.strategyId === "" ? "1" : panel.strategyId
    );
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

const RequestStatusChip = ({
  status,
}: {
  readonly status: DeploymentRequestStatusValue;
}) => {
  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 font-medium text-xs ${TONE_CLASS[REQUEST_STATUS_TONE[status]]}`}
      data-request-status={status}
    >
      {REQUEST_STATUS_LABELS[status]}
    </span>
  );
};

const NotDispatchedChip = () => {
  return (
    <span
      className={`inline-flex min-h-8 items-center rounded-full border-2 px-3 font-semibold text-sm ${TONE_CLASS.warning}`}
      data-dispatch-chip="not-dispatched"
      role="status"
    >
      {NOT_DISPATCHED_LABEL}
    </span>
  );
};

const Feedback = ({ message }: { readonly message: Message }) => {
  if (message.text === "")
    return <div aria-live="polite" className="min-h-5 text-sm" role="status" />;
  return (
    <p
      className={`min-h-5 text-sm ${message.tone === "alert" ? "text-destructive" : ""}`}
      role={message.tone}
    >
      {message.text}
    </p>
  );
};

const RequestForm = ({
  gateway,
  strategies,
  options,
  panel,
  onSaved,
  onCancel,
}: {
  readonly gateway: DeploymentRequestsGateway;
  readonly strategies: StrategyLibraryGateway;
  readonly options: readonly StrategySummaryOutput[];
  readonly panel:
    | Readonly<{ type: "new"; strategyId: string }>
    | Readonly<{ type: "edit"; request: DeploymentRequestOutput }>;
  readonly onSaved: (request: DeploymentRequestOutput) => Promise<void>;
  readonly onCancel: () => void;
}) => {
  const editing = panel.type === "edit" ? panel.request : null;
  const [strategyId, setStrategyId] = useState(
    editing === null
      ? panel.type === "new"
        ? panel.strategyId
        : ""
      : editing.strategyId
  );
  const [strategy, setStrategy] = useState<StrategyGetOutput | null>(null);
  const [presetId, setPresetId] = useState(editing?.presetId ?? "");
  const [paramsForm, setParamsForm] = useState<PresetFormValues>({});
  const [symbol, setSymbol] = useState(editing?.symbol ?? "");
  const [timeframe, setTimeframe] = useState(editing?.timeframe ?? "5m");
  const [limits, setLimits] = useState<LimitsForm>(
    editing === null ? EMPTY_LIMITS_FORM : limitsToForm(editing.limits)
  );
  const [message, setMessage] = useState<Message>(NO_MESSAGE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (strategyId === "") {
      setStrategy(null);
      setParamsForm({});
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const detail = await strategies.get(strategyId);
        if (!active) return;
        setStrategy(detail);
        const seed =
          editing !== null && editing.strategyId === detail.strategy.id
            ? editing.params
            : {};
        return setParamsForm(presetFormValues(detail.strategy.params, seed));
      } catch (error) {
        if (active)
          return setMessage({
            text: describeRequestFailure(error),
            tone: "alert",
          });
        return;
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [strategies, strategyId, editing]);

  const choosePreset = (value: string): void => {
    setPresetId(value);
    if (strategy === null) return;
    const preset = strategy.presets.find((entry) => entry.id === value);
    setParamsForm(
      presetFormValues(strategy.strategy.params, preset?.values ?? {})
    );
  };

  const save = async (): Promise<void> => {
    if (strategy === null) {
      setMessage({ text: "Choose a strategy.", tone: "alert" });
      return;
    }
    const params = presetValuesFromForm(strategy.strategy.params, paramsForm);
    if (typeof params === "string") {
      setMessage({ text: params, tone: "alert" });
      return;
    }
    const parsedLimits = limitsFromForm(limits);
    if (typeof parsedLimits === "string") {
      setMessage({ text: parsedLimits, tone: "alert" });
      return;
    }
    if (symbol.trim() === "") {
      setMessage({ text: "Symbol is required.", tone: "alert" });
      return;
    }
    setBusy(true);
    setMessage(NO_MESSAGE);
    try {
      const fields = {
        presetId: presetId === "" ? null : presetId,
        params,
        symbol: symbol.trim(),
        timeframe,
        limits: parsedLimits,
      };
      const saved =
        editing === null
          ? await gateway.create({
              strategyId: strategy.strategy.id,
              ...fields,
            })
          : await gateway.update({ id: editing.id, ...fields });
      await onSaved(saved);
    } catch (error) {
      setMessage({ text: describeRequestFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  const heading = editing === null ? "New request" : "Edit draft";
  return (
    <section
      aria-labelledby="request-form-heading"
      className="space-y-4 rounded-md border border-border p-4"
      data-request-form={editing === null ? "new" : editing.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-base" id="request-form-heading">
          {heading}
        </h2>
        <Button onClick={onCancel} type="button" variant="secondary">
          Cancel
        </Button>
      </div>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          return void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs" htmlFor="request-strategy">
            Strategy
            <select
              className={selectClass}
              disabled={editing !== null}
              id="request-strategy"
              onChange={(event) => {
                setStrategyId(event.target.value);
                return setPresetId("");
              }}
              value={strategyId}
            >
              <option value="">Choose…</option>
              {options.map((option) => {
                return (
                  <option key={option.id} value={option.id}>
                    {option.name} ({option.slug})
                  </option>
                );
              })}
            </select>
          </label>
          <label className="text-xs" htmlFor="request-preset">
            Preset
            <select
              className={selectClass}
              disabled={strategy === null}
              id="request-preset"
              onChange={(event) => choosePreset(event.target.value)}
              value={presetId}
            >
              <option value="">None (defaults)</option>
              {(strategy?.presets ?? []).map((preset) => {
                return (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="text-xs" htmlFor="request-symbol">
            Symbol
            <Input
              autoCapitalize="characters"
              id="request-symbol"
              maxLength={32}
              onChange={(event) => setSymbol(event.target.value)}
              value={symbol}
            />
          </label>
          <label className="text-xs" htmlFor="request-timeframe">
            Timeframe
            <select
              className={selectClass}
              id="request-timeframe"
              onChange={(event) => setTimeframe(event.target.value)}
              value={timeframe}
            >
              {TIMEFRAME_OPTIONS.map((option) => {
                return (
                  <option key={option} value={option}>
                    {option}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">Parameters</legend>
          {strategy === null ? (
            <p className="text-muted-foreground text-xs">—</p>
          ) : strategy.strategy.params.length === 0 ? (
            <p
              className="text-muted-foreground text-xs"
              data-request-params="none"
            >
              No parameters.
            </p>
          ) : (
            <div
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              data-request-params=""
            >
              {strategy.strategy.params.map((param) => {
                return (
                  <ParamField
                    idPrefix="request-param"
                    key={param.name}
                    onChange={(value) =>
                      setParamsForm((current) => ({
                        ...current,
                        [param.name]: value,
                      }))
                    }
                    param={param}
                    value={paramsForm[param.name]}
                  />
                );
              })}
            </div>
          )}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">Limits</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {LIMIT_FIELDS.map((field) => {
              return (
                <label
                  className="text-xs"
                  htmlFor={`request-limit-${field.key}`}
                  key={field.key}
                >
                  {field.label}
                  <Input
                    id={`request-limit-${field.key}`}
                    inputMode={field.integer ? "numeric" : "decimal"}
                    min={field.integer ? 1 : 0}
                    onChange={(event) =>
                      setLimits((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    step={field.integer ? 1 : "any"}
                    type="number"
                    value={limits[field.key]}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
        <Feedback message={message} />
        <Button disabled={busy || strategy === null} type="submit">
          {editing === null ? "Save draft" : "Save changes"}
        </Button>
      </form>
    </section>
  );
};

const DetailRow = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words font-mono text-sm [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
};

const RequestDetail = ({
  request,
  gateway,
  onChanged,
  onEdit,
  onClose,
}: {
  readonly request: DeploymentRequestOutput;
  readonly gateway: DeploymentRequestsGateway;
  readonly onChanged: (request: DeploymentRequestOutput) => Promise<void>;
  readonly onEdit: () => void;
  readonly onClose: () => void;
}) => {
  const actions = requestActions(request.status);
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(NO_MESSAGE);

  const run = async (
    operation: () => Promise<DeploymentRequestOutput>,
    done: string
  ): Promise<void> => {
    setBusy(true);
    setMessage(NO_MESSAGE);
    try {
      const next = await operation();
      setConfirm("");
      setNote("");
      setMessage({ text: done, tone: "status" });
      await onChanged(next);
    } catch (error) {
      setMessage({ text: describeRequestFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  const trimmedNote = note.trim();
  return (
    <section
      aria-labelledby="request-detail-heading"
      className="space-y-4 rounded-md border border-border p-4"
      data-request-detail={request.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-2">
          <h2
            className="break-words font-medium text-base"
            id="request-detail-heading"
          >
            {request.strategyName}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-muted-foreground text-xs">
              {request.strategySlug}
            </span>
            <RequestStatusChip status={request.status} />
            {request.dispatch.state === "not-dispatched" ? (
              <span
                className={`inline-flex min-h-7 items-center rounded-full border px-2.5 font-medium text-xs ${TONE_CLASS.warning}`}
                data-request-dispatch={request.dispatch.state}
              >
                {NOT_DISPATCHED_LABEL}
              </span>
            ) : null}
          </div>
        </div>
        <Button onClick={onClose} type="button" variant="secondary">
          Close
        </Button>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailRow label="Symbol">{request.symbol}</DetailRow>
        <DetailRow label="Timeframe">{request.timeframe}</DetailRow>
        <DetailRow label="Mode">Paper</DetailRow>
        <DetailRow label="Preset">{request.presetName ?? "—"}</DetailRow>
        <div className="min-w-0 sm:col-span-2 lg:col-span-4">
          <dt className="text-muted-foreground text-xs">Parameters</dt>
          <dd
            className="break-words font-mono text-sm [overflow-wrap:anywhere]"
            data-request-detail-params=""
          >
            {formatParams(request.params)}
          </dd>
        </div>
        {LIMIT_FIELDS.map((field) => {
          return (
            <DetailRow key={field.key} label={field.label}>
              {request.limits[field.key]}
            </DetailRow>
          );
        })}
        <DetailRow label="Requested by">{request.requestedBy}</DetailRow>
        <DetailRow label="Requested (UTC)">
          {formatTimestamp(request.requestedAt)}
        </DetailRow>
        <DetailRow label="Decided by">{request.decidedBy ?? "—"}</DetailRow>
        <DetailRow label="Decided (UTC)">
          {formatTimestamp(request.decidedAt)}
        </DetailRow>
        {request.decisionNote === null ? null : (
          <div className="min-w-0 sm:col-span-2 lg:col-span-4">
            <dt className="text-muted-foreground text-xs">Note</dt>
            <dd className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
              {request.decisionNote}
            </dd>
          </div>
        )}
      </dl>
      {actions.approve || actions.reject ? (
        <div className="grid gap-3 sm:grid-cols-2" data-request-review="">
          <label className="text-xs" htmlFor="request-confirm-slug">
            Type <span className="font-mono">{request.strategySlug}</span> to
            approve
            <Input
              autoComplete="off"
              id="request-confirm-slug"
              onChange={(event) => setConfirm(event.target.value)}
              spellCheck={false}
              value={confirm}
            />
          </label>
          <label className="text-xs" htmlFor="request-note">
            Note
            <Textarea
              id="request-note"
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              value={note}
            />
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2" data-request-actions="">
        {actions.edit ? (
          <Button
            disabled={busy}
            onClick={onEdit}
            type="button"
            variant="secondary"
          >
            Edit
          </Button>
        ) : null}
        {actions.submit ? (
          <Button
            data-request-action="submit"
            disabled={busy}
            onClick={() =>
              void run(() => gateway.submit(request.id), "Submitted.")
            }
            type="button"
          >
            Submit
          </Button>
        ) : null}
        {actions.approve ? (
          <Button
            data-request-action="approve"
            disabled={busy || !slugConfirmed(request, confirm)}
            onClick={() =>
              void run(
                () =>
                  gateway.approve(
                    request.id,
                    confirm.trim(),
                    trimmedNote === "" ? undefined : trimmedNote
                  ),
                "Approved."
              )
            }
            type="button"
          >
            Approve
          </Button>
        ) : null}
        {actions.reject ? (
          <Button
            data-request-action="reject"
            disabled={busy || trimmedNote === ""}
            onClick={() =>
              void run(
                () => gateway.reject(request.id, trimmedNote),
                "Rejected."
              )
            }
            type="button"
            variant="destructive"
          >
            Reject
          </Button>
        ) : null}
        {actions.withdraw ? (
          <Button
            data-request-action="withdraw"
            disabled={busy}
            onClick={() =>
              void run(() => gateway.withdraw(request.id), "Withdrawn.")
            }
            type="button"
            variant="secondary"
          >
            Withdraw
          </Button>
        ) : null}
      </div>
      <Feedback message={message} />
    </section>
  );
};

export const DeploymentRequestsWorkspace = ({
  gateway: suppliedGateway,
  strategies: suppliedStrategies,
}: DeploymentRequestsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserDeploymentRequestsGateway()
  );
  const [strategies] = useState(
    () => suppliedStrategies ?? createBrowserStrategyLibraryGateway()
  );
  const [list, setList] = useState<ListState>({ type: "loading" });
  const [statusFilter, setStatusFilter] = useState<
    DeploymentRequestStatusValue | ""
  >("");
  const [panel, setPanelState] = useState<RequestPanel>(() =>
    typeof window === "undefined"
      ? { type: "none" }
      : readRequestPanel(window.location.search)
  );
  const [detail, setDetail] = useState<DeploymentRequestOutput | null>(null);
  const [detailError, setDetailError] = useState("");
  const [options, setOptions] = useState<StrategySummaryOutput[]>([]);

  const setPanel = useCallback((next: RequestPanel) => {
    setPanelState(next);
    return writeRequestPanel(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const rows = await gateway.list(
        statusFilter === "" ? {} : { status: statusFilter }
      );
      return setList({ type: "ready", rows });
    } catch (error) {
      return setList(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { type: "error", message: describeRequestFailure(error) }
      );
    }
  }, [gateway, statusFilter]);

  useEffect(() => {
    return void load();
  }, [load]);

  const detailId = panel.type === "detail" ? panel.id : null;
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    let active = true;
    const read = async () => {
      setDetailError("");
      try {
        const request = await gateway.get(detailId);
        if (active) return setDetail(request);
        return;
      } catch (error) {
        if (active) {
          setDetail(null);
          return setDetailError(describeRequestFailure(error));
        }
        return;
      }
    };
    void read();
    return () => {
      active = false;
    };
  }, [gateway, detailId]);

  const formOpen = panel.type === "new" || panel.type === "edit";
  useEffect(() => {
    if (!formOpen || options.length > 0) return;
    let active = true;
    const read = async () => {
      try {
        const rows = await strategies.list({ sort: "name" });
        if (active) return setOptions(rows);
        return;
      } catch {
        if (active) return setOptions([]);
        return;
      }
    };
    void read();
    return () => {
      active = false;
    };
  }, [strategies, formOpen, options.length]);

  const saved = useCallback(
    async (request: DeploymentRequestOutput) => {
      setDetail(request);
      setPanel({ type: "detail", id: request.id });
      return await load();
    },
    [load, setPanel]
  );

  const changed = useCallback(
    async (request: DeploymentRequestOutput) => {
      setDetail(request);
      return await load();
    },
    [load]
  );

  if (list.type === "forbidden")
    return <OperatorAccessRequired feature="deployment-requests" />;

  return (
    <div className="space-y-4" data-deployment-requests="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <NotDispatchedChip />
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Status filter"
            className={filterSelectClass}
            onChange={(event) =>
              setStatusFilter(
                event.target.value as DeploymentRequestStatusValue | ""
              )
            }
            value={statusFilter}
          >
            <option value="">All statuses</option>
            {DEPLOYMENT_REQUEST_STATUS_VALUES.map((status) => {
              return (
                <option key={status} value={status}>
                  {REQUEST_STATUS_LABELS[status]}
                </option>
              );
            })}
          </select>
          <Button onClick={() => void load()} type="button" variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Reload
          </Button>
          <Button
            data-request-new=""
            onClick={() => setPanel({ type: "new", strategyId: "" })}
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
            New request
          </Button>
        </div>
      </div>
      {panel.type === "new" || panel.type === "edit" ? (
        <RequestForm
          gateway={gateway}
          key={
            panel.type === "edit" ? panel.request.id : `new-${panel.strategyId}`
          }
          onCancel={() => setPanel({ type: "none" })}
          onSaved={saved}
          options={options}
          panel={panel}
          strategies={strategies}
        />
      ) : null}
      {panel.type === "detail" ? (
        detail !== null && detail.id === panel.id ? (
          <RequestDetail
            gateway={gateway}
            key={`${detail.id}-${detail.status}`}
            onChanged={changed}
            onClose={() => setPanel({ type: "none" })}
            onEdit={() => setPanel({ type: "edit", request: detail })}
            request={detail}
          />
        ) : detailError === "" ? (
          <p aria-busy="true" className="text-muted-foreground text-sm">
            Loading request…
          </p>
        ) : (
          <p className="text-destructive text-sm" role="alert">
            {detailError}
          </p>
        )
      ) : null}
      {list.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading requests…
        </p>
      ) : list.type === "error" ? (
        <p
          className="text-destructive text-sm"
          data-requests-error=""
          role="alert"
        >
          {list.message}
        </p>
      ) : list.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-requests-empty="">
          No requests.
        </p>
      ) : (
        <div
          aria-label="Deployment requests"
          className="relative overflow-x-auto"
          role="region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
          tabIndex={0}
        >
          <Table
            containerClassName="overflow-visible"
            className="w-full min-w-[40rem] text-sm"
            data-click-private=""
            data-requests-table=""
          >
            <TableCaption className="sr-only">
              Paper deployment requests
            </TableCaption>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
                <TableHead
                  className={cn("text-muted-foreground", cell)}
                  scope="col"
                >
                  Strategy
                </TableHead>
                <TableHead
                  className={cn("text-muted-foreground", cell)}
                  scope="col"
                >
                  Symbol
                </TableHead>
                <TableHead
                  className={cn("text-muted-foreground", cell)}
                  scope="col"
                >
                  Timeframe
                </TableHead>
                <TableHead
                  className={cn("text-muted-foreground", cell)}
                  scope="col"
                >
                  Status
                </TableHead>
                <TableHead
                  className={cn("text-muted-foreground", cell)}
                  scope="col"
                >
                  Updated (UTC)
                </TableHead>
                <TableHead
                  className={cn("text-muted-foreground", cell)}
                  scope="col"
                >
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((row) => {
                return (
                  <TableRow
                    className={`border-border border-b ${panel.type === "detail" && panel.id === row.id ? "bg-muted hover:bg-muted" : ""}`}
                    data-request-row={row.id}
                    key={row.id}
                  >
                    <TableHead
                      className={`h-auto whitespace-normal ${cell} font-normal`}
                      scope="row"
                    >
                      {row.strategyName}
                      <span className="block font-mono text-muted-foreground text-xs">
                        {row.strategySlug}
                      </span>
                    </TableHead>
                    <TableCell
                      className={`whitespace-normal ${cell} font-mono`}
                    >
                      {row.symbol}
                    </TableCell>
                    <TableCell
                      className={`whitespace-normal ${cell} font-mono`}
                    >
                      {row.timeframe}
                    </TableCell>
                    <TableCell className={cn("whitespace-normal", cell)}>
                      <RequestStatusChip status={row.status} />
                    </TableCell>
                    <TableCell
                      className={`whitespace-normal ${cell} font-mono text-muted-foreground text-xs`}
                    >
                      {formatTimestamp(row.updatedAt)}
                    </TableCell>
                    <TableCell
                      className={`whitespace-normal ${cell} text-right`}
                    >
                      <Button
                        aria-label={`Open request ${row.strategySlug} ${row.symbol}`}
                        onClick={() => setPanel({ type: "detail", id: row.id })}
                        type="button"
                        variant="secondary"
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};
