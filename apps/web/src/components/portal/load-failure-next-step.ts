// Next step of a failed research load (rotation matrix, sector rotation): "press Try again" only
// when a retry can help (status language rule: a status says what happens next).
import { utcClock } from "../status-time.ts";
import { isOperatorAccessDenied } from "./agent-ops-client.tsx";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/**
 * True for a NOT_FOUND whose data the nightly job has not written yet: the server's default
 * "… not yet collected" text, or no text. Another NOT_FOUND (an unknown benchmark or symbol) is a
 * problem of the request, which the nightly run does not fix.
 */
export const isNotYetCollected = (error: unknown): boolean => {
  if (field(error, "code") !== "NOT_FOUND") return false;
  const message = field(error, "message");
  return (
    typeof message !== "string" ||
    message.trim() === "" ||
    /not yet collected/i.test(message)
  );
};

/** True when the server message already ends with its own retry step ("… Try again.", "…; retry"). */
const namesRetry = (error: unknown): boolean => {
  const message = field(error, "message");
  return (
    typeof message === "string" && /(try again|retry)\.?\s*$/i.test(message)
  );
};

/**
 * The next step after a failed load, or null when the server message already names it
 * (STORAGE_ERROR: "… ask the operator"; a message that ends with "Try again" or "retry").
 * `notFound` is the lens's step for any NOT_FOUND: the rotation matrix takes no symbol or
 * benchmark, so its only NOT_FOUND is a matrix the nightly job has not written yet.
 */
export const failureNextStep = (
  error: unknown,
  options: Readonly<{ notFound?: string }> = {}
): string | null => {
  if (isOperatorAccessDenied(error)) return "sign in with an operator account";
  if (isNotYetCollected(error)) return "try again after the nightly run";
  switch (field(error, "code")) {
    case "UNAUTHORIZED":
      return "sign in again";
    case "NOT_FOUND":
      return options.notFound ?? "change the symbol or benchmark";
    case "BAD_REQUEST":
      return "change the request";
    case "NOT_CONFIGURED":
      return "ask the operator to configure the research lens endpoint";
    case "STORAGE_ERROR":
      return null;
    default:
      return namesRetry(error) ? null : "press Try again";
  }
};

/**
 * The text after "… load failed: ": the message without one trailing full stop, the time of the
 * failure and the next step, joined by " · ". The time is left out when the message already
 * holds one ("… timed out at 14:05 UTC. …"), so the body shows one time only.
 */
export const failureBody = (
  message: string,
  failedAt: number,
  nextStep: string | null
): string =>
  [
    message.replace(/\.$/, ""),
    /\b\d{2}:\d{2} UTC\b/.test(message) ? null : utcClock(failedAt),
    nextStep,
  ]
    .filter((part) => part !== null)
    .join(" · ");
