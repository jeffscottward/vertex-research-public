import {
  CLICK_LOG_LABEL_MAX,
  CLICK_LOG_ROUTE_MAX,
} from "./contracts/click-log.ts";

// Redaction for the UI click log. The browser runs it before an event leaves the page; the server
// runs it again before it stores the event, so a modified client cannot store raw text.
// Rules, in order:
// - email addresses become "[email]";
// - runs of 24 or more token characters that contain a digit (keys, hashes, ids in text) become
//   "[redacted]"; long hyphenated words without digits stay readable;
// - every number, with its currency sign, separators, sign and percent, becomes "#", so prices,
//   quantities, balances and P&L shown on a button never reach the log;
// - white space collapses and the text is cut to CLICK_LOG_LABEL_MAX characters.

// EMAIL and TOKEN start with a repeated class, so a lookbehind anchors each to the start of its
// run: a long run is scanned once, not once per character (the match is the same, the time is
// linear).
const EMAIL = /(?<![^\s@])[^\s@]+@[^\s@]+\.[^\s@]+/gu;
const TOKEN =
  /(?<![A-Za-z0-9_+=-])(?=[A-Za-z0-9_+=-]*\d)[A-Za-z0-9_+=-]{24,}/gu;
// A sign counts only at a word start, so "order-12" keeps its hyphen.
const NUMBER = /(?:(?<![\w-])[-+])?[$€£¥]?\d(?:[\d,.:'\u00a0]*\d)?%?/gu;
const SPACE = /\s+/gu;
// Route segments this long are treated as secrets (reset tokens, signed ids); ids such as UUIDs
// (36 characters) stay readable.
const ROUTE_TOKEN_SEGMENT = /^[A-Za-z0-9_.~-]{40,}$/u;

export const redactClickText = (text: string): string =>
  text
    .replace(EMAIL, "[email]")
    .replace(TOKEN, "[redacted]")
    .replace(NUMBER, "#")
    .replace(SPACE, " ")
    .trim()
    .slice(0, CLICK_LOG_LABEL_MAX);

/** The path without query or hash, with secret-looking segments replaced by "[redacted]". */
export const redactClickRoute = (route: string): string =>
  route
    .replace(/[?#].*$/su, "")
    .split("/")
    .map((segment) =>
      ROUTE_TOKEN_SEGMENT.test(segment) ? "[redacted]" : segment
    )
    .join("/")
    .slice(0, CLICK_LOG_ROUTE_MAX);
