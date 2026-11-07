// What: the only Electron adapter. Builds hardened workspace windows (isolated, sandboxed, no Node,
// one persistent session for the site), the tray, native notifications, menus and app lifecycle
// hooks behind the ports in ports.ts and app.ts. Same-site links stay in the app; other http(s)
// links open in the system browser; every other scheme is blocked. Only clipboard writes and
// fullscreen are granted to the page: the shell itself delivers alert notifications.
// Used by: main.ts.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  type Session,
  session,
  shell,
  Tray,
} from "electron";

import type { DesktopPorts, WindowFactoryOptions } from "./app.ts";
import { createDesktopApi } from "./desktop-api.ts";
import type { MenuItemModel, WindowFactory } from "./ports.ts";
import { createFileSettingsStore } from "./settings.ts";
import { classifyNavigation } from "./site-url.ts";

/** One persistent session for every window and API call, so one sign-in covers them all. */
export const SITE_PARTITION = "persist:vertex";
export const GRANTED_PERMISSIONS: readonly string[] = [
  "clipboard-sanitized-write",
  "fullscreen",
];
const DEFAULT_SIZE = Object.freeze({ height: 900, width: 1440 });

const assetPath = (name: string): string =>
  fileURLToPath(new URL(`../assets/${name}`, import.meta.url));

export const toElectronMenu = (
  items: readonly MenuItemModel[]
): MenuItemConstructorOptions[] =>
  items.map((item): MenuItemConstructorOptions => {
    if (item.type === "separator") return { type: "separator" };
    if (item.type === "role") return { role: item.role };
    if (item.type === "submenu")
      return { label: item.label, submenu: toElectronMenu(item.items) };
    return {
      enabled: item.enabled ?? true,
      label: item.label,
      ...(item.accelerator === undefined
        ? {}
        : { accelerator: item.accelerator }),
      ...(item.onClick === undefined ? {} : { click: item.onClick }),
    };
  });

/** Grant only GRANTED_PERMISSIONS, and only to pages on the site origin. */
export const hardenSession = (target: Session, siteOrigin: string): void => {
  const allowed = (permission: string, requestingUrl: string) =>
    GRANTED_PERMISSIONS.includes(permission) &&
    classifyNavigation(siteOrigin, requestingUrl) === "inside";
  target.setPermissionRequestHandler(
    (_contents, permission, callback, details) =>
      callback(allowed(permission, details.requestingUrl))
  );
  target.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin)
  );
};

export const createWindowFactory = (
  options: WindowFactoryOptions
): WindowFactory => {
  hardenSession(session.fromPartition(SITE_PARTITION), options.siteOrigin);
  const icon = nativeImage.createFromPath(assetPath("icon.png"));
  return (request) => {
    const window = new BrowserWindow({
      ...(request.bounds ?? DEFAULT_SIZE),
      backgroundColor: "#09090b",
      icon,
      title: request.title,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: SITE_PARTITION,
        sandbox: true,
        webSecurity: true,
      },
    });
    const contents = window.webContents;
    const leaveSite = (url: string): boolean => {
      const target = classifyNavigation(options.siteOrigin, url);
      if (target === "external") void shell.openExternal(url);
      return target !== "inside";
    };
    contents.setWindowOpenHandler(({ url }) => {
      if (!(leaveSite(url) || options.openInside(url)))
        contents.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => {
      if (leaveSite(event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (leaveSite(event.url)) event.preventDefault();
    });
    contents.on("did-navigate", (_event, url) => {
      if (classifyNavigation(options.siteOrigin, url) === "inside")
        options.onNavigated();
    });
    // Keep "Vertex · <workspace>" so each window stays identifiable in the task switcher.
    window.on("page-title-updated", (event) => event.preventDefault());
    return {
      bounds: () => window.getBounds(),
      focus: () => {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      },
      load: (url) => {
        // A failed load leaves the window on its last page; the user can reload from the menu.
        contents.loadURL(url).catch(() => undefined);
      },
      onClose: (listener) => {
        window.once("close", listener);
      },
    };
  };
};

/** Notifications live until closed so their click handler is not garbage collected. */
const shownNotifications = new Set<Notification>();

export const createElectronPorts = (): DesktopPorts => ({
  api: (siteOrigin) =>
    createDesktopApi({
      fetch: (request) =>
        session
          .fromPartition(SITE_PARTITION)
          .fetch(request, { credentials: "include" }),
      siteOrigin,
    }),
  argv: process.argv,
  createTray: () => {
    const tray = new Tray(nativeImage.createFromPath(assetPath("tray.png")));
    return {
      setMenu: (items) =>
        tray.setContextMenu(Menu.buildFromTemplate(toElectronMenu(items))),
      setToolTip: (text) => tray.setToolTip(text),
    };
  },
  env: process.env,
  every: (ms, task) => {
    const timer = setInterval(task, ms);
    return () => clearInterval(timer);
  },
  fatal: (message) => dialog.showErrorBox("Vertex", message),
  keepRunningWithoutWindows: () => {
    // Listening replaces Electron's quit-on-last-window: the tray keeps the app running.
    app.on("window-all-closed", () => undefined);
  },
  notify: ({ body, onClick, title }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      body,
      icon: nativeImage.createFromPath(assetPath("icon.png")),
      title,
    });
    shownNotifications.add(notification);
    notification.on("close", () => shownNotifications.delete(notification));
    if (onClick !== undefined) notification.on("click", onClick);
    notification.show();
  },
  now: () => new Date(),
  onBeforeQuit: (listener) => {
    app.on("before-quit", listener);
  },
  onSecondInstance: (listener) => {
    app.on("second-instance", listener);
  },
  quit: () => app.quit(),
  setAppMenu: (items) =>
    Menu.setApplicationMenu(Menu.buildFromTemplate(toElectronMenu(items))),
  settings: createFileSettingsStore(
    join(app.getPath("userData"), "settings.json")
  ),
  windowFactory: createWindowFactory,
});
