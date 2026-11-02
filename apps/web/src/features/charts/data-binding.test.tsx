import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperienceScope } from "../experience/ports.ts";

// Match the adjacent Experience tests' source-only hook harness. This exercises
// returned element handlers/keys, not browser effects or a mounted React tree.
const hooks = vi.hoisted(() => {
  const states: Array<{ value: unknown }> = [];
  let index = 0;
  return {
    begin: () => {
      index = 0;
    },
    clear: () => {
      states.length = 0;
      index = 0;
    },
    useState: <Value,>(initial: Value | (() => Value)) => {
      const slot = index++;
      states[slot] ??= {
        value:
          typeof initial === "function" ? (initial as () => Value)() : initial,
      };
      return [
        states[slot]!.value as Value,
        (next: Value | ((previous: Value) => Value)) => {
          states[slot]!.value =
            typeof next === "function"
              ? (next as (previous: Value) => Value)(
                  states[slot]!.value as Value
                )
              : next;
          return;
        },
      ] as const;
    },
  };
});
const api = vi.hoisted(() => ({
  createApiClient: vi.fn(() => {
    throw new Error(
      "No RPC client may be created during chart SSR or scope selection"
    );
  }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useMemo: <Value,>(factory: () => Value) => factory(),
  useId: () => "synthetic-chart-scope",
}));
vi.mock("@darkfactory/api/client", () => ({
  createApiClient: api.createApiClient,
}));

import { ScopedArtifactReads } from "./data-binding.tsx";
import { ScopeChooser } from "../experience/shared.tsx";

const scope: ExperienceScope = {
  accountAlias: "synthetic-selected-account",
  environment: "paper",
};
type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly onSelect?: (value: ExperienceScope) => void;
  readonly onRetire?: () => void;
}>;
const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  const children: Interactive[] = [];
  Children.forEach(node.props.children, (child) => {
    children.push(...elements(child));
    return;
  });
  return [node, ...children];
};
const render = (component: () => ReactNode): ReactNode => {
  hooks.begin();
  return component();
};

afterEach(() => {
  hooks.clear();
  vi.clearAllMocks();
  return vi.unstubAllGlobals();
});

describe("artifact reads choose a granted scope (authored; unexecuted)", () => {
  it("does not instantiate an artifact reader or render its child before a scope is chosen", () => {
    vi.stubGlobal("window", undefined);
    const children = vi.fn(() => <p>synthetic-artifact-child</p>);
    const html = renderToStaticMarkup(
      <ScopedArtifactReads>{children}</ScopedArtifactReads>
    );
    expect(html).toContain("Loading your account scopes");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("synthetic-artifact-child");
    expect(children).not.toHaveBeenCalled();
    return expect(api.createApiClient).not.toHaveBeenCalled();
  });
  return it("keys children to the chosen scope and removes them when it retires", () => {
    const children = vi.fn(() => <p>synthetic-artifact-child</p>);
    const component = () => ScopedArtifactReads({ children });
    let tree = render(component);
    elements(tree).find((node) => node.type === ScopeChooser)!.props.onSelect!(
      scope
    );
    tree = render(component);
    expect(children).toHaveBeenCalledOnce();
    expect(
      elements(tree).some((node) => node.key === JSON.stringify(scope))
    ).toBe(true);
    elements(tree).find((node) => node.type === ScopeChooser)!.props
      .onRetire!();
    tree = render(component);
    expect(
      elements(tree).some((node) => node.key === JSON.stringify(scope))
    ).toBe(false);
    expect(children).toHaveBeenCalledOnce();
    return expect(api.createApiClient).not.toHaveBeenCalled();
  });
});
