// @vitest-environment jsdom
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
} from "../../components/research/read-scope.tsx";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import type { ExperienceScope, ExperienceServices } from "./ports.ts";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
  ScopeChooser,
} from "./shared.tsx";

// Owner rule (2026-10-30): pages list their data by default. The chooser reads
// the granted scopes and selects the first one; nobody types an alias.

const research: ExperienceScope = {
  accountAlias: "fictional-research",
  environment: "research",
};
const paper: ExperienceScope = {
  accountAlias: "fictional-paper",
  environment: "paper",
};

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const mount = async (
  scopes: ExperienceServices["reads"]["scopes"],
  prefer?: (scope: ExperienceScope) => boolean
): Promise<{
  container: HTMLDivElement;
  onSelect: Mock<(scope: ExperienceScope) => void>;
  onRetire: Mock<() => void>;
}> => {
  const base = createUnavailableExperienceServices();
  const services: ExperienceServices = {
    ...base,
    reads: { ...base.reads, scopes },
  };
  const onSelect = vi.fn<(scope: ExperienceScope) => void>();
  const onRetire = vi.fn<() => void>();
  const container = document.createElement("div");
  document.body.append(container);
  host = container;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ResearchReadScopeProvider scope={createResearchReadScope()}>
        <ExperienceProvider services={services}>
          <ScopeChooser
            label="Test account scope"
            onSelect={onSelect}
            onRetire={onRetire}
            {...(prefer === undefined ? {} : { prefer })}
          />
        </ExperienceProvider>
      </ResearchReadScopeProvider>
    );
    await Promise.resolve();
  });
  return { container, onSelect, onRetire };
};

describe("ScopeChooser", () => {
  it("selects the only granted scope without any text field", async () => {
    const { container, onSelect } = await mount(() =>
      Promise.resolve([research])
    );
    expect(onSelect).toHaveBeenCalledWith(research);
    expect(container.querySelector("input, textarea")).toBeNull();
    expect(container.textContent).toContain("fictional-research / research");
  });

  it("selects the first scope and switches with the list, retiring the old reads", async () => {
    const { container, onSelect, onRetire } = await mount(() =>
      Promise.resolve([research, paper])
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(research);
    const select = container.querySelector("select");
    expect(select?.value).toBe("fictional-research/research");
    expect(
      Array.from(select?.options ?? []).map((option) => option.textContent)
    ).toEqual([
      "fictional-research — Research — no live NAV",
      "fictional-paper — Paper — simulation observations",
    ]);
    await act(async () => {
      if (select) {
        select.value = "fictional-paper/paper";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(onRetire).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(paper);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("selects the first preferred scope, else the first scope", async () => {
    const isResearch = (scope: ExperienceScope) =>
      scope.environment === "research";
    const preferred = await mount(
      () => Promise.resolve([paper, research]),
      isResearch
    );
    expect(preferred.onSelect).toHaveBeenCalledExactlyOnceWith(research);
    act(() => root?.unmount());
    host?.remove();
    const fallback = await mount(() => Promise.resolve([paper]), isResearch);
    expect(fallback.onSelect).toHaveBeenCalledExactlyOnceWith(paper);
  });

  it("ignores a change to a value outside the granted list", async () => {
    const { container, onSelect, onRetire } = await mount(() =>
      Promise.resolve([research, paper])
    );
    const select = container.querySelector("select");
    await act(async () => {
      if (select) {
        const stray = document.createElement("option");
        stray.value = "not-granted/live";
        select.append(stray);
        select.value = "not-granted/live";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(onRetire).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("explains an empty list instead of showing a blank form", async () => {
    const { container, onSelect } = await mount(() => Promise.resolve([]));
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No account scopes yet");
    expect(container.textContent).toContain("without any typing");
    expect(container.querySelector("input, textarea, select")).toBeNull();
  });

  it("shows loading while the list is read", async () => {
    const { container } = await mount(() => new Promise(() => undefined));
    expect(container.textContent).toContain("Loading your account scopes");
  });

  it("shows the failure with a retry that reads again", async () => {
    const scopes = vi
      .fn<ExperienceServices["reads"]["scopes"]>()
      .mockRejectedValueOnce(new VertexReadError("unavailable"))
      .mockResolvedValueOnce([paper]);
    const { container, onSelect } = await mount(scopes);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Retry")
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(scopes).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith(paper);
  });

  it("withholds a duplicated scope list as malformed", async () => {
    const { container, onSelect } = await mount(() =>
      Promise.resolve([research, research])
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Source verification failed");
  });
});
