// Next step of a failed research load (rotation matrix, sector rotation): "press Try again" only
// when a retry can help (status language rule: a status says what happens next).
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

/**
 * The next step after a failed load, or null when the server message already names it
 * (STORAGE_ERROR: "… ask the operator").
 */
export const failureNextStep = (error: unknown): string | null => {
  if (isOperatorAccessDenied(error)) return "sign in with an operator account";
  if (isNotYetCollected(error)) return "try again after the nightly run";
  switch (field(error, "code")) {
    case "UNAUTHORIZED":
      return "sign in again";
    case "NOT_FOUND":
      return "change the symbol or benchmark";
    case "NOT_CONFIGURED":
      return "ask the operator to configure the research lens endpoint";
    case "STORAGE_ERROR":
      return null;
    default:
      return "press Try again";
  }
};
