// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@darkfactory/auth/client", () => ({
  authClient: { useSession: { subscribe: vi.fn() } },
}));

import {
  createResearchReadScope,
  type ResearchReadScope,
  ResearchReadScopeProvider,
  ResearchScopedWorkspace,
} from "./read-scope.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const tree = (scope: ResearchReadScope) => (
  <ResearchReadScopeProvider scope={scope}>
    <ResearchScopedWorkspace>
      <p>private research content</p>
    </ResearchScopedWorkspace>
  </ResearchReadScopeProvider>
);

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  return vi.restoreAllMocks();
});

// Renders the server HTML, lets `beforeHydration` change the scope the way the
// portal shell's session effect can before a deferred subtree hydrates, then
// hydrates and returns every recoverable (hydration) error React reported.
const hydrate = (
  scope: ResearchReadScope,
  beforeHydration: () => void = () => undefined
) => {
  const serverHtml = renderToString(tree(scope));
  host = document.createElement("div");
  host.innerHTML = serverHtml;
  document.body.append(host);
  beforeHydration();
  const recoverable: unknown[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
    return;
  });
  act(() => {
    root = hydrateRoot(host as HTMLElement, tree(scope), {
      onRecoverableError: (error) => {
        recoverable.push(error);
      },
    });
  });
  return { serverHtml, recoverable, consoleErrors: consoleError.mock.calls };
};

describe("research scope hydration (audit P0-2)", () => {
  it("hydrates the server's checking notice when the session was confirmed before hydration, then shows content", () => {
    const scope = createResearchReadScope(false);
    const result = hydrate(scope, () => scope.confirm());
    expect(result.serverHtml).toContain("Checking the workspace session");
    expect(result.serverHtml).not.toContain("private research content");
    expect(result.recoverable).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(host?.textContent).toContain("private research content");
  });

  it("hydrates a pre-verified scope without a mismatch", () => {
    const result = hydrate(createResearchReadScope());
    expect(result.serverHtml).toContain("private research content");
    expect(result.recoverable).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(host?.textContent).toContain("private research content");
  });

  it("moves to the real phase after hydration and clears content on retirement", () => {
    const scope = createResearchReadScope(false);
    const result = hydrate(scope);
    expect(result.recoverable).toEqual([]);
    expect(host?.textContent).toContain("Checking the workspace session");
    act(() => scope.confirm());
    expect(host?.textContent).toContain("private research content");
    act(() => scope.invalidate());
    expect(host?.textContent).toContain("Workspace data cleared");
    expect(host?.textContent).not.toContain("private research content");
  });

  it("never hydrates content into a scope that was retired before hydration", () => {
    const scope = createResearchReadScope();
    const result = hydrate(scope, () => scope.invalidate());
    expect(result.serverHtml).toContain("private research content");
    expect(host?.textContent).toContain("Workspace data cleared");
    expect(host?.textContent).not.toContain("private research content");
  });
});
