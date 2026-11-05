import type {
  PortfolioMonitorExecution,
  PortfolioMonitorOrder,
  PortfolioMonitorOutput,
  PortfolioMonitorPosition,
} from "@darkfactory/api";

// Pure formatting and derivation for the read-only IBKR monitor. No React, no I/O.

export const DASH = "—";

type Num = number | null | undefined;

const isFiniteNumber = (value: Num): value is number =>
  typeof value === "number" && Number.isFinite(value);

// ---------- numbers ----------

export const usd = (value: Num, digits = 0): string => {
  return isFiniteNumber(value)
    ? value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : DASH;
};

// Prices under 10 keep up to 4 decimals (options, low-priced stocks).
export const price = (value: Num): string => {
  return isFiniteNumber(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.abs(value) < 10 ? 4 : 2,
      })
    : DASH;
};

export const qty = (value: Num): string => {
  return isFiniteNumber(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : DASH;
};

export const pct = (value: Num, digits = 2): string => {
  return isFiniteNumber(value) ? `${value.toFixed(digits)}%` : DASH;
};

export const signed = (value: Num, digits = 0): string => {
  return isFiniteNumber(value)
    ? `${value > 0 ? "+" : ""}${usd(value, digits)}`
    : DASH;
};

export type PnlTone = "positive" | "negative" | "flat" | "none";

export const pnlTone = (value: Num): PnlTone => {
  if (!isFiniteNumber(value)) return "none";
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "flat";
};

export const PNL_TONE_CLASS: Readonly<Record<PnlTone, string>> = Object.freeze({
  positive: "text-success-foreground",
  negative: "text-destructive",
  flat: "",
  none: "",
});

export const pnlClass = (value: Num): string => PNL_TONE_CLASS[pnlTone(value)];

// ---------- time ----------

const parseTime = (
  value: string | number | null | undefined
): number | null => {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export const clock = (value: string | number | null | undefined): string => {
  const ms = parseTime(value);
  if (ms === null) return DASH;
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

export const ageSeconds = (
  value: string | null | undefined,
  nowMs: number
): number | null => {
  const ms = parseTime(value);
  return ms === null ? null : Math.max(0, (nowMs - ms) / 1000);
};

// Local calendar day as YYYYMMDD (the IBKR completedTime prefix).
export const localDayKey = (date: Date): string => {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
};

// ---------- preferences ----------

export const REFRESH_INTERVALS = [5, 10, 15, 30] as const;
export const DEFAULT_REFRESH_INTERVAL = 10;

export const normalizeInterval = (value: unknown): number => {
  return typeof value === "number" &&
    (REFRESH_INTERVALS as readonly number[]).includes(value)
    ? value
    : DEFAULT_REFRESH_INTERVAL;
};

// Page-level sections: /portfolio shows one of these under its own tab strip.
export const MONITOR_SECTIONS = [
  "positions",
  "orders-stops",
  "pnl",
  "allocation",
  "options",
] as const;
export type MonitorSection = (typeof MONITOR_SECTIONS)[number];

// Option contracts: IBKR secType OPT (equity/index option) or FOP (future option).
export const isOptionPosition = (
  position: Readonly<{ secType: string }>
): boolean => /^(OPT|FOP)$/i.test(position.secType.trim());

// ---------- health ----------

export type HealthTone = "success" | "warning" | "destructive" | "neutral";
export type Health = Readonly<{ key: string; label: string; tone: HealthTone }>;

export type HealthInput = Readonly<{
  snapshot: PortfolioMonitorOutput | null;
  failureKind: string | null;
  nowMs: number;
  intervalS: number;
  // A request failed, but the failure is still inside its grace window (see failureVisible).
  retrying?: boolean;
}>;

// Data older than this is stale (same rule as the reference monitor).
export const staleAfterSeconds = (intervalS: number): number =>
  Math.max(30, intervalS * 3);

// A failed snapshot request is often transient: iOS Safari aborts fetches ("Load failed") when
// the page is suspended or the network changes, e.g. while the owner places an order in another
// app (2026-11-05). The server answered every request it got. So a failure is shown only after
// requests keep failing for this long; until then the page says "Updating" with the last data.
export const failureGraceMs = (intervalS: number): number =>
  Math.max(20_000, intervalS * 2000);

// Terminal failures (access, configuration, session) show at once; others after the grace window.
export const failureVisible = (
  input: Readonly<{
    kind: string;
    failingSince: number | null;
    nowMs: number;
    intervalS: number;
  }>
): boolean => {
  if (input.kind !== "unavailable" && input.kind !== "error") return true;
  if (input.failingSince === null) return true;
  return input.nowMs - input.failingSince >= failureGraceMs(input.intervalS);
};

export const monitorHealth = ({
  snapshot,
  failureKind,
  nowMs,
  intervalS,
  retrying = false,
}: HealthInput): Health => {
  if (failureKind === "not-configured")
    return { key: "not-configured", label: "Not configured", tone: "neutral" };
  if (failureKind === "forbidden")
    return {
      key: "forbidden",
      label: "Operator access required",
      tone: "neutral",
    };
  if (failureKind !== null)
    return {
      key: "unreachable",
      label: "Server unreachable",
      tone: "destructive",
    };
  if (snapshot === null)
    return { key: "loading", label: "Loading", tone: "neutral" };
  if (retrying) return { key: "updating", label: "Updating…", tone: "warning" };
  const { status } = snapshot;
  if (status.gateway === "starting")
    return { key: "starting", label: "Gateway starting", tone: "warning" };
  if (status.gateway !== "live" || !status.connected)
    return {
      key: "disconnected",
      label: "Gateway disconnected",
      tone: "destructive",
    };
  const age = ageSeconds(status.dataAsOf, nowMs);
  if (age === null || age > staleAfterSeconds(intervalS))
    return { key: "stale", label: "Stale", tone: "warning" };
  return { key: "live", label: "Live", tone: "success" };
};

export const accountLabel = (mode: string): string => {
  if (mode === "live") return "Live account · read-only";
  if (mode === "paper") return "Paper account · read-only";
  return "Account mode unknown";
};

// ---------- summary ----------

export type SummaryStat = Readonly<{
  key: string;
  label: string;
  value: string;
  sub: string | null;
  tone: PnlTone;
}>;

const ratio = (top: Num, bottom: Num): number | null => {
  return !(isFiniteNumber(top) && isFiniteNumber(bottom)) || bottom === 0
    ? null
    : top / bottom;
};

// Daily P&L as a percent of the net liquidation value at the start of the day.
export const dailyPnlPct = (daily: Num, nlv: Num): number | null => {
  return isFiniteNumber(daily) && isFiniteNumber(nlv)
    ? ratio(daily * 100, nlv - daily)
    : null;
};

export const summaryStats = (
  snapshot: PortfolioMonitorOutput
): readonly SummaryStat[] => {
  const s = snapshot.summary;
  const { pnl } = snapshot;
  const nlv = s.netLiquidation;
  const daily = dailyPnlPct(pnl.daily, nlv);
  const grossShare = ratio(
    s.grossPositionValue === null ? null : s.grossPositionValue * 100,
    nlv
  );
  const marginUse = ratio(
    s.maintMarginReq === null ? null : s.maintMarginReq * 100,
    s.equityWithLoanValue
  );
  const plain = (
    key: string,
    label: string,
    value: Num,
    sub: string | null = null
  ): SummaryStat => ({ key, label, value: usd(value), sub, tone: "none" });
  const pnlStat = (
    key: string,
    label: string,
    value: Num,
    sub: string | null = null
  ): SummaryStat => ({
    key,
    label,
    value: signed(value),
    sub,
    tone: pnlTone(value),
  });
  return [
    plain("netLiquidation", "Net Liquidation", nlv),
    pnlStat(
      "daily",
      "Daily P&L",
      pnl.daily,
      daily === null ? null : `${pct(daily)} of start NLV`
    ),
    pnlStat("unrealized", "Unrealized P&L", pnl.unrealized),
    pnlStat("realized", "Realized P&L", pnl.realized),
    plain(
      "cash",
      "Cash",
      s.totalCashValue,
      s.settledCash === null ? null : `Settled ${usd(s.settledCash)}`
    ),
    plain(
      "grossPositionValue",
      "Gross Position Value",
      s.grossPositionValue,
      grossShare === null ? null : `${grossShare.toFixed(0)}% of NLV`
    ),
    plain("buyingPower", "Buying Power", s.buyingPower),
    plain("availableFunds", "Available Funds", s.availableFunds),
    plain(
      "excessLiquidity",
      "Excess Liquidity",
      s.excessLiquidity,
      s.cushion === null ? null : `Cushion ${(s.cushion * 100).toFixed(1)}%`
    ),
    plain("initMargin", "Initial Margin", s.initMarginReq),
    plain(
      "maintMargin",
      "Maintenance Margin",
      s.maintMarginReq,
      marginUse === null ? null : `${marginUse.toFixed(1)}% of equity`
    ),
    plain("equityWithLoan", "Equity w/ Loan", s.equityWithLoanValue),
  ];
};

// ---------- position columns ----------

export const POSITION_COLUMNS = [
  { id: "symbol", label: "Symbol", numeric: false },
  { id: "type", label: "Type", numeric: false },
  { id: "position", label: "Position", numeric: true },
  { id: "avgPrice", label: "Avg price", numeric: true },
  { id: "last", label: "Last", numeric: true },
  { id: "marketValue", label: "Market value", numeric: true },
  { id: "dailyPnl", label: "Daily P&L", numeric: true },
  { id: "unrealized", label: "Unrealized P&L", numeric: true },
  { id: "unrealizedPct", label: "Unrealized %", numeric: true },
  { id: "weightPct", label: "% of NLV", numeric: true },
  { id: "costBasis", label: "Cost basis", numeric: true },
  { id: "realized", label: "Realized P&L", numeric: true },
] as const;

export type PositionColumnId = (typeof POSITION_COLUMNS)[number]["id"];
export type PositionColumn = (typeof POSITION_COLUMNS)[number];
export type ColumnConfig = Readonly<{
  order: readonly PositionColumnId[];
  hidden: readonly PositionColumnId[];
}>;

export const COLUMN_BY_ID = Object.fromEntries(
  POSITION_COLUMNS.map((column) => [column.id, column])
) as Readonly<Record<PositionColumnId, PositionColumn>>;

export const COLUMNS_STORAGE_KEY = "vertex.monitor.columns.v1";
const COLUMN_IDS: readonly string[] = POSITION_COLUMNS.map(
  (column) => column.id
);
const isColumnId = (value: unknown): value is PositionColumnId => {
  return typeof value === "string" && COLUMN_IDS.includes(value);
};

export const DEFAULT_COLUMN_CONFIG: ColumnConfig = Object.freeze({
  order: POSITION_COLUMNS.map((column) => column.id),
  hidden: ["costBasis", "realized"] as PositionColumnId[],
});

const idList = (value: unknown): PositionColumnId[] => {
  return Array.isArray(value) ? [...new Set(value.filter(isColumnId))] : [];
};

// Keeps a stored layout valid when columns are added or removed in code.
// Unknown ids are dropped, new columns are appended, and Symbol can never be hidden.
export const normalizeColumnConfig = (value: unknown): ColumnConfig => {
  if (typeof value !== "object" || value === null) return DEFAULT_COLUMN_CONFIG;
  const known = idList(Reflect.get(value, "order"));
  const missing = POSITION_COLUMNS.map((column) => column.id).filter(
    (id) => !known.includes(id)
  );
  const hidden = Array.isArray(Reflect.get(value, "hidden"))
    ? idList(Reflect.get(value, "hidden")).filter((id) => id !== "symbol")
    : [...DEFAULT_COLUMN_CONFIG.hidden];
  return { order: [...known, ...missing], hidden };
};

export const toggleColumn = (
  config: ColumnConfig,
  id: PositionColumnId
): ColumnConfig => {
  if (id === "symbol") return config;
  const hidden = config.hidden.includes(id)
    ? config.hidden.filter((item) => item !== id)
    : [...config.hidden, id];
  return { order: config.order, hidden };
};

export const moveColumn = (
  config: ColumnConfig,
  index: number,
  delta: number
): ColumnConfig => {
  const target = index + delta;
  const moved = config.order[index];
  const other = config.order[target];
  if (moved === undefined || other === undefined) return config;
  const order = [...config.order];
  order[index] = other;
  order[target] = moved;
  return { order, hidden: config.hidden };
};

export const visibleColumns = (
  config: ColumnConfig
): readonly PositionColumn[] => {
  return config.order
    .filter((id) => !config.hidden.includes(id))
    .map((id) => POSITION_COLUMNS.find((column) => column.id === id))
    .filter((column): column is PositionColumn => column !== undefined);
};

// ---------- position sort and totals ----------

export type SortState = Readonly<{ id: PositionColumnId; dir: 1 | -1 }>;
export const DEFAULT_SORT: SortState = Object.freeze({
  id: "marketValue",
  dir: -1,
});

export const normalizeSort = (value: unknown): SortState => {
  if (typeof value !== "object" || value === null) return DEFAULT_SORT;
  const id = Reflect.get(value, "id");
  const dir = Reflect.get(value, "dir");
  return isColumnId(id) && (dir === 1 || dir === -1)
    ? { id, dir }
    : DEFAULT_SORT;
};

// Same column flips direction; a new column starts descending.
export const nextSort = (sort: SortState, id: PositionColumnId): SortState => {
  return sort.id === id
    ? { id, dir: sort.dir === 1 ? -1 : 1 }
    : { id, dir: -1 };
};

// Display name: the IBKR description (for example an option local symbol), else the symbol.
export const positionName = (position: PortfolioMonitorPosition): string => {
  return position.description || position.symbol;
};

// ---------- holding type ----------

export type HoldingKind = "Shares" | "Contract" | "Other";
const SHARE_TYPES: readonly string[] = ["STK", "ETF", "ETP", "FUND"];
const CONTRACT_TYPES: readonly string[] = ["OPT", "FOP", "FUT", "WAR", "IOPT"];

// Shares for stock/ETF positions, Contract for options and futures; unknown IBKR types stay "Other".
export const holdingKind = (secType: string): HoldingKind => {
  const code = secType.trim().toUpperCase();
  if (SHARE_TYPES.includes(code)) return "Shares";
  if (CONTRACT_TYPES.includes(code)) return "Contract";
  return "Other";
};

// OCC option symbol tail: YYMMDD, C or P, 8-digit strike (for example "SPY   261218C00500000").
const OCC_OPTION = /(\d{2})(\d{2})(\d{2})([CP])\d{8}\s*$/u;

// Display label: "Shares", "Call 2026-12-18" / "Put …" when the option symbol shows it, else "Contract".
export const holdingLabel = (position: PortfolioMonitorPosition): string => {
  const kind = holdingKind(position.secType);
  if (kind === "Other") return position.secType || DASH;
  if (kind === "Shares") return kind;
  const match = OCC_OPTION.exec(position.description);
  if (match === null) return kind;
  const [, yy, mm, dd, right] = match;
  return `${right === "C" ? "Call" : "Put"} 20${yy}-${mm}-${dd}`;
};

// Any option right at the end of the name: OCC tail or the feed form "IWM 20261113 285 C".
const TRAILING_RIGHT = /(?:\d{6}([CP])\d{8}|\s([CP]))\s*$/u;

export type HoldingBadge = Readonly<{
  text: string;
  label: string;
  tone: "long" | "short" | "flat";
}>;

// Compact Type badge: shares "STK +L" / "STK -S", options "+C" / "-P"; the full words stay in label.
export const holdingBadge = (
  position: PortfolioMonitorPosition
): HoldingBadge => {
  const qtyValue = position.position;
  const tone = qtyValue > 0 ? "long" : qtyValue < 0 ? "short" : "flat";
  const sideWord =
    tone === "long" ? "Long" : tone === "short" ? "Short" : "Flat";
  const sign = tone === "long" ? "+" : tone === "short" ? "-" : "";
  const kind = holdingKind(position.secType);
  const full = holdingLabel(position);
  if (kind === "Shares") {
    const tag = tone === "long" ? " +L" : tone === "short" ? " -S" : "";
    return { text: `STK${tag}`, label: `${sideWord} shares`, tone };
  }
  const match = TRAILING_RIGHT.exec(positionName(position));
  const right = match?.[1] ?? match?.[2];
  if (kind === "Contract" && right !== undefined) {
    const rightWord = right === "C" ? "Call" : "Put";
    const word = full.startsWith(rightWord) ? full : rightWord;
    return { text: `${sign}${right}`, label: `${sideWord} ${word}`, tone };
  }
  const code = position.secType.trim().toUpperCase() || DASH;
  return { text: `${sign}${code}`, label: `${sideWord} ${full}`, tone };
};

const sortValue = (
  position: PortfolioMonitorPosition,
  id: PositionColumnId
): number | string => {
  if (id === "symbol") return positionName(position);
  if (id === "type") return holdingKind(position.secType);
  return position[id] ?? 0;
};

export const sortPositions = (
  positions: readonly PortfolioMonitorPosition[],
  sort: SortState
): PortfolioMonitorPosition[] => {
  return [...positions].sort((left, right) => {
    const a = sortValue(left, sort.id);
    const b = sortValue(right, sort.id);
    const order =
      typeof a === "string" || typeof b === "string"
        ? String(a).localeCompare(String(b))
        : a - b;
    // Ties keep a stable symbol order, so a Type sort lists each group A-Z.
    return (
      order * sort.dir || positionName(left).localeCompare(positionName(right))
    );
  });
};

export type PositionTotals = Readonly<{
  marketValue: number;
  dailyPnl: number;
  unrealized: number;
  weightPct: number;
  costBasis: number;
  realized: number;
}>;

export const positionTotals = (
  positions: readonly PortfolioMonitorPosition[]
): PositionTotals => {
  const sum = (pick: (position: PortfolioMonitorPosition) => Num): number => {
    return positions.reduce(
      (total, position) => total + (pick(position) ?? 0),
      0
    );
  };
  return {
    marketValue: sum((position) => position.marketValue),
    dailyPnl: sum((position) => position.dailyPnl),
    unrealized: sum((position) => position.unrealized),
    weightPct: sum((position) => position.weightPct),
    costBasis: sum((position) => position.costBasis),
    realized: sum((position) => position.realized),
  };
};

// ---------- orders ----------

const PRESUBMITTED_EXPLANATION =
  "Accepted by IBKR and held on IBKR servers. IBKR sends it to the exchange when the stop price triggers.";
const SUBMITTED_EXPLANATION = "The order is resting at the exchange.";

export const orderStatusLabel = (status: string): string => {
  if (status === "PreSubmitted") return "Held at IBKR";
  if (status === "Submitted") return "At exchange";
  return status || DASH;
};

export const orderStatusTitle = (status: string): string | undefined => {
  if (status === "PreSubmitted") return PRESUBMITTED_EXPLANATION;
  if (status === "Submitted") return SUBMITTED_EXPLANATION;
  return undefined;
};

export type StatusTone =
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "neutral";

export const orderStatusTone = (status: string): StatusTone => {
  if (/filled/iu.test(status)) return "success";
  if (/cancel|inactive|reject/iu.test(status)) return "destructive";
  if (/presubmitted|pending/iu.test(status)) return "warning";
  if (/submitted/iu.test(status)) return "info";
  return "neutral";
};

export type OrderRow = Readonly<{
  order: PortfolioMonitorOrder;
  depth: number;
}>;
export type OrderGroup = Readonly<{
  symbol: string;
  rows: readonly OrderRow[];
}>;

// Highest stop (or limit) first, so a stop ladder reads from top to bottom.
const trigger = (order: PortfolioMonitorOrder): number =>
  order.stopPrice ?? order.limitPrice ?? 0;
const byTriggerDesc = (
  left: PortfolioMonitorOrder,
  right: PortfolioMonitorOrder
): number => trigger(right) - trigger(left);

// Groups orders by symbol (A to Z) and nests child orders under their parent.
// A child whose parent is not in the list shows as a top-level row.
export const groupOrders = (
  orders: readonly PortfolioMonitorOrder[]
): readonly OrderGroup[] => {
  const keys = new Set(orders.map((order) => order.key));
  const children = new Map<string, PortfolioMonitorOrder[]>();
  const roots: PortfolioMonitorOrder[] = [];
  for (const order of orders) {
    if (
      order.parentKey !== null &&
      order.parentKey !== order.key &&
      keys.has(order.parentKey)
    ) {
      children.set(order.parentKey, [
        ...(children.get(order.parentKey) ?? []),
        order,
      ]);
    } else {
      roots.push(order);
    }
  }
  const seen = new Set<string>();
  const walk = (order: PortfolioMonitorOrder, depth: number): OrderRow[] => {
    if (seen.has(order.key)) return [];
    seen.add(order.key);
    const nested = [...(children.get(order.key) ?? [])]
      .sort(byTriggerDesc)
      .flatMap((child) => walk(child, depth + 1));
    return [{ order, depth }, ...nested];
  };
  const bySymbol = new Map<string, PortfolioMonitorOrder[]>();
  for (const root of roots) {
    bySymbol.set(root.symbol, [...(bySymbol.get(root.symbol) ?? []), root]);
  }
  return [...bySymbol.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbol, symbolRoots]) => ({
      symbol,
      rows: [...symbolRoots]
        .sort(byTriggerDesc)
        .flatMap((root) => walk(root, 0)),
    }));
};

// Completed or cancelled today (local day). Orders without a completion time are kept,
// because IBKR does not always send one for cancelled orders.
export const completedToday = (
  orders: readonly PortfolioMonitorOrder[],
  now: Date
): PortfolioMonitorOrder[] => {
  const today = localDayKey(now);
  return orders.filter(
    (order) =>
      order.completedTime === "" || order.completedTime.startsWith(today)
  );
};

// IBKR completedTime looks like "YYYYMMDD HH:MM:SS zone"; show the clock part.
export const completedClock = (completedTime: string): string => {
  return IBKR_TIME.exec(completedTime.trim())?.[2] ?? completedTime;
};

export const completedReason = (completedStatus: string): string => {
  return completedStatus.replace(/[\n:][\s\S]*$/u, "").trim();
};

// ---------- executions ----------

// IBKR execution and completion times look like "YYYYMMDD HH:MM:SS[ TZ]" (sometimes "YYYYMMDD-HH:MM:SS").
const IBKR_TIME = /^(\d{8})[ -](\d{2}:\d{2}:\d{2})(?:\s+(\S.*))?$/u;

// Sortable "YYYYMMDD HH:MM:SS" key, or null when the text is not in IBKR format.
export const ibkrTimeKey = (time: string): string | null => {
  const match = IBKR_TIME.exec(time.trim());
  return match === null ? null : `${match[1]} ${match[2]}`;
};

// Newest first by IBKR time. Rows without a readable time keep reverse arrival order.
export const executionsNewestFirst = (
  executions: readonly PortfolioMonitorExecution[]
): PortfolioMonitorExecution[] => {
  return executions
    .map((execution, index) => ({
      execution,
      index,
      key: ibkrTimeKey(execution.time),
    }))
    .sort((left, right) => {
      if (left.key !== null && right.key !== null && left.key !== right.key)
        return right.key.localeCompare(left.key);
      return right.index - left.index;
    })
    .map((entry) => entry.execution);
};

// Clock part of an IBKR time, with its zone when IBKR sends one.
export const executionClock = (time: string): string => {
  const match = IBKR_TIME.exec(time.trim());
  if (match === null) return time;
  return match[3] === undefined ? `${match[2]}` : `${match[2]} ${match[3]}`;
};

// ---------- stop ladders ----------

export type StopLadder = Readonly<{
  position: PortfolioMonitorPosition;
  exitSide: "SELL" | "BUY";
  rungs: readonly PortfolioMonitorOrder[];
  // Rungs paired with their (non-null) stop price, highest first.
  stops: readonly Readonly<{ order: PortfolioMonitorOrder; stop: number }>[];
  coveredQty: number;
  nearest: Readonly<{
    stop: number;
    pct: number;
    side: "below" | "above";
  }> | null;
}>;

// Stop rungs: open orders on the same contract, on the exit side, with a stop price. Highest first.
export const stopLadder = (
  position: PortfolioMonitorPosition,
  orders: readonly PortfolioMonitorOrder[]
): StopLadder => {
  const exitSide = position.position > 0 ? "SELL" : "BUY";
  const stopped = orders
    .flatMap((order) =>
      order.conId === position.id &&
      order.action === exitSide &&
      order.stopPrice !== null
        ? [{ order, stop: order.stopPrice }]
        : []
    )
    .sort((left, right) => right.stop - left.stop);
  const rungs = stopped.map((entry) => entry.order);
  const coveredQty = rungs.reduce(
    (total, order) => total + (order.remaining ?? order.qty ?? 0),
    0
  );
  const last = position.last;
  let nearest: StopLadder["nearest"] = null;
  if (last !== null && last !== 0 && rungs.length > 0) {
    const stops = stopped.map((entry) => entry.stop);
    if (exitSide === "SELL") {
      const below = stops.filter((stop) => stop <= last);
      if (below.length > 0) {
        const stop = Math.max(...below);
        nearest = { stop, pct: ((last - stop) / last) * 100, side: "below" };
      }
    } else {
      const above = stops.filter((stop) => stop >= last);
      if (above.length > 0) {
        const stop = Math.min(...above);
        nearest = { stop, pct: ((stop - last) / last) * 100, side: "above" };
      }
    }
  }
  return { position, exitSide, rungs, stops: stopped, coveredQty, nearest };
};

export type LadderScale = Readonly<{
  low: number;
  high: number;
  at: (value: number) => number;
}>;

// Maps prices to 0..100 % with a small pad so marks never sit on the edge.
export const ladderScale = (ladder: StopLadder): LadderScale | null => {
  const points = [
    ladder.position.last,
    ladder.position.avgPrice,
    ...ladder.rungs.map((order) => order.stopPrice),
  ].filter(
    (value): value is number => value !== null && Number.isFinite(value)
  );
  if (points.length === 0) return null;
  const low = Math.min(...points);
  const high = Math.max(...points);
  const pad = (high - low) * 0.08 || Math.abs(high) * 0.02 || 1;
  const start = low - pad;
  const end = high + pad;
  return { low, high, at: (value) => ((value - start) / (end - start)) * 100 };
};

// ---------- charts ----------

export const CASH_SLICE = "Cash / other";

export type AllocationSlice = Readonly<{
  name: string;
  value: number;
  pctOfNlv: number | null;
}>;

export const allocationSlices = (
  positions: readonly PortfolioMonitorPosition[],
  nlv: Num
): readonly AllocationSlice[] => {
  const total = isFiniteNumber(nlv) && nlv > 0 ? nlv : null;
  const share = (value: number): number | null =>
    total === null ? null : (value / total) * 100;
  const held = positions
    .flatMap((position) => {
      const value = position.marketValue ?? 0;
      return value > 0 ? [{ name: positionName(position), value }] : [];
    })
    .sort((left, right) => right.value - left.value);
  const invested = held.reduce((sum, slice) => sum + slice.value, 0);
  const slices = held.map((slice) => ({
    ...slice,
    pctOfNlv: share(slice.value),
  }));
  if (total !== null && total > invested) {
    slices.push({
      name: CASH_SLICE,
      value: total - invested,
      pctOfNlv: share(total - invested),
    });
  }
  return slices;
};

export type PnlBar = Readonly<{
  name: string;
  unrealized: number;
  daily: number;
}>;

export const pnlBars = (
  positions: readonly PortfolioMonitorPosition[]
): readonly PnlBar[] => {
  return positions
    .map((position) => ({
      name: position.symbol,
      unrealized: Math.round(position.unrealized ?? 0),
      daily: Math.round(position.dailyPnl ?? 0),
    }))
    .sort((left, right) => right.unrealized - left.unrealized);
};

// SVG donut segment from startAngle to endAngle (radians, 0 = top, clockwise).
export const donutArc = (
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startAngle: number,
  endAngle: number
): string => {
  const sweep = Math.min(endAngle - startAngle, Math.PI * 2 - 0.0001);
  const end = startAngle + sweep;
  const point = (radius: number, angle: number) =>
    [cx + radius * Math.sin(angle), cy - radius * Math.cos(angle)] as const;
  const [x0, y0] = point(outer, startAngle);
  const [x1, y1] = point(outer, end);
  const [x2, y2] = point(inner, end);
  const [x3, y3] = point(inner, startAngle);
  const large = sweep > Math.PI ? 1 : 0;
  const f = (value: number) => value.toFixed(3);
  return `M${f(x0)} ${f(y0)}A${outer} ${outer} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${inner} ${inner} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
};

export const isGatewayLive = (snapshot: PortfolioMonitorOutput): boolean => {
  return snapshot.status.gateway === "live" && snapshot.status.connected;
};
