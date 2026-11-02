export type {
  NotificationAccountScope,
  NotificationRecipientBinding,
  NotificationConsent,
  NotificationRecipientGrant,
  NotificationGrantSelection,
  NotificationGrantQuery,
  NotificationAuthorityMutation,
  NotificationAuthorityRevocation,
  NotificationGrantRepository,
  NotificationDispatchEvent,
  NotificationDispatchOptions,
  NotificationDispatchResult,
  NotificationDispatch,
  NotificationConfigurationResolver,
  NotificationDispatchFactoryOptions,
  NotificationDeliveryQuery,
  NotificationDeliveryStatus,
  NotificationDeliveryReadSource,
} from "./contracts.ts";
// biome-ignore lint/performance/noBarrelFile: package export ./server/dispatch is the server-only dispatch entrypoint.
export { createNotificationDispatch } from "./composition.ts";
export { createNotificationConfigurationResolver } from "./configuration.ts";
export type {
  NotificationConfigurationRegistration,
  NotificationConfigurationResolverOptions,
} from "./configuration.ts";
// Strict shared internal persistence boundary; this entry is server-only and is
// not an HTTP schema or a source of caller-authored authorization grants.
export {
  NotificationAuthorityError,
  notificationAccount,
  notificationBinding,
  notificationEventKey,
  notificationFail,
  notificationFields,
  notificationKey,
  notificationMilliseconds,
  notificationVersion,
  notificationVertexIdentifier,
  notificationEpochNanoseconds,
  notificationEpochMilliseconds,
  snapshotNotificationConsent,
  snapshotNotificationDispatchEvent,
  snapshotNotificationRecipientGrant,
} from "./validation.ts";
