import { utcClock } from "./status-time.ts";

// The database was asked and returned an error. The 503 names that cause, the time and the next step.
export const storageReadFailedMessage = (
  store: string,
  now: number = Date.now()
): string =>
  `${store} storage: the database returned an error at ${utcClock(now, now)}. Nothing was changed. Try again.`;

export const storageWriteFailedMessage = (
  store: string,
  now: number = Date.now()
): string =>
  `${store} storage: the database returned an error at ${utcClock(now, now)}. Reload to check whether the change was saved.`;

// For a catch that takes any thrown value: the cause is not proven to be the database, so the 503
// names the failed storage request, the time and the next step.
export const storageReadRequestFailedMessage = (
  store: string,
  now: number = Date.now()
): string =>
  `${store} storage request failed at ${utcClock(now, now)}. Nothing was changed. Try again.`;

export const storageWriteRequestFailedMessage = (
  store: string,
  now: number = Date.now()
): string =>
  `${store} storage request failed at ${utcClock(now, now)}. Reload to check whether the change was saved.`;

// For a mapper that serves reads and writes and knows a likely fix: names the database error, the
// time, the fix to check and the next step. It does not claim that nothing was changed.
export const storageFailedWithFixMessage = (
  store: string,
  fix: string,
  now: number = Date.now()
): string =>
  `${store} storage: the database returned an error at ${utcClock(now, now)}. ${fix} Reload to check whether a change was saved.`;
