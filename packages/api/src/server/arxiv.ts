import { present } from "./present.ts"; // arXiv intake: identifier parsing, bounded fetch from the official arXiv API and strict Atom parsing.
// Only https://export.arxiv.org/api/query is contacted; the identifier is validated before any request.
// SSRN and DOI records are not fetched (SSRN terms); they stay on the manual add form.

const ARXIV_API_ENDPOINT = "https://export.arxiv.org/api/query";
const ARXIV_FETCH_TIMEOUT_MS = 10_000;
const ARXIV_RESPONSE_MAX_BYTES = 512 * 1024;
const TITLE_MAX = 300;
const AUTHORS_MAX = 500;
const NOTES_MAX = 4000;

export class ArxivInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivInputError";
  }
}

export class ArxivNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivNotFoundError";
  }
}

export class ArxivUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivUpstreamError";
  }
}

export type ArxivReference = Readonly<{
  baseId: string;
  version: number | null;
}>;

const NEW_STYLE = /^(\d{4}\.\d{4,5})(?:v(\d{1,3}))?$/;
const OLD_STYLE = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d{1,3}))?$/;

// New-style ids are YYMM.NNNN for 0704-1412 and YYMM.NNNNN from 1501 (arXiv identifier scheme).
const validNewStyle = (baseId: string): boolean => {
  const [yymm, number] = baseId.split(".");
  const year = Number(present(yymm).slice(0, 2));
  const month = Number(present(yymm).slice(2));
  if (month < 1 || month > 12) return false;
  const period = year * 100 + month;
  if (period < 704) return false;
  return period <= 1412
    ? present(number).length === 4
    : present(number).length === 5;
};

const matchId = (value: string): ArxivReference | null => {
  const newStyle = NEW_STYLE.exec(value);
  if (newStyle !== null && !validNewStyle(present(newStyle[1]))) return null;
  const match = newStyle ?? OLD_STYLE.exec(value);
  if (match === null) return null;
  const version = match[2] === undefined ? null : Number(match[2]);
  if (version !== null && version < 1) return null;
  return { baseId: present(match[1]), version };
};

// Accepts a bare id, an "arXiv:" prefixed id, or an https://arxiv.org/{abs,pdf}/<id>[.pdf] URL.
export const parseArxivReference = (raw: string): ArxivReference => {
  const value = raw.trim();
  if (value === "" || value.length > 300)
    throw new ArxivInputError("Expected an arXiv identifier or arxiv.org URL");
  const prefixed = /^arxiv:\s*/i.exec(value);
  if (prefixed !== null) {
    const reference = matchId(value.slice(prefixed[0].length));
    if (reference === null)
      throw new ArxivInputError("Unrecognized arXiv identifier");
    return reference;
  }
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ArxivInputError("Invalid URL");
    }
    if (
      !["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(
        url.hostname.toLowerCase()
      )
    ) {
      throw new ArxivInputError("Only arxiv.org URLs are accepted");
    }
    const path = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/.exec(url.pathname);
    if (path === null)
      throw new ArxivInputError(
        "Expected an arxiv.org/abs/ or arxiv.org/pdf/ URL"
      );
    const reference = matchId(decodeURIComponent(present(path[1])));
    if (reference === null)
      throw new ArxivInputError("Unrecognized arXiv identifier in URL");
    return reference;
  }
  const reference = matchId(value);
  if (reference === null)
    throw new ArxivInputError("Unrecognized arXiv identifier");
  return reference;
};

const arxivQueryUrl = (reference: ArxivReference): string => {
  const id =
    reference.version === null
      ? reference.baseId
      : `${reference.baseId}v${reference.version}`;
  return `${ARXIV_API_ENDPOINT}?id_list=${encodeURIComponent(id)}&max_results=1`;
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

// Decodes the five XML entities and numeric character references; anything else is rejected.
const decodeXmlText = (value: string): string => {
  if (value.includes("<"))
    throw new ArxivUpstreamError("Unexpected markup inside a text element");
  return value.replace(
    /&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|[A-Za-z]+);|&/g,
    (whole, body: string | undefined) => {
      if (body === undefined)
        throw new ArxivUpstreamError("Unescaped ampersand in Atom text");
      if (body.startsWith("#")) {
        const code =
          body[1] === "x"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (
          !Number.isInteger(code) ||
          code < 1 ||
          code > 0x10_ff_ff ||
          (code >= 0xd8_00 && code <= 0xdf_ff)
        ) {
          throw new ArxivUpstreamError("Invalid character reference");
        }
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body];
      if (named === undefined)
        throw new ArxivUpstreamError(`Undeclared entity ${whole}`);
      return named;
    }
  );
};

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

const CDATA_OR_PI = /<!\[CDATA\[|<!DOCTYPE|<!ENTITY/i;

// Returns the text content of every direct <tag>...</tag> occurrence (no attributes needed, none nested).
const elements = (xml: string, tag: string): string[] => {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => present(match[1]));
};

const single = (xml: string, tag: string, field: string): string => {
  const found = elements(xml, tag);
  if (found.length !== 1)
    throw new ArxivUpstreamError(`Expected exactly one ${field}`);
  return present(found[0]);
};

export type ArxivMetadata = Readonly<{
  baseId: string;
  version: number;
  title: string;
  authors: string;
  year: number;
  abstract: string;
  identifier: string;
  sourceUrl: string;
}>;

const ENTRY_ID = /^https?:\/\/arxiv\.org\/abs\/(.+)$/;

// Strict Atom parse of an arXiv API response for one requested identifier.
export const parseArxivAtom = (
  xml: string,
  reference: ArxivReference
): ArxivMetadata => {
  if (CDATA_OR_PI.test(xml))
    throw new ArxivUpstreamError(
      "Atom response contains DOCTYPE, ENTITY or CDATA"
    );
  const feedOpen =
    /<feed\s[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"[^>]*>/.exec(xml);
  if (feedOpen === null || !xml.trimEnd().endsWith("</feed>"))
    throw new ArxivUpstreamError("Response is not an Atom feed");
  const entries = elements(xml, "entry");
  if (entries.length === 0)
    throw new ArxivNotFoundError("arXiv has no record for this identifier");
  if (entries.length !== 1)
    throw new ArxivUpstreamError("Expected exactly one Atom entry");
  const entry = present(entries[0]);
  const entryId = collapse(decodeXmlText(single(entry, "id", "entry id")));
  if (/\/api\/errors/.test(entryId)) {
    throw new ArxivNotFoundError(
      collapse(
        decodeXmlText(
          elements(entry, "summary")[0] ?? "arXiv rejected the identifier"
        )
      ).slice(0, 200)
    );
  }
  const idMatch = ENTRY_ID.exec(entryId);
  if (idMatch === null) throw new ArxivUpstreamError("Unexpected entry id");
  const returned = matchId(present(idMatch[1]));
  if (returned === null || returned.version === null)
    throw new ArxivUpstreamError("Entry id lacks a version");
  if (returned.baseId !== reference.baseId)
    throw new ArxivUpstreamError(
      "Entry id does not match the requested identifier"
    );
  if (reference.version !== null && returned.version !== reference.version) {
    throw new ArxivUpstreamError(
      "Entry version does not match the requested version"
    );
  }
  const title = collapse(decodeXmlText(single(entry, "title", "title")));
  if (title === "") throw new ArxivUpstreamError("Empty title");
  const published = collapse(
    decodeXmlText(single(entry, "published", "published date"))
  );
  const yearMatch = /^(\d{4})-\d{2}-\d{2}T/.exec(published);
  if (yearMatch === null)
    throw new ArxivUpstreamError("Invalid published date");
  const year = Number(yearMatch[1]);
  if (year < 1900 || year > 2100)
    throw new ArxivUpstreamError("Published year out of range");
  const authorNames = elements(entry, "author").map((author) =>
    collapse(decodeXmlText(single(author, "name", "author name")))
  );
  if (authorNames.length === 0 || authorNames.some((name) => name === ""))
    throw new ArxivUpstreamError("Missing author names");
  const abstract = collapse(
    decodeXmlText(single(entry, "summary", "abstract"))
  );
  const versioned = `${returned.baseId}v${returned.version}`;
  const authorText = authorNames.join("; ");
  return {
    baseId: returned.baseId,
    version: returned.version,
    title:
      title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
    authors:
      authorText.length > AUTHORS_MAX
        ? `${authorText.slice(0, AUTHORS_MAX - 1)}…`
        : authorText,
    year,
    abstract,
    identifier: `arXiv:${versioned}`,
    sourceUrl: `https://arxiv.org/abs/${versioned}`,
  };
};

export const arxivNotes = (metadata: ArxivMetadata): string => {
  const prefix = "Abstract (arXiv API): ";
  const room = NOTES_MAX - prefix.length;
  const body =
    metadata.abstract.length > room
      ? `${metadata.abstract.slice(0, room - 1)}…`
      : metadata.abstract;
  return `${prefix}${body}`;
};

export type ArxivFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type FetchArxivOptions = Readonly<{
  fetch?: ArxivFetch;
  timeoutMs?: number;
  maxBytes?: number;
}>;

const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ArxivUpstreamError("arXiv response exceeds the size cap");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ArxivUpstreamError("arXiv response exceeds the size cap");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArxivUpstreamError("arXiv response is not valid UTF-8");
  }
};

export const fetchArxivMetadata = async (
  reference: ArxivReference,
  options: FetchArxivOptions = {}
): Promise<ArxivMetadata> => {
  const doFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? ARXIV_FETCH_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(arxivQueryUrl(reference), {
        method: "GET",
        headers: { accept: "application/atom+xml" },
        // Workers (workerd) reject redirect "error"; "manual" returns any 3xx as-is and the
        // status !== 200 check below refuses it, so redirects are still never followed.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new ArxivUpstreamError(
        controller.signal.aborted
          ? "arXiv request timed out"
          : "arXiv request failed"
      );
    }
    if (response.status !== 200)
      throw new ArxivUpstreamError(`arXiv returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:atom\+)?xml\b/i.test(contentType))
      throw new ArxivUpstreamError("arXiv returned an unexpected content type");
    let body: string;
    try {
      body = await readCapped(
        response,
        options.maxBytes ?? ARXIV_RESPONSE_MAX_BYTES
      );
    } catch (error) {
      if (error instanceof ArxivUpstreamError) throw error;
      throw new ArxivUpstreamError(
        controller.signal.aborted
          ? "arXiv request timed out"
          : "arXiv response read failed"
      );
    }
    return parseArxivAtom(body, reference);
  } finally {
    clearTimeout(timer);
  }
};
