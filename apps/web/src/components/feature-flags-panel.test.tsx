// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FEATURE_FLAGS_STORAGE_KEY } from "../lib/feature-flags.ts";
import { FeatureFlagsPanel } from "./feature-flags-panel.tsx";
import { FeatureFlagsProvider } from "./feature-flags-provider.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = async (node: ReactNode): Promise<HTMLDivElement> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  return host;
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

describe("FeatureFlagsPanel", () => {
  it("renders nothing in production when all flags remain off", async () => {
    const container = await mount(
      <FeatureFlagsProvider allowClientOverrides={false} envOverrides={{}}>
        <FeatureFlagsPanel />
      </FeatureFlagsProvider>
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders only the gated smoke banner in production when enabled via env", async () => {
    const container = await mount(
      <FeatureFlagsProvider
        allowClientOverrides={false}
        envOverrides={{ "ui-experiments-panel": true }}
      >
        <FeatureFlagsPanel />
      </FeatureFlagsProvider>
    );
    expect(
      container.querySelector(
        '[data-feature-flag-smoke="ui-experiments-panel"]'
      )
    ).not.toBeNull();
    expect(container.querySelector("[data-feature-flags-panel]")).toBeNull();
  });

  it("renders only the research smoke banner in production when enabled via env alone", async () => {
    const container = await mount(
      <FeatureFlagsProvider
        allowClientOverrides={false}
        envOverrides={{ "research-prototype-slot": true }}
      >
        <FeatureFlagsPanel serverPreviewActive={false} />
      </FeatureFlagsProvider>
    );
    expect(
      container.querySelector(
        '[data-feature-flag-smoke="research-prototype-slot"]'
      )
    ).not.toBeNull();
    expect(container.querySelector("[data-feature-flags-panel]")).toBeNull();
  });

  it("marks server-active preview when serverPreviewActive is true", async () => {
    const container = await mount(
      <FeatureFlagsProvider allowClientOverrides={false} envOverrides={{}}>
        <FeatureFlagsPanel serverPreviewActive />
      </FeatureFlagsProvider>
    );
    expect(
      container
        .querySelector("[data-feature-flags-section]")
        ?.getAttribute("data-server-ui-preview")
    ).toBe("on");
  });

  it("renders dev/viewer switches, toggles localStorage overrides, and resets them", async () => {
    const container = await mount(
      <FeatureFlagsProvider allowClientOverrides envOverrides={{}}>
        <FeatureFlagsPanel />
      </FeatureFlagsProvider>
    );

    expect(
      container.querySelector("[data-feature-flags-panel]")
    ).not.toBeNull();
    expect(container.querySelector("[data-feature-flag-smoke]")).toBeNull();
    expect(container.querySelector("[data-feature-flags-reset]")).toBeNull();

    const uiToggle = container.querySelector<HTMLButtonElement>(
      '[data-feature-flag-toggle="ui-experiments-panel"]'
    );
    expect(uiToggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      uiToggle?.click();
    });

    expect(uiToggle?.getAttribute("aria-checked")).toBe("true");
    expect(
      container.querySelector(
        '[data-feature-flag-smoke="ui-experiments-panel"]'
      )
    ).not.toBeNull();
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBe(
      "ui-experiments-panel=on"
    );

    const resetButton = container.querySelector<HTMLButtonElement>(
      "[data-feature-flags-reset]"
    );
    expect(resetButton).not.toBeNull();

    await act(async () => {
      resetButton?.click();
    });

    expect(uiToggle?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("[data-feature-flag-smoke]")).toBeNull();
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it("locks query-overridden switches and shows both smoke banners when enabled via query", async () => {
    const container = await mount(
      <FeatureFlagsProvider
        allowClientOverrides
        initialQuery="ff=ui-experiments-panel,research-prototype-slot"
      >
        <FeatureFlagsPanel />
      </FeatureFlagsProvider>
    );

    expect(
      container.querySelector(
        '[data-feature-flag-smoke="ui-experiments-panel"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-feature-flag-smoke="research-prototype-slot"]'
      )
    ).not.toBeNull();

    const researchToggle = container.querySelector<HTMLButtonElement>(
      '[data-feature-flag-toggle="research-prototype-slot"]'
    );
    expect(researchToggle?.disabled).toBe(true);
    expect(container.textContent).toContain("controlled by ?ff= query param");
  });
});
