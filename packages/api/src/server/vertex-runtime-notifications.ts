import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import {
  createNotificationControlComposition,
  type NotificationControlComposition,
  type NotificationControlCompositionOptions,
} from "@darkfactory/db/server/vertex";
import {
  createVertexNotificationReadService,
  type VertexNotificationReadService,
} from "./vertex-notification-read-service.ts";

export type VertexRuntimeNotificationsOptions<Context> = Readonly<{
  db: Database;
  signal?: AbortSignal | undefined;
  clock: Readonly<{ now: () => number }>;
  authority: Omit<
    NotificationControlCompositionOptions<Context>["authority"],
    "clock"
  >;
  admissionAuthorization: NotificationControlCompositionOptions<Context>["admissionAuthorization"];
  configuration:
    | NotificationControlCompositionOptions<Context>["configuration"]
    | null;
  serverContext: (principal: SafePrincipal) => Promise<Context | null>;
  enabled?: boolean | undefined;
  fetcher?: NotificationControlCompositionOptions<Context>["fetcher"];
  timeoutMs?: number | undefined;
}>;
export type VertexRuntimeNotifications<Context> = Readonly<{
  dispatch: NotificationControlComposition<Context>["dispatch"];
  grants: NotificationControlComposition<Context>["grants"];
  vertexNotificationRead: VertexNotificationReadService;
}>;

// No ambient environment/configuration, privileged default, synthetic grant,
// destination lookup, DB query or provider call occurs during construction.
export const createVertexRuntimeNotifications = <Context>(
  options: VertexRuntimeNotificationsOptions<Context>
): VertexRuntimeNotifications<Context> => {
  const configuration: NotificationControlCompositionOptions<Context>["configuration"] =
    options.configuration ?? {
      enabled: false,
      registrations: [],
      allowedNtfyOrigins: [],
      authorize: async () => false,
      resolveDestination: async () => null,
    };
  const composition = createNotificationControlComposition<Context>(
    options.db,
    {
      enabled: options.configuration !== null && options.enabled === true,
      authority: { ...options.authority, clock: options.clock },
      admissionAuthorization: options.admissionAuthorization,
      configuration,
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
    }
  );
  return Object.freeze({
    // Preserve the actual dispatcher/independent privileged grant operations.
    // A disabled sender does not erase the original historical admission ledger.
    dispatch: composition.dispatch,
    grants: composition.grants,
    vertexNotificationRead: createVertexNotificationReadService<Context>({
      deliveries: composition.deliveries,
      serverContext: options.serverContext,
      signal: options.signal,
    }),
  });
};
