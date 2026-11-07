// What: one native window per workspace. Opening a workspace that is already open focuses its
// window (and loads the requested path, when one is given); closing a window remembers its bounds.
// The set of open workspaces is saved so the next start restores them, except while the app quits.
// Used by: app.ts.
import type { WindowFactory, WorkspaceWindow } from "./ports.ts";
import type { SettingsStore } from "./settings.ts";
import {
  DEFAULT_WORKSPACE,
  siteUrlFor,
  type WorkspaceId,
  windowTitle,
  workspaceById,
} from "./workspaces.ts";

export interface WindowManager {
  /** Stop forgetting windows as they close: the app is quitting and they should come back. */
  readonly beginQuit: () => void;
  /** Focus or create the workspace window; `path` (site path with query) overrides its home. */
  readonly open: (id: WorkspaceId, path?: string) => void;
  readonly openWorkspaces: () => readonly WorkspaceId[];
  /** Reopen the workspaces that were open at the last quit (the dashboard when none). */
  readonly restore: () => void;
}

export const createWindowManager = (
  options: Readonly<{
    siteOrigin: string;
    createWindow: WindowFactory;
    settings: SettingsStore;
  }>
): WindowManager => {
  const windows = new Map<WorkspaceId, WorkspaceWindow>();
  let quitting = false;

  const persist = () => {
    const current = options.settings.load();
    options.settings.save({
      ...current,
      openWorkspaces: quitting ? current.openWorkspaces : [...windows.keys()],
    });
  };

  const open = (id: WorkspaceId, path?: string) => {
    const workspace = workspaceById(id);
    const url = siteUrlFor(options.siteOrigin, path ?? workspace.path);
    const existing = windows.get(id);
    if (existing !== undefined) {
      if (path !== undefined) existing.load(url);
      existing.focus();
      return;
    }
    const window = options.createWindow({
      bounds: options.settings.load().bounds[id],
      title: windowTitle(workspace),
      workspaceId: id,
    });
    windows.set(id, window);
    window.onClose(() => {
      const current = options.settings.load();
      options.settings.save({
        ...current,
        bounds: { ...current.bounds, [id]: window.bounds() },
      });
      windows.delete(id);
      persist();
    });
    window.load(url);
    window.focus();
    persist();
  };

  return {
    beginQuit: () => {
      quitting = true;
    },
    open,
    openWorkspaces: () => [...windows.keys()],
    restore: () => {
      const saved = options.settings.load().openWorkspaces;
      for (const id of saved.length === 0 ? [DEFAULT_WORKSPACE] : saved)
        open(id);
    },
  };
};
