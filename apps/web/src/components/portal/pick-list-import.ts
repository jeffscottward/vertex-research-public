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

/** "5%", "5", "0.05" → 0.05. Values above 1 are percent. Null when not a weight. */
export const parseWeight = (raw: string): number | null => {
  const text = raw.replace("%", "").trim();
  if (!/^\d+(\.\d+)?$/u.test(text)) return null;
  const value = Number(text);
  const fraction = raw.includes("%") || value > 1 ? value / 100 : value;
  return fraction <= 1 ? fraction : null;
};

/** "2026-11-05" or "11/5/2026" → "2026-11-05". Null when not a date. */
export const parseDate = (raw: string): string | null => {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(text);
  if (us === null) return null;
  const [, month = "", day = "", year = ""] = us;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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
}>;

const tableRows = (
  lines: readonly Readonly<{ line: number; text: string }>[],
  delimiter: string
): Row[] => {
  const header = headerColumns(
    lines.slice(0, 1).flatMap((entry) => splitCells(entry.text, delimiter))
  );
  const columns = header ?? new Map<number, Column>([[0, "symbol"]]);
  const body = header === null ? lines : lines.slice(1);
  return body.map(({ line, text }) => {
    const cells = splitCells(text, delimiter);
    const fields: Partial<Record<Column, string>> = {};
    for (const [index, column] of columns) {
      const cell = cells[index];
      if (cell !== undefined && cell !== "") fields[column] = cell;
    }
    return { fields, line, text };
  });
};

const tokenRows = (
  lines: readonly Readonly<{ line: number; text: string }>[]
): Row[] =>
  lines.flatMap(({ line, text }) =>
    text
      .split(/\s+/u)
      .filter((token) => token !== "")
      .map((token) => ({ fields: { symbol: token }, line, text: token }))
  );

const toMember = (
  fields: Partial<Record<Column, string>>,
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
    if (!Number.isInteger(rank) || rank < 1) return "Bad rank";
    candidate.rank = rank;
  }
  if (fields.weight !== undefined) {
    const weight = parseWeight(fields.weight);
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
 * otherwise the first cell is the ticker. Undelimited text is a list of tickers split on spaces
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
  const delimiter = DELIMITERS.find((candidate) =>
    lines.some((entry) => entry.text.includes(candidate))
  );
  const rows =
    delimiter === undefined ? tokenRows(lines) : tableRows(lines, delimiter);
  const members: PickListImportMember[] = [];
  const rejects: PickListImportReject[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const result = toMember(row.fields, members.length + 1);
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
