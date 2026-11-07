// What: starts the desktop shell from its ports: resolves the site, restores the workspace windows,
// installs the app menu, the tray watchlist and the alert notifier, and wires quit and
// second-instance handling. The app keeps running in the tray when every window is closed.
// Used by: main.ts (with electron-ports.ts); tests pass fakes.
import { type AlertNotifier, createAlertNotifier } from "./alert-notifier.ts";
import { appMenu } from "./app-menu.ts";
import type { DesktopApi } from "./desktop-api.ts";
import type {
  EveryPort,
  MenuItemModel,
  NotifyPort,
  TrayPort,
  WindowFactory,
} from "./ports.ts";
import type { SettingsStore } from "./settings.ts";
import { resolveSiteOrigin } from "./site-url.ts";
import { createTrayWatchlist, type TrayWatchlist } from "./tray-watchlist.ts";
import { createWindowManager, type WindowManager } from "./window-manager.ts";
import { DEFAULT_WORKSPACE, workspaceForPath } from "./workspaces.ts";

export const MISSING_SITE_MESSAGE =
  "Set the Vertex site to open: start with --url=https://your-vertex-host or set VERTEX_DESKTOP_URL. Only https addresses (or http on localhost) are accepted.";

export type WindowFactoryOptions = Readonly<{
  siteOrigin: string;
  /** A same-site link asked for a new window; true when a workspace window took it. */
  openInside: (url: string) => boolean;
  /** A window finished a same-site navigation (for example after signing in). */
  onNavigated: () => void;
}>;

export type DesktopPorts = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  settings: SettingsStore;
  windowFactory: (options: WindowFactoryOptions) => WindowFactory;
  createTray: () => TrayPort;
  notify: NotifyPort;
  setAppMenu: (items: readonly MenuItemModel[]) => void;
  api: (siteOrigin: string) => DesktopApi;
  every: EveryPort;
  now: () => Date;
  quit: () => void;
  fatal: (message: string) => void;
  keepRunningWithoutWindows: () => void;
  onBeforeQuit: (listener: () => void) => void;
  onSecondInstance: (listener: () => void) => void;
}>;

export type DesktopShell = Readonly<{
  siteOrigin: string;
  windows: WindowManager;
  tray: TrayWatchlist;
  notifier: AlertNotifier;
}>;

export const startDesktop = (ports: DesktopPorts): DesktopShell | null => {
  const settings = ports.settings.load();
  const siteOrigin = resolveSiteOrigin({
    argv: ports.argv,
    env: ports.env,
    saved: settings.siteUrl,
  });
  if (siteOrigin === null) {
    ports.fatal(MISSING_SITE_MESSAGE);
    ports.quit();
    return null;
  }
  ports.settings.save({ ...settings, siteUrl: siteOrigin });

  const openInside = (url: string): boolean => {
    const target = new URL(url);
    const workspace = workspaceForPath(target.pathname);
    if (workspace === null) return false;
    windows.open(
      workspace.id,
      `${target.pathname}${target.search}${target.hash}`
    );
    return true;
  };
  const windows = createWindowManager({
    createWindow: ports.windowFactory({
      onNavigated: () => {
        if (tray.state().type !== "ready") void tray.refresh();
      },
      openInside,
      siteOrigin,
    }),
    settings: ports.settings,
    siteOrigin,
  });
  const api = ports.api(siteOrigin);
  const notifier = createAlertNotifier({
    api,
    every: ports.every,
    notify: ports.notify,
    now: ports.now,
    openWorkspace: (id) => windows.open(id),
  });
  const tray = createTrayWatchlist({
    actions: {
      openWorkspace: (id, path) => windows.open(id, path),
      quit: ports.quit,
      sendTestNotification: notifier.sendTest,
    },
    api,
    every: ports.every,
    tray: ports.createTray(),
  });

  ports.setAppMenu(
    appMenu({ openWorkspace: (id) => windows.open(id), quit: ports.quit })
  );
  ports.keepRunningWithoutWindows();
  ports.onBeforeQuit(() => {
    windows.beginQuit();
    tray.stop();
    notifier.stop();
  });
  ports.onSecondInstance(() =>
    windows.open(windows.openWorkspaces()[0] ?? DEFAULT_WORKSPACE)
  );

  windows.restore();
  tray.start();
  notifier.start();
  return { notifier, siteOrigin, tray, windows };
};
