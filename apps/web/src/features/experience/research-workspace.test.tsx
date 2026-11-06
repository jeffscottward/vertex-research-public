// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
} from "../../components/research/read-scope.tsx";
import type { ExperienceScope, ExperienceServices } from "./ports.ts";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
} from "./shared.tsx";
import { ResearchWorkspace } from "./research.tsx";

// Owner rule (2026-10-30): Research opens on the first granted scope, and no
// exact-ID lookup (job collection, evidence, dataset chart) remains.

vi.mock("./research-chat-room.tsx", () => ({
  ResearchChatRoom: ({
    scope,
    initialThreadId,
  }: {
    readonly scope: ExperienceScope;
    readonly initialThreadId?: string | null;
  }) => (
    <p data-testid="chat-room" data-thread={initialThreadId ?? "none"}>
      chat for {scope.accountAlias} / {scope.environment}
    </p>
  ),
}));

const research: ExperienceScope = {
  accountAlias: "fictional-research",
  environment: "research",
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
  initialThreadId?: string
): Promise<HTMLDivElement> => {
  const base = createUnavailableExperienceServices();
  const services: ExperienceServices = {
    ...base,
    reads: { ...base.reads, scopes },
  };
  const container = document.createElement("div");
  document.body.append(container);
  host = container;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ResearchReadScopeProvider scope={createResearchReadScope()}>
        <ExperienceProvider services={services}>
          <ResearchWorkspace
            {...(initialThreadId === undefined ? {} : { initialThreadId })}
          />
        </ExperienceProvider>
      </ResearchReadScopeProvider>
    );
    await Promise.resolve();
  });
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
  return container;
};

describe("ResearchWorkspace", () => {
  it("opens the chat room on the first granted scope with no ID fields", async () => {
    const container = await mount(() => Promise.resolve([research]));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "chat for fictional-research / research"
      )
    );
    expect(container.querySelector("input, textarea, form")).toBeNull();
    expect(container.textContent).not.toMatch(/collection ID|evidence ID/i);
    expect(
      container.querySelector('a[href="/strategies"]')?.textContent
    ).toContain("Exact-version strategy review");
    expect(
      container.querySelector('a[href="/assistant"]')?.textContent
    ).toContain("Open the research assistant");
    expect(
      container.querySelector('a[href="/research/reports"]')?.textContent
    ).toBe("Research dossiers");
    expect(
      container.querySelector('a[href="/knowledge"]')?.textContent
    ).toContain("Open the knowledge chat");
  });

  it("opens the given initial thread instead of waiting for a pick", async () => {
    const container = await mount(
      () => Promise.resolve([research]),
      "fictional-thread"
    );
    await vi.waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="chat-room"]')
          ?.getAttribute("data-thread")
      ).toBe("fictional-thread")
    );
  });

  it("reopens the chat room on the scope chosen from the list", async () => {
    const paper: ExperienceScope = {
      accountAlias: "fictional-paper",
      environment: "paper",
    };
    const container = await mount(() => Promise.resolve([research, paper]));
    const select = container.querySelector("select");
    await act(async () => {
      if (select) {
        select.value = "fictional-paper/paper";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "chat for fictional-paper / paper"
      )
    );
  });

  it("prefers a research scope even when a paper scope is listed first", async () => {
    const paper: ExperienceScope = {
      accountAlias: "a-fictional-paper",
      environment: "paper",
    };
    const container = await mount(() => Promise.resolve([paper, research]));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "chat for fictional-research / research"
      )
    );
  });

  it("explains an empty scope list instead of opening a chat", async () => {
    const container = await mount(() => Promise.resolve([]));
    expect(container.textContent).toContain("No account scopes yet");
    expect(container.querySelector('[data-testid="chat-room"]')).toBeNull();
  });
});
