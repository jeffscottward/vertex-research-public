// What: the Cmd+K palette model: a command registry (chart, options, stock, analytics), a parser
// for typed commands such as "chart NVDA 1W" or "options AAPL 2026-12-19", and paletteGroups,
// the ordered entry groups for one query. Pure: no React, no DOM.
// Used by: apps/web/src/components/command-palette.tsx.
// See: apps/web/src/features/stock-detail/url-state.ts (stock URL state),
// apps/web/src/components/portal/charts-workspace.tsx (/charts?symbol=&interval=).

import { defaultFilter } from "cmdk";

import {
  CHART_INTERVALS,
  type ChartInterval,
  DEFAULT_CHART_INTERVAL,
  isChartInterval,
} from "../features/charts/chart-intervals.ts";
import {
  isRealDay,
  type StockTab,
  stockQueryString,
} from "../features/stock-detail/url-state.ts";
import { isTickerQuery, tickerHref } from "./ticker-href.ts";

/** One page the palette can open. */
export type PaletteItem = Readonly<{
  label: string;
  href: string;
  group: string;
}>;

/**
 * One palette row. "go" opens href; "complete" replaces the query with fill (a command
 * template); "hint" explains a wrong command and cannot be selected. id is unique per query.
 */
export type PaletteEntry =
  | Readonly<{
      kind: "go";
      id: string;
      label: string;
      detail: string;
      href: string;
    }>
  | Readonly<{
      kind: "complete";
      id: string;
      label: string;
      hint: string;
      fill: string;
    }>
  | Readonly<{ kind: "hint"; id: string; label: string }>;

export type PaletteGroup = Readonly<{
  heading: string;
  entries: readonly PaletteEntry[];
}>;

type CommandId = "chart" | "options" | "stock" | "analytics";
type ParamKind = "interval" | "expiry" | "none";

type PaletteCommand = Readonly<{
  id: CommandId;
  // Lower case; the first name is the one a completion fills in.
  names: readonly [string, ...string[]];
  title: string;
  usage: string;
  param: ParamKind;
  // value is a parsed interval or expiry, or null when the user gave none.
  target: (
    symbol: string,
    value: string | null
  ) => { label: string; href: string };
}>;

const stockHref = (
  symbol: string,
  tab: StockTab,
  query: Readonly<{ interval?: ChartInterval; expiry?: string }> = {}
): string =>
  `${tickerHref(symbol)}${stockQueryString({
    expiry: query.expiry ?? null,
    interval: query.interval ?? DEFAULT_CHART_INTERVAL,
    tab,
  })}`;

const chartsHref = (symbol: string, interval: ChartInterval): string => {
  const params = new URLSearchParams({ symbol });
  if (interval !== DEFAULT_CHART_INTERVAL) params.set("interval", interval);
  return `/charts?${params.toString()}`;
};

// Values reach target() only after parseParam accepted them for the command's param kind.
const asInterval = (value: string | null): ChartInterval =>
  value === null ? DEFAULT_CHART_INTERVAL : (value as ChartInterval);

// The command registry; COMMAND_LIST is the order the palette lists command templates in.
const COMMANDS: Readonly<Record<CommandId, PaletteCommand>> = {
  analytics: {
    id: "analytics",
    names: ["analytics"],
    param: "none",
    target: (symbol) => ({
      href: stockHref(symbol, "analytics"),
      label: `Analytics ${symbol}`,
    }),
    title: "Analytics",
    usage: "analytics <ticker>",
  },
  chart: {
    id: "chart",
    names: ["chart", "charts", "c"],
    param: "interval",
    target: (symbol, value) => ({
      href: chartsHref(symbol, asInterval(value)),
      label: `Chart ${symbol} · ${asInterval(value)}`,
    }),
    title: "Chart",
    usage: "chart <ticker> [interval]",
  },
  options: {
    id: "options",
    names: ["options", "option", "opt", "o"],
    param: "expiry",
    target: (symbol, value) => ({
      href: stockHref(
        symbol,
        "options",
        value === null ? {} : { expiry: value }
      ),
      label: `Options ${symbol} · ${value ?? "nearest expiry"}`,
    }),
    title: "Options",
    usage: "options <ticker> [YYYY-MM-DD]",
  },
  stock: {
    id: "stock",
    names: ["stock", "quote", "s"],
    param: "interval",
    target: (symbol, value) => ({
      href: stockHref(symbol, "chart", { interval: asInterval(value) }),
      label: value === null ? `Open ${symbol}` : `Open ${symbol} · ${value}`,
    }),
    title: "Stock",
    usage: "stock <ticker> [interval]",
  },
};
const COMMAND_LIST = [
  COMMANDS.chart,
  COMMANDS.options,
  COMMANDS.stock,
  COMMANDS.analytics,
];

const INTERVAL_WORDS: Readonly<Record<string, ChartInterval>> = {
  daily: "1D",
  day: "1D",
  hour: "1h",
  month: "1M",
  monthly: "1M",
  week: "1W",
  weekly: "1W",
};

/**
 * A typed interval: exact first (1m is a minute, 1M a month), then a case-insensitive match
 * when only one interval fits ("1d" -> 1D, "1H" -> 1h), then words such as "weekly".
 */
const parseInterval = (token: string): ChartInterval | null => {
  if (isChartInterval(token)) return token;
  const lower = token.toLowerCase();
  const [only, ...others] = CHART_INTERVALS.filter(
    (interval) => interval.toLowerCase() === lower
  );
  if (only !== undefined && others.length === 0) return only;
  // Own keys only, so "constructor" is not read from Object.prototype.
  return Object.hasOwn(INTERVAL_WORDS, lower)
    ? (INTERVAL_WORDS[lower] as ChartInterval)
    : null;
};

const INTERVAL_LIST = CHART_INTERVALS.join(" ");

type ParamResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; problem: string }>;

const PARAM_PARSERS: Readonly<
  Record<ParamKind, (token: string) => ParamResult>
> = {
  expiry: (token) =>
    isRealDay(token)
      ? { ok: true, value: token }
      : {
          ok: false,
          problem: `"${token}" is not a date: use YYYY-MM-DD, e.g. 2026-12-19`,
        },
  interval: (token) => {
    const interval = parseInterval(token);
    return interval === null
      ? {
          ok: false,
          problem: `"${token}" is not an interval: ${INTERVAL_LIST}`,
        }
      : { ok: true, value: interval };
  },
  none: (token) => ({ ok: false, problem: `"${token}" is not expected` }),
};

const completeEntry = (command: PaletteCommand): PaletteEntry => ({
  fill: `${command.names[0]} `,
  hint: command.usage,
  id: `complete:${command.id}`,
  kind: "complete",
  label: command.title,
});

const hintEntry = (command: PaletteCommand, problem: string): PaletteEntry => ({
  id: `hint:${command.id}`,
  kind: "hint",
  label: `${problem}. Use: ${command.usage}`,
});

const goEntry = (
  idPrefix: string,
  command: PaletteCommand,
  symbol: string,
  value: string | null
): PaletteEntry => {
  const { href, label } = command.target(symbol, value);
  return {
    detail: href,
    href,
    id: `${idPrefix}:${command.id}`,
    kind: "go",
    label,
  };
};

/** The one entry for an explicit command: a completion, a hint or a page to open. */
const commandEntry = (
  command: PaletteCommand,
  args: readonly string[]
): PaletteEntry => {
  const [ticker, param, ...extra] = args;
  if (ticker === undefined) return completeEntry(command);
  if (!isTickerQuery(ticker))
    return hintEntry(command, `"${ticker}" is not a ticker`);
  if (extra.length > 0)
    return hintEntry(command, `Too many words after "${param}"`);
  const symbol = ticker.toUpperCase();
  if (param === undefined) return goEntry("command", command, symbol, null);
  const parsed = PARAM_PARSERS[command.param](param);
  if (!parsed.ok) return hintEntry(command, parsed.problem);
  return goEntry("command", command, symbol, parsed.value);
};

// Bare ticker forms, in order: the stock page (label "Open <TICKER>"), its chart, its options.
const tickerEntries = (
  symbol: string,
  interval: ChartInterval | null
): PaletteEntry[] =>
  [COMMANDS.stock, COMMANDS.chart, COMMANDS.options].map((command) =>
    goEntry(
      "ticker",
      command,
      symbol,
      command.param === "interval" ? interval : null
    )
  );

// cmdk scores: about 0.9-1 for a word prefix ("port" in Portfolio), about 0.17 for spaced
// initials ("bkt" in Backtests), about 0.02 for letters scattered over label, group and path
// ("nvda" in "Mission control Overview /dashboard"). Below MIN_PAGE_SCORE a page is noise.
const MIN_PAGE_SCORE = 0.1;
// At or above this score a page beats a ticker of the same text ("audit" opens /audit).
const STRONG_PAGE_SCORE = 0.5;

type ScoredPage = Readonly<{ item: PaletteItem; score: number }>;

/** Pages that fuzzy-match the query (cmdk's scorer on label, group and path), best first. */
const matchPages = (
  items: readonly PaletteItem[],
  query: string
): ScoredPage[] => {
  const needle = query.trim();
  if (needle === "") return items.map((item) => ({ item, score: 1 }));
  return items
    .map((item) => ({
      item,
      score: defaultFilter(`${item.label} ${item.group} ${item.href}`, needle),
    }))
    .filter(({ score }) => score >= MIN_PAGE_SCORE)
    .sort((left, right) => right.score - left.score);
};

const group = (
  heading: string,
  entries: readonly PaletteEntry[]
): PaletteGroup[] => (entries.length === 0 ? [] : [{ entries, heading }]);

/**
 * Ordered groups for a query:
 * - empty: every command template, then every page;
 * - a command with its ticker ("chart nvda 1w"): that command, then matching pages;
 * - anything else: commands whose name starts with the text ("ch"), then "Open <TICKER>"
 *   with chart and options when the text is a ticker, optionally with an interval
 *   ("NVDA 1W"), and matching pages. Pages come before the ticker only when one matches
 *   strongly ("audit"), so Enter on "nvda" opens NVDA.
 */
export const paletteGroups = (
  items: readonly PaletteItem[],
  query: string
): PaletteGroup[] => {
  const text = query.trim();
  const [first, ...rest] = text === "" ? [] : text.split(/\s+/u);
  const scored = matchPages(items, text);
  const pages = scored.map(
    ({ item }): PaletteEntry => ({
      detail: item.group,
      href: item.href,
      id: `page:${item.group}:${item.href}`,
      kind: "go",
      label: item.label,
    })
  );
  if (first === undefined)
    return [
      ...group("Commands", COMMAND_LIST.map(completeEntry)),
      ...group("Pages", pages),
    ];
  const name = first.toLowerCase();
  const [second, ...more] = rest;
  const interval =
    second !== undefined && more.length === 0 ? parseInterval(second) : null;
  const tickerForm =
    isTickerQuery(first) && (second === undefined || interval !== null);
  const command = COMMAND_LIST.find((entry) => entry.names.includes(name));
  const commandResult =
    command === undefined ? undefined : commandEntry(command, rest);
  // A command name can also be a ticker ("c" is Citigroup, "opt" a listed symbol). Without a
  // ticker after it ("c", "c 1w"), the general path below offers both the template and the
  // ticker. Longer names with a wrong argument ("chart 1y") keep their hint.
  const tickerWins =
    tickerForm &&
    commandResult?.kind !== "go" &&
    (second === undefined || name.length === 1);
  if (commandResult !== undefined && !tickerWins)
    return [...group("Commands", [commandResult]), ...group("Pages", pages)];
  const completions =
    second === undefined
      ? COMMAND_LIST.filter((entry) =>
          entry.names.some((alias) => alias.startsWith(name))
        ).map(completeEntry)
      : [];
  const ticker = group(
    "Ticker",
    tickerForm ? tickerEntries(first.toUpperCase(), interval) : []
  );
  const strongPage = (scored[0]?.score ?? 0) >= STRONG_PAGE_SCORE;
  return [
    ...group("Commands", completions),
    ...(strongPage
      ? [...group("Pages", pages), ...ticker]
      : [...ticker, ...group("Pages", pages)]),
  ];
};
