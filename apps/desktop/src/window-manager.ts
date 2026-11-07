// What: one native window per workspace. Opening a workspace that is already open focuses its
// window (and loads the requested path, when one is given); closing a window remembers its bounds.
// The open-workspace list is saved as it changes. Quitting closes every window, so the list taken
// when the quit starts is written back once the quit really happens (a page can cancel it).
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
  /** A quit started (it may still be cancelled): remember which workspaces are open now. */
  readonly beginQuit: () => void;
  /** The quit is happening: save the list from beginQuit so the next start restores it. */
  readonly finishQuit: () => void;
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
  let quitSnapshot: readonly WorkspaceId[] | null = null;

  const persist = (openWorkspaces: readonly WorkspaceId[]) => {
    options.settings.save({ ...options.settings.load(), openWorkspaces });
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
    });
    // Forget the window only once it is gone: a page can still cancel a close.
    window.onClosed(() => {
      windows.delete(id);
      persist([...windows.keys()]);
    });
    window.load(url);
    window.focus();
    persist([...windows.keys()]);
  };

  return {
    beginQuit: () => {
      quitSnapshot = [...windows.keys()];
    },
    finishQuit: () => {
      if (quitSnapshot !== null) persist(quitSnapshot);
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
