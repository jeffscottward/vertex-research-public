"use client";

import type {
  PortfolioMonitorExecution,
  PortfolioMonitorOrder,
  RoundHandleFlag,
  PortfolioMonitorPosition,
} from "@darkfactory/api";
import { Button, StatusBadge, TableScrollText, cn } from "@darkfactory/ui";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  CornerDownRight,
  RotateCcw,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useStoredState } from "./portfolio-monitor-controls.tsx";
import {
  COLUMN_BY_ID,
  COLUMNS_STORAGE_KEY,
  DASH,
  DEFAULT_COLUMN_CONFIG,
  completedClock,
  completedReason,
  executionClock,
  executionsNewestFirst,
  groupOrders,
  holdingLabel,
  moveColumn,
  nextSort,
  normalizeColumnConfig,
  normalizeSort,
  orderStatusLabel,
  orderStatusTitle,
  orderStatusTone,
  pct,
  pnlClass,
  positionName,
  positionTotals,
  price,
  qty,
  signed,
  sortPositions,
  toggleColumn,
  usd,
  visibleColumns,
  POSITION_COLUMNS,
  type PositionColumn,
  type PositionColumnId,
  type PositionTotals,
} from "./portfolio-monitor-model.ts";

export const SORT_STORAGE_KEY = "vertex.monitor.sort.v1";

const TABLE = "w-full min-w-max border-collapse text-sm tabular-nums";
// Reference header row: tinted, small uppercase muted labels (the tint is on each th, so the sticky
// symbol header keeps it while the body scrolls under it).
const HEAD_ROW =
  "border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground [&>th]:bg-muted";
const CELL = "px-2 py-2 align-top";
const STICKY = "sticky left-0 z-[1] bg-card";
/** Each table block is a card: clear separation between positions, orders and executions. */
const SECTION = "space-y-3 rounded-xl border bg-card p-4 shadow-xs";
const SIDE_CLASS = (side: string): string => {
  return side === "BUY" || side === "BOT"
    ? "text-success-foreground"
    : "text-destructive";
};

// Wide tables scroll inside a labelled, keyboard-focusable region (no page-level horizontal scroll).
const ScrollRegion = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  <div
    aria-label={label}
    className="overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    role="region"
    // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
    tabIndex={0}
  >
    {children}
  </div>
);

export const PanelTitle = ({
  children,
  id,
}: {
  readonly children: ReactNode;
  readonly id: string;
}) => (
  <h3 className="font-heading font-semibold text-base" id={id}>
    {children}
  </h3>
);

const UnknownNotice = ({ text }: { readonly text: string }) => (
  <p
    className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning-foreground"
    data-unknown="true"
  >
    {text}
  </p>
);

// An empty list is only "empty" when the gateway is live; otherwise the true state is unknown.
export const EmptyOrUnknown = ({
  empty,
  live,
  unknown,
}: {
  readonly empty: string;
  readonly live: boolean;
  readonly unknown: string;
}) => {
  if (live)
    return (
      <p className="text-muted-foreground text-sm" data-empty="true">
        {empty}
      </p>
    );
  return <UnknownNotice text={unknown} />;
};

const Muted = ({ text }: { readonly text: string }) => (
  <span className="text-muted-foreground">{text}</span>
);

// ---------- positions ----------

const positionCell = (
  position: PortfolioMonitorPosition,
  id: PositionColumnId
): ReactNode => {
  switch (id) {
    case "symbol": {
      return (
        <TableScrollText
          className="font-semibold"
          text={positionName(position)}
        />
      );
    }
    case "position": {
      return qty(position.position);
    }
    case "avgPrice": {
      return price(position.avgPrice);
    }
    case "last": {
      return price(position.last);
    }
    case "marketValue": {
      return usd(position.marketValue);
    }
    case "dailyPnl":
    case "unrealized":
    case "realized": {
      return (
        <span className={pnlClass(position[id])}>{signed(position[id])}</span>
      );
    }
    case "unrealizedPct": {
      return (
        <span className={pnlClass(position.unrealizedPct)}>
          {pct(position.unrealizedPct)}
        </span>
      );
    }
    case "weightPct": {
      return pct(position.weightPct, 1);
    }
    case "costBasis": {
      return usd(position.costBasis);
    }
    default: {
      return holdingLabel(position);
    }
  }
};

const totalCell = (totals: PositionTotals, id: PositionColumnId): ReactNode => {
  switch (id) {
    case "symbol": {
      return <span className="font-semibold">Total</span>;
    }
    case "marketValue":
    case "costBasis": {
      return usd(totals[id]);
    }
    case "dailyPnl":
    case "unrealized":
    case "realized": {
      return <span className={pnlClass(totals[id])}>{signed(totals[id])}</span>;
    }
    case "weightPct": {
      return pct(totals.weightPct, 1);
    }
    default: {
      return "";
    }
  }
};

const ColumnEditor = ({
  config,
  onChange,
}: {
  readonly config: typeof DEFAULT_COLUMN_CONFIG;
  readonly onChange: (next: typeof DEFAULT_COLUMN_CONFIG) => void;
}) => (
  <div
    className="space-y-2 rounded-md border border-border p-3"
    data-column-editor="true"
    id="pm-column-editor"
  >
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground text-xs">
        Show, hide and reorder columns. This browser saves the layout.
      </p>
      <Button
        onClick={() => onChange(DEFAULT_COLUMN_CONFIG)}
        size="compact"
        variant="ghost"
      >
        <RotateCcw aria-hidden="true" className="size-4" />
        Reset columns
      </Button>
    </div>
    <ul className="grid gap-1 sm:grid-cols-2">
      {config.order.map((id, index) => {
        const column = COLUMN_BY_ID[id];
        const shown = !config.hidden.includes(id);
        return (
          <li
            className="flex items-center gap-1 rounded-md bg-muted px-2"
            key={id}
          >
            <label
              className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 text-sm"
              htmlFor={`pm-col-${id}`}
            >
              <input
                checked={shown}
                className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={id === "symbol"}
                id={`pm-col-${id}`}
                onChange={() => onChange(toggleColumn(config, id))}
                type="checkbox"
              />
              {column.label}
            </label>
            <Button
              aria-label={`Move ${column.label} up`}
              className="px-0"
              disabled={index === 0}
              onClick={() => onChange(moveColumn(config, index, -1))}
              size="compact"
              variant="ghost"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
            <Button
              aria-label={`Move ${column.label} down`}
              className="px-0"
              disabled={index === config.order.length - 1}
              onClick={() => onChange(moveColumn(config, index, 1))}
              size="compact"
              variant="ghost"
            >
              <ArrowDown aria-hidden="true" className="size-4" />
            </Button>
          </li>
        );
      })}
    </ul>
  </div>
);

const BodyCell = ({
  column,
  value,
}: {
  readonly column: PositionColumn;
  readonly value: ReactNode;
}) => {
  if (column.id === "symbol") {
    return (
      <th className={cn(CELL, STICKY, "text-left font-normal")} scope="row">
        {value}
      </th>
    );
  }
  return (
    <td
      className={cn(CELL, column.numeric && "text-right")}
      data-column={column.id}
    >
      {value}
    </td>
  );
};

export const PositionsPanel = ({
  actions,
  empty = "No open positions.",
  live,
  positions,
  title = "Positions",
}: {
  /** Optional order-button cell per row (owner order actions); adds an "Actions" column. */
  readonly actions?:
    | ((
        position: PortfolioMonitorPosition,
        positions: readonly PortfolioMonitorPosition[]
      ) => ReactNode)
    | undefined;
  readonly empty?: string;
  readonly live: boolean;
  readonly positions: readonly PortfolioMonitorPosition[];
  readonly title?: string;
}) => {
  const [config, setConfig] = useStoredState(
    COLUMNS_STORAGE_KEY,
    normalizeColumnConfig
  );
  const [sort, setSort] = useStoredState(SORT_STORAGE_KEY, normalizeSort);
  const [editing, setEditing] = useState(false);
  const columns = visibleColumns(config);
  const rows = sortPositions(positions, sort);
  const totals = positionTotals(positions);
  return (
    <section aria-labelledby="pm-positions-title" className={SECTION}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PanelTitle id="pm-positions-title">
          {`${title} (${positions.length})`}
        </PanelTitle>
        <Button
          aria-controls="pm-column-editor"
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
          size="compact"
          variant="secondary"
        >
          <Columns3 aria-hidden="true" className="size-4" />
          Columns
        </Button>
      </div>
      {editing ? <ColumnEditor config={config} onChange={setConfig} /> : null}
      {positions.length === 0 ? (
        <EmptyOrUnknown
          empty={empty}
          live={live}
          unknown="Positions unknown. The IBKR gateway is not live, so this list may be incomplete."
        />
      ) : (
        <ScrollRegion label="Positions table">
          <table className={TABLE}>
            <caption className="sr-only">
              Positions. Sorted by{" "}
              {POSITION_COLUMNS.find((column) => column.id === sort.id)?.label},{" "}
              {sort.dir === 1 ? "ascending" : "descending"}.
            </caption>
            <thead>
              <tr className={HEAD_ROW}>
                {columns.map((column) => {
                  const active = sort.id === column.id;
                  return (
                    <th
                      aria-sort={
                        active
                          ? sort.dir === 1
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      className={cn(
                        "p-0 font-semibold",
                        column.id === "symbol" && STICKY
                      )}
                      key={column.id}
                      scope="col"
                    >
                      <button
                        className={cn(
                          "inline-flex min-h-11 w-full items-center gap-1 px-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          column.numeric && "justify-end"
                        )}
                        data-sort-column={column.id}
                        onClick={() => setSort(nextSort(sort, column.id))}
                        type="button"
                      >
                        {column.label}
                        {active ? (
                          sort.dir === 1 ? (
                            <ArrowUp aria-hidden="true" className="size-3" />
                          ) : (
                            <ArrowDown aria-hidden="true" className="size-3" />
                          )
                        ) : null}
                      </button>
                    </th>
                  );
                })}
                {actions === undefined ? null : (
                  <th className="px-2 font-semibold" scope="col">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((position) => {
                return (
                  <tr
                    className="border-border border-b"
                    data-position-id={position.id}
                    key={position.id}
                  >
                    {columns.map((column) => (
                      <BodyCell
                        column={column}
                        key={column.id}
                        value={positionCell(position, column.id)}
                      />
                    ))}
                    {actions === undefined ? null : (
                      <td className={CELL} data-column="actions">
                        {actions(position, positions)}
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr className="font-semibold" data-totals="true">
                {columns.map((column) => (
                  <BodyCell
                    column={column}
                    key={column.id}
                    value={totalCell(totals, column.id)}
                  />
                ))}
                {actions === undefined ? null : <td className={CELL} />}
              </tr>
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
};

// ---------- orders ----------

const OPEN_ORDERS_EXPLANATION =
  'All orders here come from IBKR. "Held at IBKR" (IBKR status PreSubmitted) means IBKR accepted the order and keeps it on its own servers. IBKR simulates stop orders this way, so a stop stays "Held at IBKR" during market hours too and goes to the exchange only when the stop price triggers. "At exchange" (Submitted) means the order is resting at the exchange.';

const OrdersExplanation = () => (
  <p className="max-w-reading text-muted-foreground text-xs">
    {OPEN_ORDERS_EXPLANATION}
  </p>
);

const OcaBadge = ({ group }: { readonly group: string }) => (
  <StatusBadge status="neutral" title={`One-cancels-all group ${group}`}>
    OCA
  </StatusBadge>
);

const OrderStatus = ({
  completed,
  order,
}: {
  readonly completed: boolean;
  readonly order: PortfolioMonitorOrder;
}) => {
  const detail = completed
    ? [
        completedReason(order.completedStatus),
        order.completedTime === "" ? "" : completedClock(order.completedTime),
      ]
        .filter((part) => part !== "")
        .join(" · ")
    : "";
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusBadge
        status={orderStatusTone(order.status)}
        title={orderStatusTitle(order.status)}
      >
        {orderStatusLabel(order.status)}
      </StatusBadge>
      {detail === "" ? null : <Muted text={detail} />}
    </div>
  );
};

// Round-number (.00/.50) flags per order key from ibkrMonitor.roundHandles. Text only.
type OrderHandleFlags = Partial<
  Record<RoundHandleFlag["kind"], RoundHandleFlag>
>;
export type RoundHandleFlags = ReadonlyMap<string, Readonly<OrderHandleFlags>>;

export const roundHandleFlags = (
  flags: readonly RoundHandleFlag[]
): RoundHandleFlags => {
  const byKey = new Map<string, OrderHandleFlags>();
  for (const flag of flags)
    byKey.set(flag.key, { ...byKey.get(flag.key), [flag.kind]: flag });
  return byKey;
};

// A flag shows only while it still matches the row's current price: the check polls once a
// minute, so an order changed in IBKR in between keeps its key but not its flagged price.
const HandleFlag = ({
  current,
  flag,
}: {
  readonly current: number | null;
  readonly flag?: RoundHandleFlag | undefined;
}) =>
  flag !== undefined && flag.price === current ? (
    <span
      className="block text-warning-foreground text-xs"
      data-round-handle={flag.kind}
      title={`${flag.handle}. Round prices attract many orders. Consider ${flag.suggested.toFixed(2)} (${flag.side} the handle by ${flag.offset.toFixed(2)}). Text only; no order is changed.`}
    >
      {`round · try ${flag.suggested.toFixed(2)}`}
    </span>
  ) : null;

const OrderTableRow = ({
  completed,
  depth,
  handles,
  order,
}: {
  readonly completed: boolean;
  readonly depth: number;
  readonly handles?: Readonly<OrderHandleFlags> | undefined;
  readonly order: PortfolioMonitorOrder;
}) => (
  <tr
    className={cn("border-border border-b", depth > 0 && "bg-muted")}
    data-depth={depth}
    data-order-key={order.key}
  >
    <th
      className={cn(
        CELL,
        STICKY,
        "text-left font-semibold",
        depth > 0 && "bg-muted"
      )}
      scope="row"
    >
      <span
        className="inline-flex items-center gap-1"
        style={{ paddingLeft: `${depth * 0.875}rem` }}
      >
        {depth > 0 ? (
          <CornerDownRight
            aria-label="Child order"
            className="size-3 text-muted-foreground"
            role="img"
          />
        ) : null}
        <TableScrollText text={order.symbol} />
      </span>
    </th>
    <td className={cn(CELL, SIDE_CLASS(order.action))}>{order.action}</td>
    <td className={CELL}>{order.orderType}</td>
    <td className={cn(CELL, "text-right")}>
      {qty(order.qty)}
      {order.filledQty ? (
        <Muted text={` (${qty(order.filledQty)} filled)`} />
      ) : null}
    </td>
    <td className={cn(CELL, "text-right")} data-column="limit">
      {price(order.limitPrice)}
      <HandleFlag flag={handles?.limit} current={order.limitPrice} />
    </td>
    <td className={cn(CELL, "text-right")} data-column="stop">
      {price(order.stopPrice)}
      {order.trailPct ? <Muted text={` (trail ${order.trailPct}%)`} /> : null}
      <HandleFlag flag={handles?.stop} current={order.stopPrice} />
    </td>
    <td className={CELL}>
      {order.tif}
      {order.outsideRth ? " · ext hours" : ""}
    </td>
    <td className={CELL}>
      <OrderStatus completed={completed} order={order} />
    </td>
    <td className={cn(CELL, "text-muted-foreground text-xs")}>
      <span className="inline-flex flex-wrap items-center gap-1">
        {order.ocaGroup ? <OcaBadge group={order.ocaGroup} /> : null}
        {order.orderRef || (order.ocaGroup ? "" : DASH)}
      </span>
    </td>
  </tr>
);

export interface OrdersTableProps {
  readonly orders: readonly PortfolioMonitorOrder[];
  readonly title: string;
  readonly titleId: string;
  readonly empty: string;
  readonly live: boolean;
  readonly completed?: boolean;
  readonly handles?: RoundHandleFlags | undefined;
}

export const OrdersTable = ({
  completed = false,
  empty,
  handles,
  live,
  orders,
  title,
  titleId,
}: OrdersTableProps) => {
  const groups = groupOrders(orders);
  return (
    <section aria-labelledby={titleId} className={SECTION}>
      <PanelTitle id={titleId}>{`${title} (${orders.length})`}</PanelTitle>
      {completed ? null : <OrdersExplanation />}
      {orders.length === 0 ? (
        <EmptyOrUnknown
          empty={empty}
          live={live}
          unknown="Orders unknown. The IBKR gateway is not live, so this list may be incomplete."
        />
      ) : (
        <ScrollRegion label={`${title} table`}>
          <table className={TABLE}>
            <caption className="sr-only">
              {title}, grouped by symbol. Child orders follow their parent.
            </caption>
            <thead>
              <tr className={HEAD_ROW}>
                <th className={cn(CELL, STICKY)} scope="col">
                  Symbol
                </th>
                <th className={CELL} scope="col">
                  Side
                </th>
                <th className={CELL} scope="col">
                  Type
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Qty
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Limit
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Stop
                </th>
                <th className={CELL} scope="col">
                  TIF
                </th>
                <th className={CELL} scope="col">
                  {completed ? "Result" : "Status"}
                </th>
                <th className={CELL} scope="col">
                  Group / Ref
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((group) =>
                group.rows.map((row) => {
                  return (
                    <OrderTableRow
                      completed={completed}
                      depth={row.depth}
                      handles={handles?.get(row.order.key)}
                      key={row.order.key}
                      order={row.order}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
};

// ---------- executions ----------

export const ExecutionsTable = ({
  executions,
  live,
}: {
  readonly executions: readonly PortfolioMonitorExecution[];
  readonly live: boolean;
}) => {
  const rows = executionsNewestFirst(executions);
  return (
    <section aria-labelledby="pm-executions-title" className={SECTION}>
      <PanelTitle id="pm-executions-title">
        {`Executions today (${executions.length})`}
      </PanelTitle>
      {rows.length === 0 ? (
        <EmptyOrUnknown
          empty="No executions today."
          live={live}
          unknown="Executions unknown. The IBKR gateway is not live, so this list may be incomplete."
        />
      ) : (
        <ScrollRegion label="Executions table">
          <table className={TABLE}>
            <caption className="sr-only">
              Executions today, newest first.
            </caption>
            <thead>
              <tr className={HEAD_ROW}>
                <th className={CELL} scope="col">
                  Time
                </th>
                <th className={CELL} scope="col">
                  Symbol
                </th>
                <th className={CELL} scope="col">
                  Side
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Qty
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Price
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Commission
                </th>
                <th className={cn(CELL, "text-right")} scope="col">
                  Realized
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((execution) => {
                return (
                  <tr
                    className="border-border border-b last:border-b-0"
                    data-exec-id={execution.execId}
                    key={execution.execId}
                  >
                    <td className={CELL}>{executionClock(execution.time)}</td>
                    <th
                      className={cn(CELL, "text-left font-semibold")}
                      scope="row"
                    >
                      <TableScrollText text={execution.symbol} />
                    </th>
                    <td className={cn(CELL, SIDE_CLASS(execution.side))}>
                      {execution.side}
                    </td>
                    <td className={cn(CELL, "text-right")}>
                      {qty(execution.shares)}
                    </td>
                    <td className={cn(CELL, "text-right")}>
                      {price(execution.price)}
                    </td>
                    <td className={cn(CELL, "text-right")}>
                      {usd(execution.commission, 2)}
                    </td>
                    <td
                      className={cn(
                        CELL,
                        "text-right",
                        pnlClass(execution.realized)
                      )}
                    >
                      {execution.realized
                        ? signed(execution.realized, 2)
                        : DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
};
