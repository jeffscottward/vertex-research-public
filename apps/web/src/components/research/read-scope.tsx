"use client";

import { alertTitleClassName, alertVariants } from "@darkfactory/ui";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { authClient } from "@darkfactory/auth/client";

// A privacy lifetime, not authentication authority. The existing server session
// gate and API still authorize every request. No auth state or artifacts persist here.
export type ResearchScopePhase = "checking" | "current" | "retired";
export interface ResearchReadScope {
  readonly getPhase: () => ResearchScopePhase;
  /**
   * Hydration snapshot: the phase this scope had when it was created, which is
   * also the phase the server rendered. Session checks that confirm the scope
   * before a subtree hydrates must not change it, or React sees different
   * markup on the server and the first client pass. Retirement is terminal and
   * always wins, so retired data is never hydrated.
   */
  readonly getServerPhase: () => ResearchScopePhase;
  readonly getRevision: () => number;
  readonly isCurrent: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly pause: () => void;
  readonly confirm: () => void;
  readonly invalidate: () => void;
}

export const createResearchReadScope = (
  initiallyVerified = true
): ResearchReadScope => {
  const initialPhase: ResearchScopePhase = initiallyVerified
    ? "current"
    : "checking";
  let phase: ResearchScopePhase = initialPhase;
  let revision = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ResearchScopePhase): void => {
    if (phase === "retired" || phase === next) return;
    phase = next;
    revision += 1;
    for (const listener of listeners) listener();
  };
  return {
    getPhase: () => phase,
    getServerPhase: () => (phase === "retired" ? "retired" : initialPhase),
    getRevision: () => revision,
    isCurrent: () => phase === "current",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        return;
      };
    },
    pause: () => publish("checking"),
    confirm: () => publish("current"),
    invalidate: () => publish("retired"),
  };
};

const own = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
};

const boundedId = (value: unknown): value is string => {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
};

// Deliberately ignore email, name, tokens, cookie material and other session fields.
export const projectResearchSessionIdentity = (
  data: unknown
): Readonly<{
  principalKey: string;
  sessionId: string;
  expiresAt: number;
}> | null => {
  const user = own(data, "user");
  const session = own(data, "session");
  const userId = own(user, "id");
  const role = own(user, "role");
  const sessionId = own(session, "id");
  const expiry = own(session, "expiresAt");
  if (
    !(boundedId(userId) && boundedId(sessionId)) ||
    (role !== "member" && role !== "admin") ||
    own(user, "status") !== "active"
  )
    return null;
  if (!(typeof expiry === "string" || expiry instanceof Date)) return null;
  const expiresAt =
    expiry instanceof Date
      ? Date.prototype.getTime.call(expiry)
      : new Date(expiry).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return {
    principalKey: JSON.stringify([
      userId,
      role,
      new Date(expiresAt).toISOString(),
    ]),
    sessionId,
    expiresAt,
  };
};

export type ResearchSessionSubscription = (
  listener: (snapshot: unknown) => void
) => () => void;

export const observeResearchSessionScope = (
  scope: ResearchReadScope,
  expectedPrincipalKey: string,
  subscribe: ResearchSessionSubscription = (listener) =>
    authClient.useSession.subscribe(listener)
): (() => void) => {
  let sessionId: string | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribe((snapshot) => {
    clearTimeout(expiryTimer);
    if (scope.getPhase() === "retired") return;
    if (own(snapshot, "error")) {
      scope.invalidate();
      return;
    }
    if (
      own(snapshot, "isPending") === true ||
      own(snapshot, "isRefetching") === true
    ) {
      scope.pause();
      return;
    }
    const identity = projectResearchSessionIdentity(own(snapshot, "data"));
    if (
      identity === null ||
      identity.principalKey !== expectedPrincipalKey ||
      (sessionId !== undefined && sessionId !== identity.sessionId)
    ) {
      scope.invalidate();
      return;
    }
    sessionId = identity.sessionId;
    scope.confirm();
    const expire = () => {
      const remaining = identity.expiresAt - Date.now();
      if (remaining <= 0) {
        scope.invalidate();
        return;
      }
      expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    return expire();
  });
  return () => {
    clearTimeout(expiryTimer);
    return unsubscribe();
  };
};

const ResearchScopeContext = createContext<ResearchReadScope | null>(null);
const ScopeProvider = ResearchScopeContext.Provider;

export const ResearchReadScopeProvider = ({
  scope,
  children,
}: {
  readonly scope: ResearchReadScope;
  readonly children: ReactNode;
}) => <ScopeProvider value={scope}>{children}</ScopeProvider>;

export const useResearchReadScope = (): ResearchReadScope | null =>
  useContext(ResearchScopeContext);

export const ResearchScopeContent = ({
  scope,
  children,
}: {
  readonly scope: ResearchReadScope;
  readonly children: ReactNode;
}) => {
  // The server snapshot is the creation-time phase (see getServerPhase). After
  // hydration React reads getPhase and moves to the real phase.
  const phase = useSyncExternalStore(
    scope.subscribe,
    scope.getPhase,
    scope.getServerPhase
  );
  if (phase === "checking") {
    return (
      <div className={alertVariants()} role="status" aria-busy="true">
        Checking the workspace session before displaying research data…
      </div>
    );
  }
  if (phase === "retired") {
    return (
      <section className={alertVariants()} role="status" aria-live="polite">
        <h2 className={alertTitleClassName}>Workspace data cleared</h2>
        <p>
          Sign-out or a session change ended this view. The page will not reuse
          previous artifacts or pending reads. This restriction applies even
          when sign-out remains unconfirmed.
        </p>
        <a className="vx-text-link" href="/dashboard">
          Verify the workspace session
        </a>
      </section>
    );
  }
  return children;
};

export const ResearchScopedWorkspace = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const scope = useResearchReadScope();
  if (scope === null) {
    return (
      <div className={alertVariants()} role="alert">
        This view cannot verify the research session. Reopen the workspace to
        verify access.
      </div>
    );
  }
  return <ResearchScopeContent scope={scope}>{children}</ResearchScopeContent>;
};
