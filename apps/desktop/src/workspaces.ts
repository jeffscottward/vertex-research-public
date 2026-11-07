// What: the portal workspaces the desktop shell opens as their own windows, and the URL helpers that
// map between a workspace and a site path. Display only; nothing here is a trading input.
// Used by: window-manager.ts, app-menu.ts, watchlist-menu.ts, alert-notifier.ts.

export const WORKSPACES = Object.freeze([
  { id: "dashboard", label: "Dashboard", path: "/dashboard" },
  { id: "charts", label: "Charts", path: "/charts" },
  { id: "watchlist", label: "Watchlist", path: "/watchlist" },
  { id: "price-alerts", label: "Alerts", path: "/price-alerts" },
  { id: "calendar", label: "Calendar", path: "/calendar" },
  { id: "journal", label: "Journal", path: "/journal" },
  { id: "news", label: "News", path: "/news" },
  { id: "markets", label: "Markets", path: "/markets" },
  { id: "assistant", label: "Quant", path: "/assistant" },
] as const);

export type Workspace = (typeof WORKSPACES)[number];
export type WorkspaceId = Workspace["id"];

export const DEFAULT_WORKSPACE: WorkspaceId = "dashboard";

export const isWorkspaceId = (value: unknown): value is WorkspaceId =>
  WORKSPACES.some((workspace) => workspace.id === value);

const WORKSPACE_BY_ID = Object.fromEntries(
  WORKSPACES.map((workspace) => [workspace.id, workspace])
) as Record<WorkspaceId, Workspace>;

export const workspaceById = (id: WorkspaceId): Workspace =>
  WORKSPACE_BY_ID[id];

/** The workspace whose path is `pathname` or a parent of it ("/charts/x" → charts). */
export const workspaceForPath = (pathname: string): Workspace | null =>
  WORKSPACES.find(
    (workspace) =>
      pathname === workspace.path || pathname.startsWith(`${workspace.path}/`)
  ) ?? null;

/** Absolute URL of `path` (a site path with optional query) on the site origin. */
export const siteUrlFor = (siteOrigin: string, path: string): string =>
  new URL(path, siteOrigin).toString();

export const windowTitle = (workspace: Workspace): string =>
  `Vertex · ${workspace.label}`;
