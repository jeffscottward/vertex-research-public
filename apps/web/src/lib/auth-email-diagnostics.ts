// What: Maps auth email delivery failures to the auth.email-delivery-failed semantic event.
// Used by: apps/web/src/server/request-scope.ts (createAuth onEmailDeliveryFailure).
// See: docs/debugging.md#symptom--where-to-look; packages/auth/src/server.ts#AuthEmailDeliveryFailure.
import type {
  AuthEmailDeliveryFailure,
  AuthEmailDeliveryFailureSink,
  AuthEmailOperation,
} from "@darkfactory/auth/server";
import type {
  EmailDeliveryFailureCode,
  EmailProvider,
} from "@darkfactory/email";
import type {
  SemanticEvent,
  StructuredEventSink,
} from "@darkfactory/observability";

export const AUTH_EMAIL_DELIVERY_FAILED_EVENT = "auth.email-delivery-failed";

type AuthEmailDiagnosticOptions = Readonly<{
  sink: StructuredEventSink;
  /** The raw platform `waitUntil`: emission is not database work. */
  scheduleBackgroundTask: (task: Promise<unknown>) => void;
  requestId: string;
}>;

// Fixed value tables: a value outside them (an untyped caller, a future code)
// never reaches the log as free text. `satisfies` keeps them exhaustive.
const OPERATIONS = {
  "email-verification": true,
  "password-reset": true,
} as const satisfies Record<AuthEmailOperation, true>;

const FAILURE_CODES = {
  EMAIL_DELIVERY_DISABLED: true,
  EMAIL_PREVIEW_WRITE_FAILED: true,
  EMAIL_PROVIDER_INVALID_RESPONSE: true,
  EMAIL_PROVIDER_NOT_CONFIGURED: true,
  EMAIL_PROVIDER_REJECTED: true,
  EMAIL_PROVIDER_UNAVAILABLE: true,
  EMAIL_RECIPIENT_INVALID: true,
  EMAIL_RENDER_FAILED: true,
} as const satisfies Record<EmailDeliveryFailureCode, true>;

const PROVIDERS = {
  disabled: true,
  preview: true,
  resend: true,
} as const satisfies Record<EmailProvider, true>;

const isKnown = (table: object, value: unknown): boolean =>
  typeof value === "string" && Object.hasOwn(table, value);

const SAFE_ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

type EventProfile = Readonly<{
  errorCategory: string;
  attributes: Readonly<Record<string, string | boolean>>;
}>;

const eventProfileFor = (
  failure: AuthEmailDeliveryFailure
): EventProfile | undefined => {
  if (!isKnown(OPERATIONS, failure.operation)) return undefined;
  const operation = failure.operation;
  switch (failure.reason) {
    case "delivery-failed": {
      // An unknown value is replaced, not dropped, so the failure still
      // shows in the log without any free text.
      return Object.freeze({
        attributes: Object.freeze({
          operation,
          provider: isKnown(PROVIDERS, failure.provider)
            ? failure.provider
            : "unknown",
          reason: failure.reason,
          retryable: failure.retryable === true,
        }),
        errorCategory: isKnown(FAILURE_CODES, failure.code)
          ? failure.code
          : "AUTH_EMAIL_UNKNOWN_CODE",
      });
    }
    case "recipient-limit-failed":
    case "delivery-threw": {
      const errorName = SAFE_ERROR_NAME.test(failure.errorName)
        ? failure.errorName
        : "UnknownError";
      return Object.freeze({
        attributes: Object.freeze({
          errorName,
          operation,
          reason: failure.reason,
        }),
        errorCategory:
          failure.reason === "delivery-threw"
            ? "AUTH_EMAIL_PORT_THREW"
            : "AUTH_EMAIL_RECIPIENT_LIMIT_FAILED",
      });
    }
    default: {
      return undefined;
    }
  }
};

export const createAuthEmailDiagnosticSink = (
  options: AuthEmailDiagnosticOptions
): AuthEmailDeliveryFailureSink => {
  return (failure) => {
    const profile = eventProfileFor(failure);
    if (profile === undefined) return;
    const event = Object.freeze<SemanticEvent>({
      eventId: globalThis.crypto.randomUUID(),
      name: AUTH_EMAIL_DELIVERY_FAILED_EVENT,
      occurredAt: new Date().toISOString(),
      correlation: Object.freeze({ requestId: options.requestId }),
      outcome: "failure",
      source: "worker",
      errorCategory: profile.errorCategory,
      attributes: profile.attributes,
    });
    const emission = Promise.resolve().then(() => options.sink.emit(event));
    try {
      return options.scheduleBackgroundTask(emission);
    } catch {
      return void emission.catch(() => undefined);
    }
  };
};
