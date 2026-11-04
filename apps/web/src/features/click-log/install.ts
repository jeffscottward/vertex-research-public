// What: installs the portal click log in one window (card vertex-click-log): capture-phase click
// and submit listeners, API call observation for important clicks, and a flush when the page is
// hidden. The batch request uses `keepalive`, so a flush during page hide still reaches the server.
// Used by: ./listener.tsx. See: docs/vertex-rebuild/click-log.md.
import {
  ClickLogBuildShaSchema,
  type ClickLogRecordInput,
} from "@darkfactory/api";
import { createApiClient, observeApiCalls } from "@darkfactory/api/client";

import { describeClick, describeSubmit } from "./describe.ts";
import { createClickRecorder } from "./recorder.ts";

declare const __VERTEX_BUILD_SHA__: string | undefined;

/** The commit the bundle was built from (Vite define in apps/web/vite.config.ts), or "unknown". */
export const readBuildSha = (): string => {
  const parsed = ClickLogBuildShaSchema.safeParse(
    typeof __VERTEX_BUILD_SHA__ === "string" ? __VERTEX_BUILD_SHA__ : null
  );
  return parsed.success ? parsed.data : "unknown";
};

/** Sends one batch as a keepalive POST through the oRPC client. */
export const createKeepaliveSend = (
  origin: string,
  fetcher: typeof fetch
): ((input: ClickLogRecordInput) => Promise<unknown>) => {
  const client = createApiClient({
    baseUrl: origin,
    fetch: async (request) =>
      fetcher(request.url, {
        body: await request.text(),
        credentials: "same-origin",
        headers: request.headers,
        keepalive: true,
        method: request.method,
      }),
  });
  return (input) => client.clickLog.record(input);
};

export type ClickLogInstallOptions = Readonly<{
  buildSha?: string;
  send?: (input: ClickLogRecordInput) => Promise<unknown>;
  tabId?: string;
}>;

/** Starts the click log in `view`; returns the function that stops it. */
export const installClickLog = (
  view: Window,
  options: ClickLogInstallOptions = {}
): (() => void) => {
  const recorder = createClickRecorder({
    buildSha: options.buildSha ?? readBuildSha(),
    now: () => Date.now(),
    schedule: (callback, ms) => {
      const timer = view.setTimeout(callback, ms);
      return () => view.clearTimeout(timer);
    },
    send:
      options.send ??
      createKeepaliveSend(view.location.origin, view.fetch.bind(view)),
    tabId: options.tabId ?? view.crypto.randomUUID(),
  });
  const onClick = (event: Event) => {
    const descriptor = describeClick(event.target, view.location);
    if (descriptor !== null) recorder.record(descriptor);
  };
  const onSubmit = (event: Event) => {
    const descriptor = describeSubmit(event.target, view.location);
    if (descriptor !== null) recorder.record(descriptor);
  };
  const onHidden = () => {
    if (view.document.visibilityState === "hidden") recorder.flush();
  };
  const onPageHide = () => recorder.flush();
  const stopObserving = observeApiCalls(recorder.observe);
  view.document.addEventListener("click", onClick, true);
  view.document.addEventListener("submit", onSubmit, true);
  view.document.addEventListener("visibilitychange", onHidden);
  view.addEventListener("pagehide", onPageHide);
  return () => {
    stopObserving();
    view.document.removeEventListener("click", onClick, true);
    view.document.removeEventListener("submit", onSubmit, true);
    view.document.removeEventListener("visibilitychange", onHidden);
    view.removeEventListener("pagehide", onPageHide);
    // Leaving the portal (sign-out, account pages) sends what is waiting before stopping.
    recorder.flush();
    recorder.dispose();
  };
};
