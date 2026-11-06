// What: Test support for UI lab entry tests: jsdom mount with act, matchMedia stub and cleanup.
// Used by: apps/web/src/lab/**/*.test.tsx only.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

/** Browser APIs jsdom lacks: desktop-width matchMedia (sidebar) and scrollIntoView. */
const stubLabBrowser = (): void => {
  Reflect.set(window, "matchMedia", (query: string) => ({
    addEventListener: () => undefined,
    matches: false,
    media: query,
    removeEventListener: () => undefined,
  }));
  Reflect.set(Element.prototype, "scrollIntoView", () => undefined);
};

/** Renders, then lets effects and resolved promises settle for a few turns. */
export const mountLab = async (node: ReactNode): Promise<HTMLElement> => {
  stubLabBrowser();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  await act(async () => root.render(node));
  for (let turn = 0; turn < 20; turn += 1)
    await act(async () => {
      // apps/web targets a lib without Promise.withResolvers.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  return host;
};

export const unmountLab = async (): Promise<void> => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
};
