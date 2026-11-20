// What: Contact submission service: throttles, then delivers; errors surface as ContactServiceError (429/503).
// Used by: packages/api/src/server/router.ts, packages/api/src/server/context.ts.
// See: docs/debugging.md#symptom--where-to-look (Contact form returns 429 or 503).
import {
  CONTACT_ERRORS,
  CONTACT_LIMIT_CHECK_FAILED_MESSAGE,
  type ContactSubmitInput,
  type ContactSubmitOutput,
} from "../contracts/contact.ts";

// `provider` is opaque so the API brick names no email vendor; the service
// never copies it into ContactSubmitOutput.
export type ContactDeliveryResult =
  | Readonly<{ status: "sent"; provider: string; messageId: string }>
  | Readonly<{ status: "previewed"; provider: string; artifactPath: string }>
  | Readonly<{
      status: "not-delivered";
      provider: string;
      code: string;
      retryable: boolean;
    }>;

export interface ContactDeliveryPort {
  readonly sendContact: (
    input: Omit<ContactSubmitInput, "website">
  ) => Promise<ContactDeliveryResult>;
}

export type ContactThrottleResult = Readonly<{
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}>;

export interface ContactThrottlePort {
  readonly consume: (keyHash: string) => Promise<ContactThrottleResult>;
}

export type ContactServiceErrorCode =
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE";

const CONTACT_SERVICE_ERROR_MESSAGES: Record<ContactServiceErrorCode, string> =
  {
    TOO_MANY_REQUESTS: "Too many contact requests",
    SERVICE_UNAVAILABLE: CONTACT_ERRORS.SERVICE_UNAVAILABLE.message,
  };

export class ContactServiceError extends Error {
  readonly code: ContactServiceErrorCode;

  constructor(code: ContactServiceErrorCode, message?: string) {
    super(message ?? CONTACT_SERVICE_ERROR_MESSAGES[code]);
    this.name = "ContactServiceError";
    this.code = code;
  }
}

// One definite cause per failed delivery; the provider code and name stay inside the API.
const notDeliveredMessage = (code: string, retryable: boolean): string => {
  if (code === "CONTACT_PROVIDER_NOT_CONFIGURED")
    return "Message not sent: mail delivery is not configured";
  return retryable
    ? "Message not sent: mail provider refused; retry later"
    : "Message not sent: mail provider refused; a retry will not help";
};

export type ContactServiceDependencies = Readonly<{
  delivery: ContactDeliveryPort;
  throttle: ContactThrottlePort;
  throttleKey: string;
}>;

export const createContactService = (
  dependencies: ContactServiceDependencies
) => ({
  submit: async (input: ContactSubmitInput): Promise<ContactSubmitOutput> => {
    if (input.website?.trim()) return { status: "not-delivered" };

    let throttleResult: ContactThrottleResult;
    try {
      throttleResult = await dependencies.throttle.consume(
        dependencies.throttleKey
      );
    } catch {
      throw new ContactServiceError(
        "SERVICE_UNAVAILABLE",
        CONTACT_LIMIT_CHECK_FAILED_MESSAGE
      );
    }
    if (!throttleResult.allowed) {
      throw new ContactServiceError("TOO_MANY_REQUESTS");
    }

    const deliveryInput = {
      name: input.name,
      email: input.email,
      subject: input.subject,
      message: input.message,
    };
    let deliveryResult: ContactDeliveryResult;
    try {
      deliveryResult = await dependencies.delivery.sendContact(deliveryInput);
    } catch {
      // The provider call threw: the message may or may not have left, so the default text
      // (delivery not confirmed) applies.
      throw new ContactServiceError("SERVICE_UNAVAILABLE");
    }

    switch (deliveryResult.status) {
      case "sent": {
        return { status: "sent" };
      }
      case "previewed": {
        return { status: "previewed" };
      }
      case "not-delivered": {
        if (deliveryResult.code === "CONTACT_DELIVERY_DISABLED") {
          return { status: "not-delivered" };
        }
        throw new ContactServiceError(
          "SERVICE_UNAVAILABLE",
          notDeliveredMessage(deliveryResult.code, deliveryResult.retryable)
        );
      }
    }
  },
});
