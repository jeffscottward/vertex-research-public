// What: Maps auth email delivery failures to the auth.email-delivery-failed semantic event.
// Used by: apps/web/src/server/request-scope.ts (createAuth onEmailDeliveryFailure).
// See: docs/debugging.md#symptom--where-to-look; packages/auth/src/server.ts#AuthEmailDeliveryFailure.
import type {
  AuthEmailDeliveryFailure,
  AuthEmailDeliveryFailureSink,
} from "@darkfactory/auth/server";
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

type EventProfile = Readonly<{
  errorCategory: string;
  attributes: Readonly<Record<string, string | boolean>>;
}>;

// The value is typed and built from non-sensitive fields in packages/auth;
// the evlog sink still redacts every event (redactSemanticEvent).
const eventProfileFor = (
  failure: AuthEmailDeliveryFailure
): EventProfile | undefined => {
  switch (failure.reason) {
    case "delivery-failed": {
      return Object.freeze({
        errorCategory: failure.code,
        attributes: Object.freeze({
          operation: failure.operation,
          reason: failure.reason,
          provider: failure.provider,
          retryable: failure.retryable,
        }),
      });
    }
    case "recipient-limit-failed":
    case "delivery-threw": {
      return Object.freeze({
        errorCategory:
          failure.reason === "delivery-threw"
            ? "AUTH_EMAIL_PORT_THREW"
            : "AUTH_EMAIL_RECIPIENT_LIMIT_FAILED",
        attributes: Object.freeze({
          operation: failure.operation,
          reason: failure.reason,
          errorName: failure.errorName,
        }),
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
