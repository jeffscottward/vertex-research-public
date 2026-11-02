import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  NotificationAuthorityError,
  notificationFields,
  type NotificationDeliveryReadSource,
} from "@darkfactory/notifications/server/dispatch";
import {
  VertexNotificationDeliveryInputSchema,
  VertexNotificationDeliveryOutputSchema,
  type VertexNotificationDeliveryInput,
  type VertexNotificationDeliveryOutput,
} from "../contracts/vertex-notification-read.ts";
import { VertexReadServiceError } from "./vertex-service.ts";

// Root handlers consume this object, not a contravariant generic dependency bag.
export type VertexNotificationReadService = Readonly<{
  delivery: (
    principal: SafePrincipal,
    input: VertexNotificationDeliveryInput
  ) => Promise<VertexNotificationDeliveryOutput>;
}>;
export type VertexNotificationReadDependencies<Context> = Readonly<{
  deliveries: NotificationDeliveryReadSource<Context>;
  serverContext: (principal: SafePrincipal) => Promise<Context | null>;
  signal?: AbortSignal | undefined;
}>;
const checkCancellation = (signal: AbortSignal): void => {
  if (signal.aborted) throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
};
const inputSnapshot = (input: unknown): VertexNotificationDeliveryInput => {
  try {
    const fields = notificationFields(input, [
      "accountAlias",
      "environment",
      "grantId",
      "version",
      "eventId",
    ]);
    return Object.freeze(VertexNotificationDeliveryInputSchema.parse(fields));
  } catch {
    throw new VertexReadServiceError("BAD_REQUEST");
  }
};
const outputSnapshot = (output: unknown): VertexNotificationDeliveryOutput => {
  try {
    const status =
      output !== null && typeof output === "object"
        ? Object.getOwnPropertyDescriptor(output, "status")
        : undefined;
    const keys =
      status && "value" in status && status.value === "not-found"
        ? ["status", "receipt", "retryable"]
        : [
            "status",
            "admittedAt",
            "expiresAt",
            "outcomeAt",
            "receipt",
            "retryable",
          ];
    return Object.freeze(
      VertexNotificationDeliveryOutputSchema.parse(
        notificationFields(output, keys)
      )
    );
  } catch {
    throw new VertexReadServiceError("INVALID_SOURCE");
  }
};

export const createVertexNotificationReadService = <Context>(
  dependencies: VertexNotificationReadDependencies<Context>
): VertexNotificationReadService => {
  const signal = dependencies.signal ?? new AbortController().signal;
  return Object.freeze({
    delivery: async (
      principal,
      raw
    ): Promise<VertexNotificationDeliveryOutput> => {
      const input = inputSnapshot(raw);
      checkCancellation(signal);
      let context: Context | null;
      try {
        context = await dependencies.serverContext(principal);
      } catch {
        // Context resolver exceptions, even lookalike API errors, are private.
        throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
      }
      checkCancellation(signal);
      if (context === null || context === undefined)
        throw new VertexReadServiceError("FORBIDDEN");
      let result: unknown;
      try {
        // The SQL source authenticates the resolved server context and checks
        // current delivery-read permission before AND after its ledger select.
        // Never replace that with send rights, a role or caller-supplied context.
        result = await dependencies.deliveries.read(context, input, signal);
      } catch (error) {
        if (error instanceof NotificationAuthorityError) {
          if (error.code === "denied")
            throw new VertexReadServiceError("FORBIDDEN");
          if (error.code === "invalid")
            throw new VertexReadServiceError("BAD_REQUEST");
          if (error.code === "integrity")
            throw new VertexReadServiceError("INVALID_SOURCE");
        }
        throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
      }
      checkCancellation(signal);
      return outputSnapshot(result);
    },
  });
};
