// biome-ignore lint/performance/noBarrelFile: package export ./server is the server-only notification entrypoint.
export * from "./server/contracts.ts";
export { createNotificationService } from "./server/service.ts";
export { createNtfyNotificationAdapter } from "./server/ntfy.ts";
export type {
  NtfyNotificationConfiguration,
  NtfyNotificationAdapterOptions,
  NotificationFetch,
} from "./server/ntfy.ts";
export { createEmailNotificationAdapter } from "./server/email.ts";
export type {
  EmailNotificationConfiguration,
  EmailNotificationAdapterOptions,
} from "./server/email.ts";
