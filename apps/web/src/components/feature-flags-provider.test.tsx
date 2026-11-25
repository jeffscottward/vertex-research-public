// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS_STORAGE_KEY,
} from "../lib/feature-flags.ts";
import {
  type FeatureFlagsContextValue,
  FeatureFlagsProvider,
  FeatureGate,
  useFeatureFlag,
  useFeatureFlags,
} from "./feature-flags-provider.tsx";

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
  vi.restoreAllMocks();
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

describe("FeatureFlagsProvider and hooks", () => {
  it("provides default-off flags and safe no-op mutators outside a provider", async () => {
    const observed: { current: FeatureFlagsContextValue | null } = {
      current: null,
    };
    const Reader = () => {
      observed.current = useFeatureFlags();
      return (
        <FeatureGate
          fallback={<span>off-fallback</span>}
          flag="ui-experiments-panel"
        >
          <span>enabled-content</span>
        </FeatureGate>
      );
    };

    const container = await mount(<Reader />);
    expect(container.textContent).toBe("off-fallback");
    expect(observed.current).not.toBeNull();
    expect(observed.current?.flags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(observed.current?.allowClientOverrides).toBe(false);
    observed.current?.setOverride("ui-experiments-panel", true);
    observed.current?.clearOverrides();
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it("ignores localStorage, query params, and mutations when allowClientOverrides is false", async () => {
    window.localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      "ui-experiments-panel=on"
    );
    window.history.replaceState({}, "", "/?ff=research-prototype-slot");
    const observed: { current: FeatureFlagsContextValue | null } = {
      current: null,
    };

    const Reader = () => {
      observed.current = useFeatureFlags();
      return (
        <FeatureGate flag="ui-experiments-panel">
          <span>ui-on</span>
        </FeatureGate>
      );
    };

    const container = await mount(
      <FeatureFlagsProvider envOverrides={{ "research-prototype-slot": false }}>
        <Reader />
      </FeatureFlagsProvider>
    );

    expect(container.textContent).toBe("");
    expect(observed.current?.flags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(observed.current?.localOverrides).toEqual({});
    expect(observed.current?.queryOverrides).toEqual({});

    await act(async () => {
      observed.current?.setOverride("ui-experiments-panel", true);
      observed.current?.clearOverrides();
    });
    expect(observed.current?.flags["ui-experiments-panel"]).toBe(false);
  });

  it("reads localStorage and window.location.search when allowClientOverrides is true, and persists updates", async () => {
    window.localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      "research-prototype-slot=on"
    );
    window.history.replaceState({}, "", "/?ff=ui-experiments-panel=on");
    const observed: { current: FeatureFlagsContextValue | null } = {
      current: null,
    };

    const Reader = () => {
      observed.current = useFeatureFlags();
      const uiOn = useFeatureFlag("ui-experiments-panel");
      return (
        <div>
          <span data-ui={String(uiOn)} />
          <FeatureGate flag="research-prototype-slot">
            <span>research-enabled</span>
          </FeatureGate>
        </div>
      );
    };

    const container = await mount(
      <FeatureFlagsProvider allowClientOverrides envOverrides={{}}>
        <Reader />
      </FeatureFlagsProvider>
    );

    expect(container.querySelector("[data-ui]")?.getAttribute("data-ui")).toBe(
      "true"
    );
    expect(container.textContent).toContain("research-enabled");
    expect(observed.current?.resolved).toEqual([
      {
        enabled: true,
        name: "research-prototype-slot",
        source: "localStorage",
      },
      {
        enabled: true,
        name: "ui-experiments-panel",
        source: "query",
      },
    ]);

    await act(async () => {
      observed.current?.setOverride("research-prototype-slot", false);
    });
    expect(observed.current?.flags["research-prototype-slot"]).toBe(false);
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBe(
      "research-prototype-slot=off"
    );

    await act(async () => {
      observed.current?.setOverride("research-prototype-slot", null);
    });
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();

    await act(async () => {
      observed.current?.setOverride("research-prototype-slot", true);
    });
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBe(
      "research-prototype-slot=on"
    );

    await act(async () => {
      observed.current?.clearOverrides();
    });
    expect(observed.current?.localOverrides).toEqual({});
    expect(window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();

    // Browser history navigation (popstate) updates and clears ?ff= query overrides.
    window.history.pushState({}, "", "/settings/workspace");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(observed.current?.flags["ui-experiments-panel"]).toBe(false);

    window.history.pushState(
      {},
      "",
      "/settings/workspace?ff=research-prototype-slot"
    );
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(observed.current?.flags["research-prototype-slot"]).toBe(true);
  });

  it("syncs localStorage changes from storage events and uses explicit initialQuery when provided", async () => {
    window.history.replaceState({}, "", "/?ff=research-prototype-slot");
    const observed: { current: FeatureFlagsContextValue | null } = {
      current: null,
    };

    const Reader = () => {
      observed.current = useFeatureFlags();
      return null;
    };

    await mount(
      <FeatureFlagsProvider
        allowClientOverrides
        initialQuery={new URLSearchParams("ff=ui-experiments-panel")}
      >
        <Reader />
      </FeatureFlagsProvider>
    );

    expect(observed.current?.flags).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });

    window.localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      "research-prototype-slot=on"
    );
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "other-key" }));
    });
    expect(observed.current?.flags["research-prototype-slot"]).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: FEATURE_FLAGS_STORAGE_KEY })
      );
    });
    expect(observed.current?.flags["research-prototype-slot"]).toBe(true);

    window.localStorage.clear();
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(observed.current?.flags["research-prototype-slot"]).toBe(false);
  });

  it("handles localStorage access errors gracefully without throwing", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const observed: { current: FeatureFlagsContextValue | null } = {
      current: null,
    };

    const Reader = () => {
      observed.current = useFeatureFlags();
      return null;
    };

    await mount(
      <FeatureFlagsProvider allowClientOverrides>
        <Reader />
      </FeatureFlagsProvider>
    );

    expect(observed.current?.localOverrides).toEqual({});
    await act(async () => {
      observed.current?.setOverride("ui-experiments-panel", true);
    });
    expect(observed.current?.flags["ui-experiments-panel"]).toBe(true);
  });

  it("avoids extra re-renders on mount when no browser overrides are present", async () => {
    let renders = 0;
    const Counter = () => {
      useFeatureFlags();
      renders += 1;
      return null;
    };

    await mount(
      <FeatureFlagsProvider allowClientOverrides>
        <Counter />
      </FeatureFlagsProvider>
    );

    expect(renders).toBe(1);
  });
});
