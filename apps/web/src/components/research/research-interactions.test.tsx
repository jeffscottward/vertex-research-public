import { Button } from "@darkfactory/ui";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DatasetManifest,
  ResearchEvidence,
} from "@darkfactory/api/vertex";

const hooks = vi.hoisted(() => {
  const states: Array<{ value: unknown }> = [];
  const effects: Array<{
    deps: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }> = [];
  const pending: Array<() => void> = [];
  let stateIndex = 0;
  let effectIndex = 0;
  return {
    begin: () => {
      stateIndex = 0;
      effectIndex = 0;
      return;
    },
    commit: () => {
      for (const effect of pending.splice(0)) effect();
      return;
    },
    cleanup: () => {
      for (const effect of effects) effect.cleanup?.();
      states.length = 0;
      effects.length = 0;
      pending.length = 0;
      return;
    },
    useState: <Value,>(initial: Value | (() => Value)) => {
      const index = stateIndex++;
      states[index] ??= {
        value:
          typeof initial === "function" ? (initial as () => Value)() : initial,
      };
      const setValue = (next: Value) => {
        states[index]!.value = next;
        return;
      };
      return [states[index]!.value as Value, setValue] as const;
    },
    useEffect: (
      effect: () => undefined | (() => void),
      deps: readonly unknown[]
    ) => {
      const index = effectIndex++;
      const previous = effects[index];
      if (
        previous !== undefined &&
        previous.deps.length === deps.length &&
        previous.deps.every((value, i) => Object.is(value, deps[i]))
      )
        return;
      return pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        effects[index] = {
          deps,
          cleanup: typeof cleanup === "function" ? cleanup : undefined,
        };
      });
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useContext: () => null,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}));

import { ModulesWorkspace } from "./research-workspace.tsx";
import { normalizeAuthDestination } from "../auth/auth-flow.ts";
import ResearchError from "../../app/(portal)/error.tsx";
import ResearchLoading from "../../app/(portal)/loading.tsx";

type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly id?: string;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly dataset?: DatasetManifest;
  readonly evidence?: ResearchEvidence;
}>;

const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
};

const render = (component: () => ReactNode): ReactNode => {
  hooks.begin();
  const tree = component();
  hooks.commit();
  return tree;
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const gatewayFixture = () => ({
  modules: vi.fn(async () => []),
  dataset: vi.fn(
    async (_id: string, _signal: AbortSignal): Promise<DatasetManifest> => {
      throw { defined: true, code: "NOT_FOUND", status: 404 };
    }
  ),
  evidence: vi.fn(
    async (
      _collection: string,
      _id: string,
      _signal: AbortSignal
    ): Promise<ResearchEvidence> => {
      throw { defined: true, code: "FORBIDDEN", status: 403 };
    }
  ),
});

afterEach(() => {
  hooks.cleanup();
  return vi.restoreAllMocks();
});

describe("wired readonly research interactions", () => {
  it("loads the module catalog on mount, supports explicit refresh, and never auto-retries", async () => {
    const gateway = gatewayFixture();
    const page = () => {
      // The public wrapper now selects explicit-scope or injected composition.
      // Descend its injected child before committing this source-only hook fake.
      const composed = ModulesWorkspace({ gateway });
      const Content = composed.type as (props: {
        readonly gateway: typeof gateway;
      }) => ReactNode;
      return Content({ gateway });
    };
    render(page);
    expect(gateway.modules).toHaveBeenCalledOnce();
    await settle();
    let tree = render(page);
    expect(renderToStaticMarkup(tree)).toContain("No modules returned");
    elements(tree)
      .find((node) => node.type === "button" || node.type === Button)
      ?.props.onClick?.();
    await settle();
    tree = render(page);
    expect(gateway.modules).toHaveBeenCalledTimes(2);
    return expect(renderToStaticMarkup(tree)).toContain("No modules returned");
  });

  it("announces route loading and exposes a real render-recovery action without raw errors", () => {
    const reset = vi.fn();
    const boundary = ResearchError({ reset });
    const html = renderToStaticMarkup(boundary);
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/dashboard"');
    elements(boundary)
      .find((node) => node.type === "button" || node.type === Button)
      ?.props.onClick?.();
    expect(reset).toHaveBeenCalledOnce();
    const loading = renderToStaticMarkup(<ResearchLoading />);
    expect(loading).toContain('role="status"');
    return expect(loading).toContain('aria-busy="true"');
  });

  return it("retains the existing auth normalizer for all local research routes", () => {
    for (const route of [
      "/modules",
      "/data",
      "/research",
      "/dashboard",
      "/account/security",
    ]) {
      expect(normalizeAuthDestination(route)).toBe(route);
    }
    for (const unsafe of [
      "https://outside.test/data",
      "//outside.test",
      "/api/private",
      "javascript:alert(1)",
    ]) {
      expect(normalizeAuthDestination(unsafe)).toBe("/dashboard");
    }
  });
});
