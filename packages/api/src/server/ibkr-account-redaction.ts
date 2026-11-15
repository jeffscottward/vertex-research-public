/**
 * IBKR account codes in free text: U and DU (live and paper), DF, F and I, each followed by four or
 * more digits. Every server-side scrub of upstream text uses this one pattern, so no reader removes
 * fewer codes than another.
 */
const IBKR_ACCOUNT_PATTERN = /\b(?:D?U|DF|F|I)\d{4,}\b/g;

/** Replaces every IBKR account code in `text` with "[account]". */
export const redactIbkrAccounts = (text: string): string =>
  text.replace(IBKR_ACCOUNT_PATTERN, "[account]");
