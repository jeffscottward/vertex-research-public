import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("@darkfactory/auth/client", () => ({
  authClient: { useSession: { subscribe: authMocks.subscribe } },
}));

import {
  createResearchReadScope,
  observeResearchSessionScope,
  projectResearchSessionIdentity,
  ResearchReadScopeProvider,
  ResearchScopeContent,
  ResearchScopedWorkspace,
  type ResearchSessionSubscription,
} from "./read-scope.tsx";
import { createReadResource } from "./read-resource.ts";
import { createSignOutActionController } from "../account/sign-out-action.tsx";
import { SIGN_OUT_FAILED_MESSAGE } from "../account/sign-out-client.ts";
import {
  portalSignInHref,
  resolvePortalCallbackPath,
} from "../../lib/server-session.ts";

const expiresAt = "2030-01-01T00:00:00.000Z";
const principalKey = JSON.stringify(["user-1", "member", expiresAt]);
const sessionData = () => ({
  user: { id: "user-1", role: "member", status: "active" },
  session: { id: "session-1", expiresAt },
});
const settled = (data: unknown = sessionData()) => ({
  data,
  error: null,
  isPending: false,
  isRefetching: false,
});
const subscription = () => {
  let listener: (snapshot: unknown) => void = () => undefined;
  const unsubscribe = vi.fn();
  const subscribe: ResearchSessionSubscription = (next) => {
    listener = next;
    return unsubscribe;
  };
  return {
    subscribe,
    unsubscribe,
    emit: (snapshot: unknown) => listener(snapshot),
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
  return vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  return vi.restoreAllMocks();
});

describe("research principal/session privacy scope", () => {
  it("projects only nonsecret identity and never consumes token or personal-profile fields", () => {
    const data = sessionData();
    const secret = vi.fn(() => {
      throw new Error("must not read");
    });
    Object.defineProperty(data.session, "token", { get: secret });
    Object.defineProperty(data.user, "email", { get: secret });
    expect(projectResearchSessionIdentity(data)).toEqual({
      principalKey,
      sessionId: "session-1",
      expiresAt: new Date(expiresAt).getTime(),
    });
    expect(secret).not.toHaveBeenCalled();
    return expect(
      projectResearchSessionIdentity({
        ...data,
        session: { id: "session-1", expiresAt: new Date(expiresAt) },
      })?.principalKey
    ).toBe(principalKey);
  });

  it("fails closed for missing, expired, malformed, inactive, or accessor-backed projections", () => {
    for (const data of [
      null,
      {},
      { user: {}, session: {} },
      { ...sessionData(), user: { id: "", role: "member", status: "active" } },
      {
        ...sessionData(),
        user: { id: "user-1", role: "owner", status: "active" },
      },
      {
        ...sessionData(),
        user: { id: "user-1", role: "member", status: "disabled" },
      },
      ...[null, 123, "invalid", "2020-01-01T00:00:00Z"].map((expiry) => ({
        ...sessionData(),
        session: { id: "session-1", expiresAt: expiry },
      })),
      { ...sessionData(), session: { id: "x".repeat(257), expiresAt } },
      Object.defineProperty({}, "user", {
        get: () => {
          throw new Error("private");
        },
      }),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("private");
          },
        }
      ),
    ]) {
      expect(projectResearchSessionIdentity(data)).toBeNull();
    }
  });

  it("has an idempotent terminal retirement and unsubscribable checking/current transitions", () => {
    const scope = createResearchReadScope(false);
    const listener = vi.fn();
    const unsubscribe = scope.subscribe(listener);
    expect(scope.getPhase()).toBe("checking");
    scope.confirm();
    scope.confirm();
    expect(scope.isCurrent()).toBe(true);
    scope.pause();
    expect(scope.getPhase()).toBe("checking");
    scope.invalidate();
    scope.confirm();
    scope.pause();
    scope.invalidate();
    expect(scope.getPhase()).toBe("retired");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    scope.invalidate();
    return expect(listener).toHaveBeenCalledTimes(3);
  });

  it("observes the existing Better Auth atom, waits for matching authority, and cleans up the subscription and expiry timer", () => {
    const source = subscription();
    authMocks.subscribe.mockImplementation(source.subscribe);
    const scope = createResearchReadScope(false);
    const cleanup = observeResearchSessionScope(scope, principalKey);
    expect(authMocks.subscribe).toHaveBeenCalledOnce();
    source.emit({
      isPending: true,
      isRefetching: true,
      data: null,
      error: null,
    });
    expect(scope.getPhase()).toBe("checking");
    source.emit(settled());
    expect(scope.isCurrent()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    expect(source.unsubscribe).toHaveBeenCalledOnce();
    return expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a scope at the projected expiry without polling or an auth mutation", async () => {
    const source = subscription();
    const scope = createResearchReadScope(false);
    const nearExpiry = new Date(Date.now() + 100).toISOString();
    const key = JSON.stringify(["user-1", "member", nearExpiry]);
    const cleanup = observeResearchSessionScope(scope, key, source.subscribe);
    source.emit(
      settled({
        ...sessionData(),
        session: { id: "session-1", expiresAt: nearExpiry },
      })
    );
    expect(scope.isCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(scope.getPhase()).toBe("retired");
    return cleanup();
  });

  it("clears and aborts all three read kinds while the existing atom rechecks the session, discarding late responses", async () => {
    const source = subscription();
    const scope = createResearchReadScope(false);
    const cleanup = observeResearchSessionScope(
      scope,
      principalKey,
      source.subscribe
    );
    source.emit(settled());
    const completes: Array<(value: string) => void> = [];
    const signals: AbortSignal[] = [];
    const resources = ["module", "dataset", "evidence"].map(() =>
      createReadResource(
        (_input: string, signal) =>
          new Promise<string>((resolve) => {
            signals.push(signal);
            completes.push(resolve);
            return;
          }),
        12_000,
        scope
      )
    );
    const unsubscribes = resources.map((resource) =>
      resource.subscribe(() => undefined)
    );
    const pending = resources.map((resource) =>
      resource.load("prior-user-artifact")
    );
    source.emit({ ...settled(), isRefetching: true });
    expect(scope.getPhase()).toBe("checking");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const resource of resources)
      expect(resource.getSnapshot()).toMatchObject({
        type: "error",
        failure: { kind: "suspended" },
      });
    source.emit(settled());
    for (const complete of completes) complete("must not reappear");
    await Promise.all(pending);
    for (const resource of resources)
      expect(JSON.stringify(resource.getSnapshot())).not.toContain(
        "must not reappear"
      );
    for (const unsubscribe of unsubscribes) unsubscribe();
    return cleanup();
  });

  it("never reuses artifacts after a different user, session ID, role, or expiry is observed", async () => {
    const changed = [
      {
        ...sessionData(),
        user: { id: "user-2", role: "member", status: "active" },
      },
      { ...sessionData(), session: { id: "session-2", expiresAt } },
      {
        ...sessionData(),
        user: { id: "user-1", role: "admin", status: "active" },
      },
      {
        ...sessionData(),
        session: { id: "session-1", expiresAt: "2030-01-02T00:00:00.000Z" },
      },
    ];
    for (const data of changed) {
      const source = subscription();
      const scope = createResearchReadScope(false);
      const cleanup = observeResearchSessionScope(
        scope,
        principalKey,
        source.subscribe
      );
      source.emit(settled());
      const read = vi.fn(async () => "prior-user-artifact");
      const resource = createReadResource(read, 12_000, scope);
      const unsubscribe = resource.subscribe(() => undefined);
      await resource.load(undefined);
      source.emit(settled(data));
      expect(scope.getPhase()).toBe("retired");
      expect(JSON.stringify(resource.getSnapshot())).not.toContain(
        "prior-user-artifact"
      );
      source.emit(settled());
      await resource.load(undefined);
      expect(read).toHaveBeenCalledOnce();
      expect(scope.getPhase()).toBe("retired");
      resource.clear();
      expect(resource.getSnapshot()).toMatchObject({
        failure: { kind: "suspended" },
      });
      unsubscribe();
      cleanup();
    }
  });

  it("retires all artifacts on null authority or session-check failure without exposing its message", () => {
    for (const snapshot of [
      settled(null),
      { ...settled(), error: { message: "private session payload" } },
    ]) {
      const source = subscription();
      const scope = createResearchReadScope(false);
      const cleanup = observeResearchSessionScope(
        scope,
        principalKey,
        source.subscribe
      );
      source.emit(snapshot);
      const html = renderToStaticMarkup(
        <ResearchScopeContent scope={scope}>
          prior-user-artifact
        </ResearchScopeContent>
      );
      expect(html).toContain("Workspace data cleared");
      expect(html).not.toContain("prior-user-artifact");
      expect(html).not.toContain("private session payload");
      cleanup();
    }
  });

  it("retires sibling resources immediately when any read receives a typed unauthorized error", async () => {
    const scope = createResearchReadScope();
    const ready = createReadResource(
      async () => "prior-artifact",
      12_000,
      scope
    );
    const denied = createReadResource(
      async () => {
        throw { defined: true, code: "UNAUTHORIZED", status: 401 };
      },
      12_000,
      scope
    );
    const unsubscribe = ready.subscribe(() => undefined);
    await ready.load(undefined);
    await denied.load(undefined);
    expect(scope.getPhase()).toBe("retired");
    expect(JSON.stringify(ready.getSnapshot())).not.toContain("prior-artifact");
    return unsubscribe();
  });

  it("cannot resurrect a cached or pending response across scope revisions even without a mounted subscriber", async () => {
    const scope = createResearchReadScope();
    const ready = createReadResource(
      async () => "cached prior response",
      12_000,
      scope
    );
    await ready.load(undefined);
    let complete!: (value: string) => void;
    const pending = createReadResource(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
          return;
        }),
      12_000,
      scope
    );
    const operation = pending.load(undefined);
    scope.pause();
    scope.confirm();
    complete("late prior response");
    await operation;
    expect(JSON.stringify(ready.getSnapshot())).not.toContain(
      "cached prior response"
    );
    expect(JSON.stringify(pending.getSnapshot())).not.toContain(
      "late prior response"
    );
    await ready.load(undefined);
    return expect(ready.getSnapshot()).toEqual({
      type: "ready",
      value: "cached prior response",
    });
  });

  it("clears before strict sign-out begins and does not restore artifacts after an unconfirmed logout", async () => {
    const scope = createResearchReadScope();
    const resource = createReadResource(
      async () => "prior-artifact",
      12_000,
      scope
    );
    const unsubscribe = resource.subscribe(() => undefined);
    await resource.load(undefined);
    const gateway = {
      signOut: vi.fn(async () => {
        expect(scope.getPhase()).toBe("retired");
        expect(JSON.stringify(resource.getSnapshot())).not.toContain(
          "prior-artifact"
        );
        return { ok: false as const, message: SIGN_OUT_FAILED_MESSAGE };
      }),
    };
    const replace = vi.fn();
    const state = vi.fn();
    await createSignOutActionController(
      gateway,
      replace,
      scope.invalidate
    ).activate(state);
    expect(replace).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith({
      type: "error",
      message: SIGN_OUT_FAILED_MESSAGE,
    });
    expect(scope.getPhase()).toBe("retired");
    return unsubscribe();
  });

  it("does not let a failing presentation cleanup block strict sign-out", async () => {
    const signOut = vi.fn(async () => ({ ok: true as const }));
    const replace = vi.fn();
    await createSignOutActionController({ signOut }, replace, () => {
      throw new Error("view cleanup");
    }).activate(() => undefined);
    expect(signOut).toHaveBeenCalledOnce();
    return expect(replace).toHaveBeenCalledWith("/sign-in");
  });

  return it("renders research children only in a matching current scope and fails closed outside a provider", () => {
    const scope = createResearchReadScope(false);
    const view = (current = scope) =>
      renderToStaticMarkup(
        <ResearchReadScopeProvider scope={current}>
          <ResearchScopedWorkspace>
            private research content
          </ResearchScopedWorkspace>
        </ResearchReadScopeProvider>
      );
    expect(view()).toContain("Checking the workspace session");
    expect(view()).not.toContain("private research content");
    // Server markup keeps the creation-time phase so hydration matches it.
    scope.confirm();
    expect(view()).toContain("Checking the workspace session");
    expect(view()).not.toContain("private research content");
    scope.invalidate();
    expect(view()).toContain("Workspace data cleared");
    expect(view()).not.toContain("private research content");
    const verified = createResearchReadScope();
    expect(view(verified)).toContain("private research content");
    verified.invalidate();
    expect(view(verified)).not.toContain("private research content");
    const unscoped = (
      <ResearchScopedWorkspace>
        private research content
      </ResearchScopedWorkspace>
    );
    return expect(renderToStaticMarkup(unscoped)).not.toContain(
      "private research content"
    );
  });
});

describe("protected research callback allowlist", () =>
  it.each(["/modules", "/data", "/research"])(
    "preserves %s without broadening the origin or sibling-prefix rules",
    (path) => {
      const headers = new Headers({ "x-pathname": path });
      expect(resolvePortalCallbackPath(headers)).toBe(path);
      expect(portalSignInHref(headers)).toBe(
        `/sign-in?callbackURL=${encodeURIComponent(path)}`
      );
      for (const unsafe of [
        `${path}-other`,
        `https://outside.test${path}`,
        `//outside.test${path}`,
        `${path}\\outside`,
      ]) {
        expect(
          resolvePortalCallbackPath(new Headers({ "x-pathname": unsafe }))
        ).toBe("/dashboard");
      }
    }
  ));
