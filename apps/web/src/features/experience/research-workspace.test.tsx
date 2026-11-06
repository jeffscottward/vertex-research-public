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

// The stand-in renders the chat view's create-room form (id research-new-room) only for the
// "with-form" and "locked" threads, so the default render keeps no input at all.
vi.mock("./research-chat-room.tsx", () => ({
  ResearchChatRoom: ({
    scope,
    initialThreadId,
  }: {
    readonly scope: ExperienceScope;
    readonly initialThreadId?: string | null;
  }) => (
    <>
      <p data-testid="chat-room" data-thread={initialThreadId ?? "none"}>
        chat for {scope.accountAlias} / {scope.environment}
      </p>
      {initialThreadId === "with-form" || initialThreadId === "locked" ? (
        <details id="research-new-room">
          <summary>Create a research room</summary>
          <input disabled={initialThreadId === "locked"} name="title" />
        </details>
      ) : null}
    </>
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

const scopeStatus = (container: HTMLElement) =>
  container.querySelector("[data-research-scope-status]")?.textContent;
// A well-known node: the page header always renders the New room action.
const newRoom = (container: HTMLElement) =>
  container.querySelector(
    "[data-action='new-research-room']"
  ) as HTMLButtonElement;

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

  it("shows one Research h1 with the scope chip, a purpose line and New room", async () => {
    const container = await mount(() => Promise.resolve([research]));
    await vi.waitFor(() =>
      expect(scopeStatus(container)).toBe("Status:Research only")
    );
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("Research");
    expect(container.querySelector("header p")?.textContent).toBe(
      "Discuss evidence with corpus-based research agents. Research only: nothing here authorizes a trade."
    );
    expect(newRoom(container).disabled).toBe(false);
    expect(newRoom(container).textContent).toBe("New room");
    // No create-room form is mounted in this stand-in: New room does nothing.
    await act(async () => newRoom(container).click());
    expect(document.activeElement).toBe(document.body);
  });

  it("New room opens the create-room form and focuses its title", async () => {
    const container = await mount(
      () => Promise.resolve([research]),
      "with-form"
    );
    await vi.waitFor(() =>
      expect(container.querySelector("#research-new-room")).not.toBeNull()
    );
    const form = container.querySelector(
      "#research-new-room"
    ) as HTMLDetailsElement;
    expect(form.open).toBe(false);
    await act(async () => newRoom(container).click());
    expect(form.open).toBe(true);
    expect(document.activeElement).toBe(form.querySelector("input"));
  });

  it("New room focuses the form summary while the title field is locked", async () => {
    const container = await mount(() => Promise.resolve([research]), "locked");
    await vi.waitFor(() =>
      expect(container.querySelector("#research-new-room")).not.toBeNull()
    );
    await act(async () => newRoom(container).click());
    expect(document.activeElement?.textContent).toBe("Create a research room");
  });

  it("labels a live scope read only", async () => {
    const container = await mount(() =>
      Promise.resolve([{ accountAlias: "fictional-live", environment: "live" }])
    );
    await vi.waitFor(() =>
      expect(scopeStatus(container)).toBe("Status:Live scope · read only")
    );
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
    expect(scopeStatus(container)).toBe("Status:Paper scope");
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
    expect(scopeStatus(container)).toBe("Status:No scope yet");
    expect(newRoom(container).disabled).toBe(true);
  });
});
