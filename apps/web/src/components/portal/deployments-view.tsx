"use client";

import {
  useCallback,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import {
  DeploymentRequestsWorkspace,
  type DeploymentRequestsWorkspaceProps,
} from "./deployment-requests-workspace.tsx";
import {
  DEPLOYMENT_VIEW_LABELS,
  DEPLOYMENT_VIEWS,
  isDeploymentView,
  type DeploymentView,
} from "./deployment-requests-model.ts";
import {
  DeploymentsWorkspace,
  type DeploymentsWorkspaceProps,
} from "./deployments-workspace.tsx";

// /deployments: the read-only QuantVPS monitor and the locked paper deployment requests, as two
// views selected by ?view= (monitor is the default and is omitted from the address bar). The server
// cannot see the query string here, so it renders no view and the client picks one after hydration.

export interface DeploymentsViewProps {
  readonly monitor?: DeploymentsWorkspaceProps;
  readonly requests?: DeploymentRequestsWorkspaceProps;
}

const readInitialView = (): DeploymentView => {
  const value = new URLSearchParams(window.location.search).get("view");
  return isDeploymentView(value) ? value : "monitor";
};

const subscribeToNothing = (): (() => void) => {
  return () => undefined;
};

const writeView = (view: DeploymentView): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (view === "monitor") {
    url.searchParams.delete("view");
    url.searchParams.delete("request");
    url.searchParams.delete("new");
  } else {
    url.searchParams.set("view", view);
    url.searchParams.delete("tab");
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

export const DeploymentsView = ({
  monitor = {},
  requests = {},
}: DeploymentsViewProps) => {
  const [selected, setSelected] = useState<DeploymentView | null>(null);
  const fromUrl = useSyncExternalStore(
    subscribeToNothing,
    readInitialView,
    () => null
  );
  const view = selected ?? fromUrl;
  const select = useCallback((next: DeploymentView) => {
    setSelected(next);
    return writeView(next);
  }, []);
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const index = view === null ? 0 : DEPLOYMENT_VIEWS.indexOf(view);
    const next =
      event.key === "Home"
        ? DEPLOYMENT_VIEWS[0]
        : event.key === "End"
          ? DEPLOYMENT_VIEWS.at(-1)
          : DEPLOYMENT_VIEWS[
              (index +
                (event.key === "ArrowRight"
                  ? 1
                  : DEPLOYMENT_VIEWS.length - 1)) %
                DEPLOYMENT_VIEWS.length
            ];
    if (next === undefined) return;
    select(next);
    document.getElementById(`deployments-view-${next}`)?.focus();
  };
  return (
    <div className="space-y-4">
      <div
        aria-label="Deployment views"
        className="flex gap-1 border-border border-b"
        onKeyDown={onKey}
        role="tablist"
      >
        {DEPLOYMENT_VIEWS.map((option) => {
          return (
            <button
              aria-controls={`deployments-panel-${option}`}
              aria-selected={view === option}
              className={`min-h-11 min-w-11 border-b-2 px-3 text-sm ${view === option ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              data-view={option}
              id={`deployments-view-${option}`}
              key={option}
              onClick={() => select(option)}
              role="tab"
              tabIndex={
                view === option || (view === null && option === "monitor")
                  ? 0
                  : -1
              }
              type="button"
            >
              {DEPLOYMENT_VIEW_LABELS[option]}
            </button>
          );
        })}
      </div>
      {view === null ? (
        <div aria-busy="true" data-deployments-view="pending" />
      ) : (
        <div
          aria-labelledby={`deployments-view-${view}`}
          id={`deployments-panel-${view}`}
          role="tabpanel"
        >
          {view === "monitor" ? (
            <DeploymentsWorkspace {...monitor} />
          ) : (
            <DeploymentRequestsWorkspace {...requests} />
          )}
        </div>
      )}
    </div>
  );
};
