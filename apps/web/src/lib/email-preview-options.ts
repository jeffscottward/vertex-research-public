import type { ServerEnv } from "@darkfactory/config/server";
import { resolveE2eEmailPreviewOptions } from "./e2e-fixtures.ts";

// Call only with the validated server environment; never expose this binding to clients.
export const resolveEmailPreviewOptions = (env: ServerEnv) => {
  if (env.DEV_EMAIL_PREVIEW_ENDPOINT !== undefined) {
    if (
      env.APP_ENV !== "development" ||
      env.EMAIL_TRANSPORT !== "preview" ||
      !env.DEV_EMAIL_PREVIEW_KEY
    ) {
      throw new Error("Development email capture is not configured");
    }
    return {
      authDirectory: undefined,
      contactDirectory: undefined,
      captureEndpoint: env.DEV_EMAIL_PREVIEW_ENDPOINT,
      binding: {
        runId: "ordinary-development",
        hmacKey: env.DEV_EMAIL_PREVIEW_KEY,
      },
    };
  }
  return resolveE2eEmailPreviewOptions();
};
