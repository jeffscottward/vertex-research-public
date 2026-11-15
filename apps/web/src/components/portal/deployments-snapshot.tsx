"use client";

import type {
  DeployBlockUnavailable,
  DeployEquityBlock,
  DeployFillsBlock,
  DeployKillSwitchState,
  DeployLogsBlock,
  DeployOrdersBlock,
  DeployPositionsBlock,
  DeployRiskBlock,
  DeploySessionBlock,
  DeploySessionState,
  DeploymentStatusOutput,
} from "@darkfactory/api";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";

// Read-only views over the tailnet v2 session snapshot (vertex-deploy-status-v2). Nothing here acts on
// the trading stack; every block is either rendered with its source/as_of or shows the server's reason.

export const DEPLOYMENT_TABS = [
  "positions",
  "orders",
  "fills",
  "equity",
  "logs",
  "services",
] as const;
export type DeploymentTab = (typeof DEPLOYMENT_TABS)[number];
const DEPLOYMENT_TAB_LABELS: Readonly<Record<DeploymentTab, string>> = {
  positions: "Positions",
  orders: "Orders",
  fills: "Fills",
  equity: "Equity",
  logs: "Logs",
  services: "Services",
};
export const DEFAULT_DEPLOYMENT_TAB: DeploymentTab = "positions";

export const isDeploymentTab = (value: unknown): value is DeploymentTab => {
  return (
    typeof value === "string" &&
    (DEPLOYMENT_TABS as readonly string[]).includes(value)
  );
};

export const deploymentTabKeyTarget = (
  key: string,
  current: DeploymentTab
): DeploymentTab | null => {
  const index = DEPLOYMENT_TABS.indexOf(current);
  if (key === "ArrowRight")
    return DEPLOYMENT_TABS[(index + 1) % DEPLOYMENT_TABS.length] ?? null;
  if (key === "ArrowLeft")
    return (
      DEPLOYMENT_TABS[
        (index - 1 + DEPLOYMENT_TABS.length) % DEPLOYMENT_TABS.length
      ] ?? null
    );
  if (key === "Home") return DEPLOYMENT_TABS[0] ?? null;
  if (key === "End") return DEPLOYMENT_TABS.at(-1) ?? null;
  return null;
};

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  success: "border-success-border bg-success-subtle text-success-foreground",
  warning: "border-warning-border bg-warning-subtle text-warning-foreground",
  danger: "border-destructive-border bg-destructive-subtle text-destructive",
  info: "border-primary bg-muted text-foreground",
  neutral: "border-border bg-muted text-muted-foreground",
};

const SESSION_STATE_TONE: Readonly<Record<DeploySessionState, Tone>> = {
  starting: "info",
  running: "success",
  paused: "warning",
  degraded: "warning",
  halted: "danger",
  stopping: "info",
  stopped: "neutral",
  error: "danger",
  unknown: "neutral",
};

const KILL_SWITCH_TONE: Readonly<Record<DeployKillSwitchState, Tone>> = {
  engaged: "danger",
  clear: "success",
  unknown: "warning",
};

const Chip = ({
  tone,
  children,
  title,
  data,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly data?: Record<string, string>;
}) => {
  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 font-medium text-xs ${TONE_CLASS[tone]}`}
      title={title}
      {...data}
    >
      {children}
    </span>
  );
};

const StaleChip = () => {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 font-medium text-xs ${TONE_CLASS.warning}`}
      data-deployment-block-stale=""
    >
      stale
    </span>
  );
};

const formatUtc = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
};

const formatAge = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
};

const formatNumber = (value: number | null | undefined, digits = 2): string => {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
};

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value))
    return value.length === 0 ? "none" : value.map(formatValue).join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return formatNumber(value, 6);
  return String(value);
};

const rawStateTitle = (
  session: Extract<DeploySessionBlock, { available: true }>
): string => {
  const raw = session.raw_state;
  return [
    `container ${raw.container_status ?? "—"}`,
    `health ${raw.container_health ?? "—"}`,
    `exit ${raw.container_exit_code ?? "—"}`,
    `health.json ${raw.health_file_status ?? "—"}`,
    `last runner event ${raw.last_runner_event ?? "—"} ${raw.last_runner_event_at ?? ""}`.trim(),
    `heartbeat age ${raw.heartbeat_age_seconds === null ? "—" : formatAge(Math.round(raw.heartbeat_age_seconds))}`,
  ].join(" · ");
};

const SessionStateChip = ({
  session,
}: {
  readonly session: DeploySessionBlock | undefined;
}) => {
  if (session === undefined || !session.available) {
    return (
      <Chip
        data={{ "data-session-state": "unknown" }}
        title={session?.reason}
        tone="neutral"
      >
        unknown
      </Chip>
    );
  }
  return (
    <Chip
      data={{ "data-session-state": session.state }}
      title={rawStateTitle(session)}
      tone={SESSION_STATE_TONE[session.state]}
    >
      {session.state}
    </Chip>
  );
};

const Unavailable = ({
  reason,
  name,
}: {
  readonly reason: string;
  readonly name: string;
}) => {
  return (
    <p
      className="text-muted-foreground text-sm"
      data-deployment-unavailable={name}
    >
      Unavailable: {reason}
    </p>
  );
};

type AvailableMeta = Readonly<{
  source: string;
  as_of: string | null;
  age_seconds?: number | undefined;
  stale?: boolean | undefined;
}>;

const BlockMeta = ({ block }: { readonly block: AvailableMeta }) => {
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs [overflow-wrap:anywhere]"
      data-deployment-block-meta=""
    >
      <span>Source {block.source}</span>
      <span>
        · as of {formatUtc(block.as_of)}
        {block.age_seconds === undefined
          ? ""
          : ` (${formatAge(block.age_seconds)} ago)`}
      </span>
      {block.stale === true ? <StaleChip /> : null}
    </p>
  );
};

const notConfiguredReason = (data: DeploymentStatusOutput): string => {
  return (
    data.snapshotError ??
    "tailnet snapshot not configured (VERTEX_DEPLOY_STATUS_V2_URL)"
  );
};

type Block =
  | Readonly<{ available: true } & AvailableMeta>
  | DeployBlockUnavailable;

const BlockFrame = ({
  name,
  block,
  data,
  children,
}: {
  readonly name: string;
  readonly block: Block | undefined;
  readonly data: DeploymentStatusOutput;
  readonly children: () => ReactNode;
}) => {
  if (block === undefined)
    return <Unavailable name={name} reason={notConfiguredReason(data)} />;
  if (!block.available)
    return <Unavailable name={name} reason={block.reason} />;
  return (
    <div className="space-y-2" data-deployment-block={name}>
      <BlockMeta block={block} />
      {children()}
    </div>
  );
};

const th = "whitespace-nowrap px-2 py-1.5 font-normal text-muted-foreground";
const td = "whitespace-nowrap px-2 py-1.5 align-top font-mono";
const tdNum = `${td} text-right`;

const ScrollTable = ({
  caption,
  minWidth,
  head,
  children,
  name,
}: {
  readonly caption: string;
  readonly minWidth: string;
  readonly head: readonly (readonly [string, boolean])[];
  readonly children: ReactNode;
  readonly name: string;
}) => {
  return (
    <div
      className="overflow-x-auto"
      data-deployment-scroll={name}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <Table
        containerClassName="overflow-visible"
        className={`w-full text-sm ${minWidth}`}
      >
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
            {head.map(([label, numeric]) => (
              <TableHead
                className={numeric ? `${th} text-right` : th}
                key={label}
                scope="col"
              >
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
};

const Empty = ({
  cols,
  text,
}: {
  readonly cols: number;
  readonly text: string;
}) => {
  return (
    <TableRow>
      <TableCell
        className="whitespace-normal px-2 py-3 text-muted-foreground text-sm"
        colSpan={cols}
      >
        {text}
      </TableCell>
    </TableRow>
  );
};

const Truncated = ({
  shown,
  count,
  truncated,
}: {
  readonly shown: number;
  readonly count: number;
  readonly truncated?: boolean | undefined;
}) => {
  return truncated === true || count > shown ? (
    <p className="text-muted-foreground text-xs">
      Showing {shown} of {count}
    </p>
  ) : null;
};

export const PositionsPanel = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  return (
    <BlockFrame block={data.positions} data={data} name="positions">
      {() => {
        const block = data.positions as Extract<
          DeployPositionsBlock,
          { available: true }
        >;
        return (
          <>
            <ScrollTable
              caption="Positions"
              head={[
                ["Symbol", false],
                ["Type", false],
                ["Qty", true],
                ["Avg px", true],
                ["Mkt price", true],
                ["Mkt value", true],
                ["Unrealized", true],
                ["Realized", true],
                ["Ccy", false],
              ]}
              minWidth="min-w-[52rem]"
              name="positions"
            >
              {block.items.length === 0 ? (
                <Empty cols={9} text="No positions" />
              ) : (
                block.items.map((item, index) => {
                  return (
                    <TableRow
                      className="border-border border-b"
                      data-position-row={item.symbol}
                      key={`${item.symbol}-${index}`}
                    >
                      <TableCell className={td}>
                        {item.symbol}
                        {item.sec_type === "OPT"
                          ? ` ${item.expiry ?? ""} ${item.strike ?? ""}${item.right ?? ""}`
                          : ""}
                      </TableCell>
                      <TableCell className={td}>
                        {item.sec_type ?? "—"}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.qty, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.avg_px, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.market_price, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.market_value)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.unrealized_pnl)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.realized_pnl)}
                      </TableCell>
                      <TableCell className={td}>
                        {item.currency ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </ScrollTable>
            <Truncated
              count={block.count}
              shown={block.items.length}
              truncated={block.truncated}
            />
          </>
        );
      }}
    </BlockFrame>
  );
};

export const OrdersPanel = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  return (
    <BlockFrame block={data.orders} data={data} name="orders">
      {() => {
        const block = data.orders as Extract<
          DeployOrdersBlock,
          { available: true }
        >;
        return (
          <>
            <ScrollTable
              caption="Open orders"
              head={[
                ["Order", false],
                ["Symbol", false],
                ["Side", false],
                ["Type", false],
                ["Qty", true],
                ["Filled", true],
                ["Remaining", true],
                ["Limit", true],
                ["Stop", true],
                ["Aux", true],
                ["TIF", false],
                ["Status", false],
                ["Warning", false],
              ]}
              minWidth="min-w-[64rem]"
              name="orders"
            >
              {block.items.length === 0 ? (
                <Empty cols={13} text="No open orders" />
              ) : (
                block.items.map((item, index) => {
                  return (
                    <TableRow
                      className="border-border border-b"
                      data-order-row={item.symbol}
                      key={`${item.order_id_masked ?? "order"}-${index}`}
                    >
                      <TableCell className={td}>
                        {item.order_id_masked ?? "—"}
                      </TableCell>
                      <TableCell className={td}>{item.symbol}</TableCell>
                      <TableCell className={td}>{item.side ?? "—"}</TableCell>
                      <TableCell className={td}>{item.type ?? "—"}</TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.qty, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.filled, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.remaining, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.price, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.stop, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.aux_price, 4)}
                      </TableCell>
                      <TableCell className={td}>{item.tif ?? "—"}</TableCell>
                      <TableCell className={td}>{item.status ?? "—"}</TableCell>
                      <TableCell className={`${td} text-warning-foreground`}>
                        {item.warning ?? ""}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </ScrollTable>
            <Truncated
              count={block.count}
              shown={block.items.length}
              truncated={block.truncated}
            />
          </>
        );
      }}
    </BlockFrame>
  );
};

export const FillsPanel = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  return (
    <BlockFrame block={data.fills} data={data} name="fills">
      {() => {
        const block = data.fills as Extract<
          DeployFillsBlock,
          { available: true }
        >;
        return (
          <>
            <ScrollTable
              caption="Fills, newest first"
              head={[
                ["Time", false],
                ["Symbol", false],
                ["Side", false],
                ["Qty", true],
                ["Price", true],
                ["Order", false],
                ["Execution", false],
              ]}
              minWidth="min-w-[48rem]"
              name="fills"
            >
              {block.items.length === 0 ? (
                <Empty cols={7} text="No fills" />
              ) : (
                block.items.map((item, index) => {
                  return (
                    <TableRow
                      className="border-border border-b"
                      data-fill-row={item.symbol}
                      key={`${item.exec_id_masked ?? "fill"}-${index}`}
                    >
                      <TableCell className={td}>
                        {formatUtc(item.time)}
                      </TableCell>
                      <TableCell className={td}>{item.symbol}</TableCell>
                      <TableCell className={td}>{item.side ?? "—"}</TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.qty, 4)}
                      </TableCell>
                      <TableCell className={tdNum}>
                        {formatNumber(item.price, 4)}
                      </TableCell>
                      <TableCell className={td}>
                        {item.order_id_masked ?? "—"}
                      </TableCell>
                      <TableCell className={td}>
                        {item.exec_id_masked ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </ScrollTable>
            <Truncated
              count={block.count}
              shown={block.items.length}
              truncated={block.truncated}
            />
          </>
        );
      }}
    </BlockFrame>
  );
};

export const EquityPanel = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  return (
    <BlockFrame block={data.equity} data={data} name="equity">
      {() => {
        const block = data.equity as Extract<
          DeployEquityBlock,
          { available: true }
        >;
        const rows: [string, number | null][] = [
          ["Net liquidation", block.net_liq],
          ["Cash", block.cash],
          ["Available funds", block.available_funds],
          ["Buying power", block.buying_power],
          ["Unrealized P&L", block.unrealized],
          ["Realized P&L", block.realized],
        ];
        return (
          <dl
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            data-equity=""
          >
            {rows.map(([label, value]) => {
              return (
                <div
                  className="rounded-md border border-border px-3 py-2"
                  key={label}
                >
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="font-mono text-base">
                    {formatNumber(value)}{" "}
                    <span className="text-muted-foreground text-xs">
                      {block.currency ?? ""}
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>
        );
      }}
    </BlockFrame>
  );
};

export const LogsPanel = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  return (
    <BlockFrame block={data.logs} data={data} name="logs">
      {() => {
        const block = data.logs as Extract<
          DeployLogsBlock,
          { available: true }
        >;
        return (
          <>
            <ScrollTable
              caption="Warnings and errors, newest first"
              head={[
                ["Time", false],
                ["Level", false],
                ["Source", false],
                ["Count", true],
                ["Message", false],
              ]}
              minWidth="min-w-[48rem]"
              name="logs"
            >
              {block.items.length === 0 ? (
                <Empty cols={5} text="No warnings or errors" />
              ) : (
                block.items.map((item, index) => {
                  return (
                    <TableRow
                      className={`border-border border-b ${item.level === "ERROR" ? "text-destructive" : ""}`}
                      data-log-row={item.level}
                      key={`${item.time ?? ""}-${index}`}
                    >
                      <TableCell className={td}>
                        {formatUtc(item.time)}
                      </TableCell>
                      <TableCell className={td}>{item.level}</TableCell>
                      <TableCell className={td}>{item.source}</TableCell>
                      <TableCell className={tdNum}>{item.count}</TableCell>
                      <TableCell className="min-w-[20rem] whitespace-normal px-2 py-1.5 align-top font-mono text-xs [overflow-wrap:anywhere]">
                        {item.message}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </ScrollTable>
            <Truncated
              count={block.count}
              shown={block.items.length}
              truncated={block.truncated}
            />
          </>
        );
      }}
    </BlockFrame>
  );
};

const Field = ({
  label,
  children,
  name,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly name: string;
}) => {
  return (
    <div className="min-w-0" data-strip-field={name}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
};

export const StatusStrip = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  const session = data.session;
  const live = session?.available ? session : null;
  return (
    <section
      aria-label="Session"
      className="space-y-2 rounded-md border border-border p-3"
      data-deployment-strip=""
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        <Field label="Session" name="state">
          <SessionStateChip session={session} />
        </Field>
        <Field label="Strategies" name="strategies">
          {live === null
            ? "—"
            : live.strategies.length === 0
              ? "none"
              : live.strategies.map((strategy) => strategy.name).join(", ")}
        </Field>
        <Field label="Symbols" name="symbols">
          {live === null
            ? "—"
            : live.symbols.length === 0
              ? "none"
              : live.symbols.join(", ")}
        </Field>
        <Field label="Account" name="account">
          {live?.account_masked ?? "—"}
        </Field>
        <Field label="Started" name="started">
          {formatUtc(live?.started_at)}
        </Field>
        <Field label="Stopped" name="stopped">
          {formatUtc(live?.stopped_at)}
        </Field>
        <Field label="Last heartbeat" name="heartbeat">
          {formatUtc(live?.last_heartbeat_at)}
        </Field>
        <Field label="Data age" name="age">
          <span className="inline-flex flex-wrap items-center gap-1">
            {formatAge(data.source.ageSeconds)}
            {data.source.stale ? <StaleChip /> : null}
          </span>
        </Field>
      </dl>
      {session === undefined ? (
        <Unavailable name="session" reason={notConfiguredReason(data)} />
      ) : session.available ? (
        <BlockMeta block={session} />
      ) : (
        <Unavailable name="session" reason={session.reason} />
      )}
    </section>
  );
};

const killSwitchOf = (
  risk: DeployRiskBlock | undefined
): DeployKillSwitchState => {
  return risk?.available ? risk.kill_switch : "unknown";
};

export const RiskPanel = ({
  data,
}: {
  readonly data: DeploymentStatusOutput;
}) => {
  const risk = data.risk;
  const kill = killSwitchOf(risk);
  const live = risk?.available ? risk : null;
  const limits = live?.limits.available
    ? Object.entries(live.limits).filter(
        ([key]) =>
          !["available", "source", "as_of", "age_seconds", "stale"].includes(
            key
          )
      )
    : [];
  const check = live?.last_risk_check ?? null;
  const watchdog = live?.watchdog ?? null;
  return (
    <section
      aria-labelledby="deployment-risk-heading"
      className="space-y-3 rounded-md border border-border p-3"
      data-deployment-risk=""
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium text-base" id="deployment-risk-heading">
          Risk
        </h2>
        <span
          className={`inline-flex min-h-9 items-center rounded-md border-2 px-3 font-semibold text-sm ${TONE_CLASS[KILL_SWITCH_TONE[kill]]}`}
          data-kill-switch={kill}
          role="status"
        >
          Kill switch {kill}
        </span>
      </div>
      {risk === undefined ? (
        <Unavailable name="risk" reason={notConfiguredReason(data)} />
      ) : risk.available ? (
        <div className="space-y-3">
          <BlockMeta block={risk} />
          <ul className="flex flex-wrap gap-2 text-xs" data-kill-indicators="">
            {risk.kill_switch_indicators.map((indicator) => {
              return (
                <li
                  className="rounded border border-border px-2 py-1 font-mono"
                  key={indicator.source}
                >
                  {indicator.source}:{" "}
                  {indicator.engaged === null
                    ? "unknown"
                    : indicator.engaged
                      ? "engaged"
                      : "clear"}
                </li>
              );
            })}
          </ul>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="min-w-0 space-y-1" data-risk-limits="">
              <h3 className="font-medium text-sm">Limits</h3>
              {risk.limits.available ? (
                <ScrollTable
                  caption="Risk limits"
                  head={[
                    ["Setting", false],
                    ["Value", false],
                  ]}
                  minWidth="min-w-[18rem]"
                  name="limits"
                >
                  {limits.length === 0 ? (
                    <Empty cols={2} text="No limits reported" />
                  ) : (
                    limits.map(([key, value]) => {
                      return (
                        <TableRow className="border-border border-b" key={key}>
                          <TableCell className={`${td} text-xs`}>
                            {key}
                          </TableCell>
                          <TableCell className={`${td} text-xs`}>
                            {formatValue(value)}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </ScrollTable>
              ) : (
                <Unavailable name="limits" reason={risk.limits.reason} />
              )}
            </div>
            <div className="min-w-0 space-y-1" data-risk-last-check="">
              <h3 className="font-medium text-sm">Last risk check</h3>
              {check === null ? (
                <p className="text-muted-foreground text-sm">None recorded</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {(
                    [
                      "time",
                      "event",
                      "allowed",
                      "dry_run",
                      "reason",
                      "strategy",
                      "requested_symbol",
                    ] as const
                  ).map((key) => {
                    return (
                      <div className="contents" key={key}>
                        <dt className="text-muted-foreground">
                          {key.replace("_", " ")}
                        </dt>
                        <dd className="font-mono [overflow-wrap:anywhere]">
                          {key === "time"
                            ? formatUtc(
                                typeof check[key] === "string"
                                  ? (check[key] as string)
                                  : null
                              )
                            : formatValue(check[key])}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
            <div className="min-w-0 space-y-1" data-risk-watchdog="">
              <h3 className="font-medium text-sm">Watchdog</h3>
              {watchdog === null ? (
                <p className="text-muted-foreground text-sm">
                  No watchdog status
                </p>
              ) : (
                <div className="space-y-2 text-xs">
                  <p className="flex flex-wrap items-center gap-2">
                    <Chip
                      data={{
                        "data-watchdog-status": watchdog.status ?? "unknown",
                      }}
                      tone={
                        watchdog.status === "ok"
                          ? "success"
                          : watchdog.status === null
                            ? "neutral"
                            : "warning"
                      }
                    >
                      {watchdog.status ?? "unknown"}
                    </Chip>
                    <span className="font-mono">
                      safe mode {formatValue(watchdog.safe_mode)} · orders{" "}
                      {formatValue(watchdog.orders_enabled)} ·{" "}
                      {formatUtc(watchdog.as_of)}
                    </span>
                  </p>
                  {watchdog.required_failures.length === 0 ? null : (
                    <p className="text-destructive">
                      Required failures:{" "}
                      <span className="font-mono">
                        {watchdog.required_failures.join(", ")}
                      </span>
                    </p>
                  )}
                  <ul className="space-y-1">
                    {Object.entries(watchdog.checks).map(([name, value]) => {
                      return (
                        <li
                          className={`font-mono [overflow-wrap:anywhere] ${value.ok === false ? "text-destructive" : ""}`}
                          data-watchdog-check={name}
                          key={name}
                        >
                          {value.ok === false ? "✕" : "✓"} {name}
                          {value.ok === false && value.detail !== null
                            ? `: ${value.detail}`
                            : ""}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <Unavailable name="risk" reason={risk.reason} />
      )}
    </section>
  );
};

export const DeploymentTabs = ({
  tab,
  onTab,
  panels,
}: {
  readonly tab: DeploymentTab;
  readonly onTab: (tab: DeploymentTab) => void;
  readonly panels: Readonly<Record<DeploymentTab, () => ReactNode>>;
}) => {
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = deploymentTabKeyTarget(event.key, tab);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`deployment-tab-${next}`)?.focus();
  };
  return (
    <div className="space-y-3">
      <div
        aria-label="Deployment views"
        className="flex gap-1 overflow-x-auto border-border border-b"
        onKeyDown={onKey}
        role="tablist"
      >
        {DEPLOYMENT_TABS.map((option) => {
          return (
            <button
              aria-controls={`deployment-panel-${option}`}
              aria-selected={tab === option}
              className={`min-h-11 min-w-11 shrink-0 border-b-2 px-3 text-sm ${tab === option ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              data-tab={option}
              id={`deployment-tab-${option}`}
              key={option}
              onClick={() => onTab(option)}
              role="tab"
              tabIndex={tab === option ? 0 : -1}
              type="button"
            >
              {DEPLOYMENT_TAB_LABELS[option]}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`deployment-tab-${tab}`}
        className="min-w-0"
        data-deployment-panel={tab}
        id={`deployment-panel-${tab}`}
        role="tabpanel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabpanel: the panel is focusable so keyboard users reach its content.
        tabIndex={0}
      >
        {panels[tab]()}
      </div>
    </div>
  );
};
