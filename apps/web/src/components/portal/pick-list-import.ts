import {
  PICK_LIST_MAX_MEMBERS,
  type PickListImportInput,
  PickListMemberInputSchema,
} from "@darkfactory/api";

// Manual pick-list import: the owner pastes or uploads a list he copied or exported by hand.
// This module only parses text. It never fetches a site; no automated access to any source.

export type PickListImportMember = PickListImportInput["members"][number];

export type PickListImportReject = Readonly<{
  line: number;
  text: string;
  reason: string;
}>;

export type PickListImportParse = Readonly<{
  members: readonly PickListImportMember[];
  rejects: readonly PickListImportReject[];
}>;

type Column =
  | "symbol"
  | "weight"
  | "rank"
  | "addedOn"
  | "rating"
  | "sector"
  | "targetPrice";

const HEADER_ALIASES: Readonly<Record<string, Column>> = {
  "#": "rank",
  "% weight": "weight",
  added: "addedOn",
  "added on": "addedOn",
  allocation: "weight",
  code: "symbol",
  date: "addedOn",
  "date added": "addedOn",
  "entry date": "addedOn",
  "portfolio weight": "weight",
  "price target": "targetPrice",
  rank: "rank",
  rating: "rating",
  sector: "sector",
  "stock symbol": "symbol",
  symbol: "symbol",
  target: "targetPrice",
  "target price": "targetPrice",
  ticker: "symbol",
  weight: "weight",
  "weight %": "weight",
};

const DELIMITERS = ["\t", ",", ";"] as const;

/** Split one delimited line; double quotes group a cell and "" is a literal quote. */
export const splitCells = (line: string, delimiter: string): string[] => {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (char === '"' && quoted && line.charAt(index + 1) === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
};

/** "$aapl", "NASDAQ:AAPL", "brk.b" → upper-case ticker text (validated later). */
export const cleanSymbol = (raw: string): string =>
  raw
    .trim()
    .replace(/^[A-Za-z]+:/u, "")
    .replace(/^\$/u, "")
    .toUpperCase();

/**
 * One weight cell as a fraction. `percent` is decided once per column (see isPercentColumn), so
 * "5", "1" and "0.5" in one percent column are 5%, 1% and 0.5%. Null when not a weight.
 */
export const parseWeight = (raw: string, percent: boolean): number | null => {
  const text = raw.replace("%", "").replace(",", ".").trim();
  if (!/^\d+(\.\d+)?$/u.test(text)) return null;
  const fraction = percent ? Number(text) / 100 : Number(text);
  return fraction <= 1 ? fraction : null;
};

/** A weight column is percent when its header or any cell has "%", or any value is above 1. */
export const isPercentColumn = (
  header: string,
  cells: readonly string[]
): boolean =>
  header.includes("%") ||
  cells.some((cell) => cell.includes("%") || Number(cell) > 1);

/** "2026-11-05" or "11/5/2026" → "2026-11-05". Null when not a real calendar date. */
export const parseDate = (raw: string): string | null => {
  const text = raw.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(text);
  const iso =
    us === null
      ? text
      : `${us[3]}-${us[1]?.padStart(2, "0")}-${us[2]?.padStart(2, "0")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === iso
    ? iso
    : null;
};

const parsePrice = (raw: string): number | null => {
  const text = raw.replaceAll(/[$,]/gu, "").trim();
  return /^\d+(\.\d+)?$/u.test(text) ? Number(text) : null;
};

const headerColumns = (
  cells: readonly string[]
): Map<number, Column> | null => {
  const map = new Map<number, Column>();
  cells.forEach((cell, index) => {
    const column = HEADER_ALIASES[cell.toLowerCase()];
    if (column !== undefined && ![...map.values()].includes(column))
      map.set(index, column);
  });
  return [...map.values()].includes("symbol") ? map : null;
};

type Row = Readonly<{
  line: number;
  text: string;
  fields: Partial<Record<Column, string>>;
  /** Weight column holds percents. */
  percent: boolean;
  /** Set when the cell is reported as rejected without parsing. */
  reason?: string;
}>;

/** Cells that look like tickers as typed (upper case, optional "$" or "EXCHANGE:"). */
const TICKER_CELL = /^(\$|[A-Za-z]+:)?[A-Z][A-Z0-9.-]{0,9}$/u;
const NO_HEADER_REASON =
  "Ignored: add a header row (Symbol, Weight, ...) to import this column";

const headerlessRows = (
  lines: readonly Readonly<{ line: number; text: string }>[],
  delimiter: string
): Row[] => {
  const cells = lines.flatMap(({ line, text }) =>
    splitCells(text, delimiter).map((cell, index) => ({ cell, index, line }))
  );
  const filled = cells.filter(({ cell }) => cell !== "");
  if (filled.every(({ cell }) => TICKER_CELL.test(cell)))
    return filled.map(({ cell, line }) => ({
      fields: { symbol: cell },
      line,
      percent: false,
      text: cell,
    }));
  return lines.flatMap(({ line, text }) =>
    splitCells(text, delimiter)
      .map((cell, index): Row | null =>
        index === 0
          ? { fields: { symbol: cell }, line, percent: false, text }
          : cell === ""
            ? null
            : {
                fields: {},
                line,
                percent: false,
                reason: NO_HEADER_REASON,
                text: cell,
              }
      )
      .filter((row): row is Row => row !== null)
  );
};

const tableRows = (
  lines: readonly Readonly<{ line: number; text: string }>[],
  delimiter: string
): Row[] => {
  const headerCells = lines
    .slice(0, 1)
    .flatMap((entry) => splitCells(entry.text, delimiter));
  const header = headerColumns(headerCells);
  if (header === null) return headerlessRows(lines, delimiter);
  const body = lines
    .slice(1)
    .map((entry) => ({ ...entry, cells: splitCells(entry.text, delimiter) }));
  const weightIndex = [...header].find(
    ([, column]) => column === "weight"
  )?.[0];
  const percent =
    weightIndex !== undefined &&
    isPercentColumn(
      headerCells.slice(weightIndex, weightIndex + 1).join(""),
      body.map(({ cells }) =>
        cells.slice(weightIndex, weightIndex + 1).join("")
      )
    );
  return body.map(({ cells, line, text }) => {
    const fields: Partial<Record<Column, string>> = {};
    for (const [index, column] of header) {
      const cell = cells[index];
      if (cell !== undefined && cell !== "") fields[column] = cell;
    }
    return { fields, line, percent, text };
  });
};

const tokenRows = (
  lines: readonly Readonly<{ line: number; text: string }>[]
): Row[] =>
  lines.flatMap(({ line, text }) =>
    text
      .split(/\s+/u)
      .filter((token) => token !== "")
      .map((token) => ({
        fields: { symbol: token },
        line,
        percent: false,
        text: token,
      }))
  );

const toMember = (
  { fields, percent }: Row,
  position: number
): PickListImportMember | string => {
  const symbol = cleanSymbol(fields.symbol ?? "");
  if (symbol === "") return "Missing ticker";
  const candidate: {
    -readonly [K in keyof PickListImportMember]: PickListImportMember[K];
  } = {
    rank: position,
    symbol,
  };
  if (fields.rank !== undefined) {
    const rank = Number(fields.rank.replace("#", ""));
    if (!Number.isInteger(rank) || rank < 1 || rank > 1000)
      return "Bad rank (1-1000)";
    candidate.rank = rank;
  }
  if (fields.weight !== undefined) {
    const weight = parseWeight(fields.weight, percent);
    if (weight === null) return "Bad weight";
    candidate.weight = weight;
  }
  if (fields.addedOn !== undefined) {
    const addedOn = parseDate(fields.addedOn);
    if (addedOn === null) return "Bad date (use YYYY-MM-DD or M/D/YYYY)";
    candidate.addedOn = addedOn;
  }
  if (fields.targetPrice !== undefined) {
    const target = parsePrice(fields.targetPrice);
    if (target === null || target <= 0) return "Bad target price";
    candidate.targetPrice = target;
  }
  if (fields.rating !== undefined) candidate.rating = fields.rating;
  if (fields.sector !== undefined) candidate.sector = fields.sector;
  const parsed = PickListMemberInputSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return parsed.error.issues.some((issue) => issue.path[0] === "symbol")
    ? `Not a ticker: ${symbol}`
    : "Invalid row";
};

/**
 * Parse pasted text or a CSV export into pick-list members.
 * Delimited text (tab, comma, semicolon) may have a header row with a Symbol/Ticker column;
 * without a header, cells that all look like tickers are each a ticker; otherwise the first
 * cell is the ticker and the other cells are reported as ignored. Undelimited text is a list of tickers split on spaces
 * and new lines. A line starting with "#" and holding no delimiter is a comment. Rejected rows are reported, not dropped.
 */
export const parsePickListText = (text: string): PickListImportParse => {
  const lines = text
    .split(/\r?\n/u)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter(
      (entry) =>
        entry.text !== "" &&
        !(entry.text.startsWith("#") && !/[\t,;]/u.test(entry.text))
    );
  // The delimiter that splits the first line into the most cells wins, so "5,5%" inside a
  // semicolon table does not make it a comma table.
  const first = lines[0]?.text ?? "";
  const count = (candidate: string) => splitCells(first, candidate).length;
  const best = DELIMITERS.reduce((current, candidate) =>
    count(candidate) > count(current) ? candidate : current
  );
  const delimiter =
    count(best) > 1
      ? best
      : DELIMITERS.find((candidate) =>
          lines.some((entry) => entry.text.includes(candidate))
        );
  const rows =
    delimiter === undefined ? tokenRows(lines) : tableRows(lines, delimiter);
  const members: PickListImportMember[] = [];
  const rejects: PickListImportReject[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const result = row.reason ?? toMember(row, members.length + 1);
    if (typeof result === "string")
      rejects.push({ line: row.line, reason: result, text: row.text });
    else if (seen.has(result.symbol))
      rejects.push({ line: row.line, reason: "Duplicate", text: row.text });
    else if (members.length >= PICK_LIST_MAX_MEMBERS)
      rejects.push({
        line: row.line,
        reason: `Over ${PICK_LIST_MAX_MEMBERS} members`,
        text: row.text,
      });
    else {
      seen.add(result.symbol);
      members.push(result);
    }
  }
  return { members, rejects };
};

/** "Moby Top Picks" → "moby-top-picks" (pick-list slug, at most 40 characters). */
export const slugifyListName = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");

/** Manual sources the import form offers. Slugs are data; no site is contacted. */
export const MANUAL_IMPORT_SOURCES = [
  { id: "moby", label: "Moby" },
  { id: "propicks", label: "ProPicks" },
  { id: "owner", label: "Other (owner list)" },
] as const;
