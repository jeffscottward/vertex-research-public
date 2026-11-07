import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;
  const appListeners = new Map<string, Listener>();
  const session = {
    fetch: vi.fn(async () => new Response("{}")),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  };
  const windows: FakeBrowserWindow[] = [];
  class FakeBrowserWindow {
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Listener>();
    readonly contentsListeners = new Map<string, Listener>();
    openHandler: Listener | undefined;
    minimized = false;
    readonly calls: string[] = [];
    readonly webContents = {
      loadURL: vi.fn(async (_url: string) => undefined),
      on: (event: string, listener: Listener) => {
        this.contentsListeners.set(event, listener);
      },
      setWindowOpenHandler: (handler: Listener) => {
        this.openHandler = handler;
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      windows.push(this);
    }
    focus() {
      this.calls.push("focus");
    }
    getBounds() {
      return { height: 1, width: 2, x: 3, y: 4 };
    }
    isMinimized() {
      return this.minimized;
    }
    on(event: string, listener: Listener) {
      this.listeners.set(event, listener);
    }
    once(event: string, listener: Listener) {
      this.listeners.set(event, listener);
    }
    restore() {
      this.calls.push("restore");
    }
    show() {
      this.calls.push("show");
    }
  }
  const notifications: FakeNotification[] = [];
  class FakeNotification {
    static supported = true;
    static isSupported() {
      return FakeNotification.supported;
    }
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Listener>();
    shown = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      notifications.push(this);
    }
    on(event: string, listener: Listener) {
      this.listeners.set(event, listener);
    }
    show() {
      this.shown = true;
    }
  }
  const trays: FakeTray[] = [];
  class FakeTray {
    readonly image: unknown;
    menu: unknown;
    toolTip = "";
    constructor(image: unknown) {
      this.image = image;
      trays.push(this);
    }
    setContextMenu(menu: unknown) {
      this.menu = menu;
    }
    setToolTip(text: string) {
      this.toolTip = text;
    }
  }
  return {
    appListeners,
    FakeNotification,
    module: {
      app: {
        getPath: vi.fn(() => "/tmp/vertex-desktop-test"),
        on: vi.fn((event: string, listener: Listener) => {
          appListeners.set(event, listener);
        }),
        quit: vi.fn(),
      },
      BrowserWindow: FakeBrowserWindow,
      dialog: { showErrorBox: vi.fn() },
      Menu: {
        buildFromTemplate: vi.fn((template: unknown) => ({ template })),
        setApplicationMenu: vi.fn(),
      },
      Notification: FakeNotification,
      nativeImage: { createFromPath: vi.fn((path: string) => ({ path })) },
      session: { fromPartition: vi.fn(() => session) },
      shell: { openExternal: vi.fn(async () => undefined) },
      Tray: FakeTray,
    },
    notifications,
    session,
    trays,
    windows,
  };
});

vi.mock("electron", () => electron.module);

import {
  createElectronPorts,
  createWindowFactory,
  GRANTED_PERMISSIONS,
  hardenSession,
  SITE_PARTITION,
  toElectronMenu,
} from "./electron-ports.ts";

const ORIGIN = "https://vertex.example";

beforeEach(() => {
  electron.windows.length = 0;
  electron.notifications.length = 0;
  electron.trays.length = 0;
  electron.FakeNotification.supported = true;
  vi.clearAllMocks();
});

describe("toElectronMenu", () => {
  it("maps every menu model kind", () => {
    const click = vi.fn();
    expect(
      toElectronMenu([
        { type: "separator" },
        { role: "copy", type: "role" },
        {
          items: [{ label: "Inner", type: "item" }],
          label: "Sub",
          type: "submenu",
        },
        {
          accelerator: "CmdOrCtrl+1",
          enabled: false,
          label: "Item",
          onClick: click,
          type: "item",
        },
      ])
    ).toEqual([
      { type: "separator" },
      { role: "copy" },
      { label: "Sub", submenu: [{ enabled: true, label: "Inner" }] },
      { accelerator: "CmdOrCtrl+1", click, enabled: false, label: "Item" },
    ]);
  });
});

describe("hardenSession", () => {
  it("grants only listed permissions, only to the site", () => {
    hardenSession(electron.session as never, ORIGIN);
    const request = electron.session.setPermissionRequestHandler.mock
      .calls[0]?.[0] as (...args: unknown[]) => void;
    const check = electron.session.setPermissionCheckHandler.mock
      .calls[0]?.[0] as (...args: unknown[]) => boolean;
    const callback = vi.fn();
    request(null, "clipboard-sanitized-write", callback, {
      requestingUrl: `${ORIGIN}/charts`,
    });
    request(null, "notifications", callback, { requestingUrl: `${ORIGIN}/` });
    request(null, "fullscreen", callback, {
      requestingUrl: "https://evil.example/",
    });
    expect(callback.mock.calls).toEqual([[true], [false], [false]]);
    expect(check(null, "fullscreen", ORIGIN)).toBe(true);
    expect(check(null, "media", ORIGIN)).toBe(false);
    expect(GRANTED_PERMISSIONS).not.toContain("notifications");
  });
});

describe("createWindowFactory", () => {
  const setup = (openInside: (url: string) => boolean = vi.fn(() => false)) => {
    const onNavigated = vi.fn();
    const factory = createWindowFactory({
      onNavigated,
      openInside,
      siteOrigin: ORIGIN,
    });
    const window = factory({
      bounds: undefined,
      title: "Vertex · Charts",
      workspaceId: "charts",
    });
    const native = electron.windows.at(-1);
    if (native === undefined) throw new Error("no window");
    return { native, onNavigated, openInside, window };
  };

  it("creates an isolated, sandboxed window on the site session", () => {
    const { native } = setup();
    expect(electron.module.session.fromPartition).toHaveBeenCalledWith(
      SITE_PARTITION
    );
    expect(native.options).toMatchObject({
      height: 900,
      title: "Vertex · Charts",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: SITE_PARTITION,
        sandbox: true,
        webSecurity: true,
      },
      width: 1440,
    });
    const iconPath = (
      electron.module.nativeImage.createFromPath.mock.calls[0] as [string]
    )[0];
    expect(existsSync(iconPath)).toBe(true);
  });

  it("uses saved bounds when given", () => {
    createWindowFactory({
      onNavigated: vi.fn(),
      openInside: vi.fn(),
      siteOrigin: ORIGIN,
    })({
      bounds: { height: 500, width: 600, x: 1, y: 2 },
      title: "t",
      workspaceId: "news",
    });
    expect(electron.windows.at(-1)?.options).toMatchObject({
      height: 500,
      width: 600,
      x: 1,
      y: 2,
    });
  });

  it("keeps same-site navigation, sends other http(s) links to the browser and blocks the rest", () => {
    const { native } = setup();
    const navigate = native.contentsListeners.get("will-navigate");
    const redirect = native.contentsListeners.get("will-redirect");
    const event = (url: string) => ({ preventDefault: vi.fn(), url });
    const inside = event(`${ORIGIN}/journal`);
    navigate?.(inside);
    expect(inside.preventDefault).not.toHaveBeenCalled();
    const outside = event("https://docs.example/");
    navigate?.(outside);
    expect(outside.preventDefault).toHaveBeenCalled();
    expect(electron.module.shell.openExternal).toHaveBeenCalledWith(
      "https://docs.example/"
    );
    const insideRedirect = event(`${ORIGIN}/sign-in`);
    redirect?.(insideRedirect);
    expect(insideRedirect.preventDefault).not.toHaveBeenCalled();
    const blocked = event("file:///etc/passwd");
    redirect?.(blocked);
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(electron.module.shell.openExternal).toHaveBeenCalledOnce();
  });

  it("denies new windows: workspace links go to their window, other site links load here", () => {
    const openInside = vi.fn((url: string) => url.includes("/charts"));
    const { native } = setup(openInside);
    const open = native.openHandler;
    expect(open?.({ url: `${ORIGIN}/charts?symbol=SPY` })).toEqual({
      action: "deny",
    });
    expect(native.webContents.loadURL).not.toHaveBeenCalled();
    native.webContents.loadURL.mockRejectedValueOnce(new Error("ERR_ABORTED"));
    expect(open?.({ url: `${ORIGIN}/settings` })).toEqual({ action: "deny" });
    expect(native.webContents.loadURL).toHaveBeenCalledWith(
      `${ORIGIN}/settings`
    );
    expect(open?.({ url: "https://docs.example/" })).toEqual({
      action: "deny",
    });
    expect(openInside).toHaveBeenCalledTimes(2);
  });

  it("reports same-site navigations and keeps its own title", () => {
    const { native, onNavigated } = setup();
    const didNavigate = native.contentsListeners.get("did-navigate");
    didNavigate?.({}, `${ORIGIN}/dashboard`);
    didNavigate?.({}, "https://docs.example/");
    expect(onNavigated).toHaveBeenCalledOnce();
    const titleEvent = { preventDefault: vi.fn() };
    native.listeners.get("page-title-updated")?.(titleEvent);
    expect(titleEvent.preventDefault).toHaveBeenCalled();
  });

  it("loads, focuses (restoring when minimised), reports bounds and close", async () => {
    const { native, window } = setup();
    native.webContents.loadURL.mockRejectedValueOnce(new Error("ERR_ABORTED"));
    window.load(`${ORIGIN}/charts`);
    await Promise.resolve();
    expect(native.webContents.loadURL).toHaveBeenCalledWith(`${ORIGIN}/charts`);
    window.focus();
    native.minimized = true;
    window.focus();
    expect(native.calls).toEqual(["show", "focus", "restore", "show", "focus"]);
    expect(window.bounds()).toEqual({ height: 1, width: 2, x: 3, y: 4 });
    const closed = vi.fn();
    window.onClose(closed);
    native.listeners.get("close")?.();
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe("createElectronPorts", () => {
  it("wires app lifecycle, menus, dialogs and timers", () => {
    vi.useFakeTimers();
    try {
      const ports = createElectronPorts();
      expect(ports.argv).toBe(process.argv);
      expect(ports.env).toBe(process.env);
      expect(ports.now()).toBeInstanceOf(Date);
      const task = vi.fn();
      const stop = ports.every(1000, task);
      vi.advanceTimersByTime(2500);
      stop();
      vi.advanceTimersByTime(5000);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    const ports = createElectronPorts();
    ports.fatal("boom");
    expect(electron.module.dialog.showErrorBox).toHaveBeenCalledWith(
      "Vertex",
      "boom"
    );
    ports.quit();
    expect(electron.module.app.quit).toHaveBeenCalledOnce();
    ports.keepRunningWithoutWindows();
    expect(electron.appListeners.get("window-all-closed")?.()).toBeUndefined();
    const beforeQuit = vi.fn();
    ports.onBeforeQuit(beforeQuit);
    electron.appListeners.get("before-quit")?.();
    expect(beforeQuit).toHaveBeenCalledOnce();
    const second = vi.fn();
    ports.onSecondInstance(second);
    electron.appListeners.get("second-instance")?.();
    expect(second).toHaveBeenCalledOnce();
    ports.setAppMenu([{ type: "separator" }]);
    expect(electron.module.Menu.setApplicationMenu).toHaveBeenCalledWith({
      template: [{ type: "separator" }],
    });
    expect(ports.windowFactory).toBe(createWindowFactory);
    expect(electron.module.app.getPath).toHaveBeenCalledWith("userData");
  });

  it("creates the tray with a menu and tooltip", () => {
    const tray = createElectronPorts().createTray();
    tray.setMenu([{ label: "Quit Vertex", type: "item" }]);
    tray.setToolTip("Vertex");
    const native = electron.trays[0];
    expect(native?.menu).toEqual({
      template: [{ enabled: true, label: "Quit Vertex" }],
    });
    expect(native?.toolTip).toBe("Vertex");
  });

  it("shows native notifications and keeps them until closed", () => {
    const ports = createElectronPorts();
    const onClick = vi.fn();
    ports.notify({ body: "b", onClick, title: "t" });
    ports.notify({ body: "b2", title: "t2" });
    const [first, second] = electron.notifications;
    expect(first?.options).toMatchObject({ body: "b", title: "t" });
    expect(first?.shown).toBe(true);
    first?.listeners.get("click")?.();
    expect(onClick).toHaveBeenCalledOnce();
    expect(second?.listeners.has("click")).toBe(false);
    first?.listeners.get("close")?.();
    electron.FakeNotification.supported = false;
    ports.notify({ body: "b3", title: "t3" });
    expect(electron.notifications).toHaveLength(2);
  });

  it("sends API calls through the site session with cookies", async () => {
    const api = createElectronPorts().api(ORIGIN);
    electron.session.fetch.mockResolvedValueOnce(
      Response.json({ json: { items: [] } })
    );
    await expect(api.watchlist()).resolves.toEqual([]);
    expect(electron.session.fetch).toHaveBeenCalledWith(expect.any(Request), {
      credentials: "include",
    });
  });
});
