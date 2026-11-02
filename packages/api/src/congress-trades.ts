import { z } from "zod";

import {
  CONGRESS_DOC_ID_PATTERN,
  type CongressTradeFiling,
  CongressTradeFilingSchema,
} from "./contracts/congress-trades.ts";

// Pure reading of the U.S. House Clerk financial disclosure index (<YEAR>FD.zip holding
// <YEAR>FD.xml). Adapted from the MIT-licensed day-trader-skill trader-pelosi ptr.py
// (https://github.com/Jakeschincariol/day-trader-skill @ 3d0f4ef). The Worker runtime has no
// zip library or DOMParser: a small central-directory reader plus DecompressionStream reads the
// ZIP, and a strict tokenizer over <Member> blocks reads the XML.

const CLERK_BASE = "https://disclosures-clerk.house.gov/public_disc";
const PTR_FILING_TYPE = "P";
const DAY_MS = 24 * 60 * 60 * 1000;

export class CongressIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CongressIndexError";
  }
}

export const houseIndexUrl = (year: number): string =>
  `${CLERK_BASE}/financial-pdfs/${year}FD.zip`;

export const ptrPdfUrl = (year: number, docId: string): string =>
  `${CLERK_BASE}/ptr-pdfs/${year}/${docId}.pdf`;

// ---------------------------------------------------------------- ZIP

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const EOCD_MIN_BYTES = 22;
const MAX_ZIP_COMMENT = 0xff_ff;

type ZipEntry = Readonly<{
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}>;

const centralEntries = (view: DataView): ZipEntry[] => {
  const floor = Math.max(0, view.byteLength - EOCD_MIN_BYTES - MAX_ZIP_COMMENT);
  let eocd = -1;
  for (let at = view.byteLength - EOCD_MIN_BYTES; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new CongressIndexError("ZIP has no end of directory");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const names = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (
      at + 46 > view.byteLength ||
      view.getUint32(at, true) !== CENTRAL_SIGNATURE
    )
      throw new CongressIndexError("ZIP central directory is damaged");
    const nameLength = view.getUint16(at + 28, true);
    const next =
      at +
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
    if (next > view.byteLength)
      throw new CongressIndexError("ZIP central directory is damaged");
    entries.push({
      compressedSize: view.getUint32(at + 20, true),
      flags: view.getUint16(at + 8, true),
      localOffset: view.getUint32(at + 42, true),
      method: view.getUint16(at + 10, true),
      name: names.decode(
        new Uint8Array(
          view.buffer,
          view.byteOffset + at + 46,
          nameLength
        ).slice()
      ),
      size: view.getUint32(at + 24, true),
    });
    at = next;
  }
  return entries;
};

/** Inflate raw deflate bytes, stopping once the output passes `maxBytes`. */
const inflateRaw = async (
  data: Uint8Array,
  maxBytes: number
): Promise<Uint8Array> => {
  const stream = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CongressIndexError("index XML exceeds the size cap");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CongressIndexError) throw error;
    throw new CongressIndexError("ZIP entry could not be inflated");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** Bytes of the first `.xml` entry in a ZIP archive (stored or deflated, no ZIP64, no encryption). */
export const readZipXml = async (
  zip: Uint8Array,
  maxXmlBytes: number
): Promise<Uint8Array> => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.byteLength < EOCD_MIN_BYTES)
    throw new CongressIndexError("ZIP is truncated");
  const entry = centralEntries(view).find((item) =>
    item.name.toLowerCase().endsWith(".xml")
  );
  if (entry === undefined) throw new CongressIndexError("ZIP holds no XML");
  if (entry.flags % 2 === 1)
    throw new CongressIndexError("ZIP entry is encrypted");
  if (entry.size > maxXmlBytes)
    throw new CongressIndexError("index XML exceeds the size cap");
  const local = entry.localOffset;
  if (
    local + 30 > view.byteLength ||
    view.getUint32(local, true) !== LOCAL_SIGNATURE
  )
    throw new CongressIndexError("ZIP local header is damaged");
  const start =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const end = start + entry.compressedSize;
  if (end > view.byteLength) throw new CongressIndexError("ZIP is truncated");
  const data = zip.subarray(start, end);
  // A stored entry is its own XML: both sizes must agree (size is already capped above).
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size)
      throw new CongressIndexError("ZIP stored entry sizes disagree");
    return data.slice();
  }
  if (entry.method === 8) return await inflateRaw(data, maxXmlBytes);
  throw new CongressIndexError("ZIP compression method is not supported");
};

/** Index XML text from the downloaded bytes: a ZIP (PK magic) or the XML itself. BOM removed. */
export const indexXmlFromBytes = async (
  bytes: Uint8Array,
  maxXmlBytes: number
): Promise<string> => {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip && bytes.byteLength > maxXmlBytes)
    throw new CongressIndexError("index XML exceeds the size cap");
  const xml = isZip ? await readZipXml(bytes, maxXmlBytes) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      xml
    );
  } catch {
    throw new CongressIndexError("index XML is not valid UTF-8");
  }
};

// ---------------------------------------------------------------- XML

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/** Decode the five XML entities and numeric character references; unknown references stay as text. */
export const decodeXmlText = (raw: string): string =>
  raw.replace(
    /&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]{2,4}));/giu,
    (
      whole: string,
      hex: string | undefined,
      dec: string | undefined,
      name: string | undefined
    ) => {
      if (hex !== undefined || dec !== undefined) {
        const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10_ff_ff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[String(name)] ?? whole;
    }
  );

/** '8/21/2026' or '08/21/26' -> '2026-08-21'; null when not a real calendar date. */
export const isoFromMdy = (mdy: string): string | null => {
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/u.exec(mdy);
  if (match === null) return null;
  const yearText = String(match[3]);
  const year = Number(yearText) + (yearText.length === 2 ? 2000 : 0);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
};

const MemberFieldsSchema = z.object({
  DocID: z.string().regex(CONGRESS_DOC_ID_PATTERN),
  FilingDate: z.string().max(20),
  FilingType: z.string().max(10),
  First: z.string().max(100).default(""),
  Last: z.string().min(1).max(100),
  Prefix: z.string().max(40).default(""),
  StateDst: z.string().max(10).default(""),
  Suffix: z.string().max(40).default(""),
  Year: z.string().regex(/^\d{4}$/u),
});

export type IndexFiling = CongressTradeFiling &
  Readonly<{ filingType: string }>;

const memberFields = (block: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const match of block.matchAll(
    /<([A-Za-z]+)\s*(?:\/>|>([^<]*)<\/\1>)/gu
  )) {
    fields[String(match[1])] = decodeXmlText(match[2] ?? "").trim();
  }
  return fields;
};

/**
 * Every well-formed <Member> filing in a <YEAR>FD.xml, in document order. Members missing a
 * last name, a numeric DocID, a four-digit Year or a valid FilingDate are skipped.
 */
export const parseFilingIndex = (xml: string): IndexFiling[] => {
  if (!/<FinancialDisclosure\b[^>]*>/u.test(xml))
    throw new CongressIndexError("index is not a financial disclosure XML");
  const filings: IndexFiling[] = [];
  for (const match of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/gu)) {
    const parsed = MemberFieldsSchema.safeParse(memberFields(String(match[1])));
    if (!parsed.success) continue;
    const fields = parsed.data;
    const filedOn = isoFromMdy(fields.FilingDate);
    if (filedOn === null) continue;
    const year = Number(fields.Year);
    const filing = CongressTradeFilingSchema.safeParse({
      docId: fields.DocID,
      filedOn,
      firstName: fields.First,
      lastName: fields.Last,
      member: [fields.First, fields.Last, fields.Suffix]
        .filter((part) => part !== "")
        .join(" "),
      pdfUrl: ptrPdfUrl(year, fields.DocID),
      stateDistrict: fields.StateDst,
      year,
    });
    if (filing.success)
      filings.push({ ...filing.data, filingType: fields.FilingType });
  }
  return filings;
};

// ---------------------------------------------------------------- window

export type FilingWindow = Readonly<{ since: string; until: string }>;

/** Inclusive UTC date window ending today and starting `days` days earlier. */
export const filingWindow = (now: Date, days: number): FilingWindow => ({
  since: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10),
  until: now.toISOString().slice(0, 10),
});

/** Index years to read: the current year, plus the previous one when the window crosses Jan 1. */
export const windowYears = (window: FilingWindow): number[] => {
  const first = Number(window.since.slice(0, 4));
  const last = Number(window.until.slice(0, 4));
  return first === last ? [last] : [last, first];
};

/** PTR filings (FilingType P) filed inside the window, deduplicated by DocID, newest first. */
export const selectPtrFilings = (
  filings: readonly IndexFiling[],
  window: FilingWindow
): CongressTradeFiling[] => {
  const byDoc = new Map<string, CongressTradeFiling>();
  for (const { filingType, ...filing } of filings) {
    if (filingType !== PTR_FILING_TYPE) continue;
    if (filing.filedOn < window.since || filing.filedOn > window.until)
      continue;
    byDoc.set(filing.docId, filing);
  }
  return [...byDoc.values()].sort(
    (a, b) =>
      b.filedOn.localeCompare(a.filedOn) || Number(b.docId) - Number(a.docId)
  );
};

/** Distinct member names, sorted by last name then full name. */
export const distinctMembers = (
  filings: readonly CongressTradeFiling[]
): string[] => {
  const byName = new Map<string, string>();
  for (const filing of filings) byName.set(filing.member, filing.lastName);
  return [...byName.entries()]
    .sort(
      ([nameA, lastA], [nameB, lastB]) =>
        lastA.localeCompare(lastB, "en") || nameA.localeCompare(nameB, "en")
    )
    .map(([name]) => name);
};
