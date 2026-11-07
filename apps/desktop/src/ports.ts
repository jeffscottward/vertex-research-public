// What: the ports between the shell's logic and Electron. electron-ports.ts is the only adapter;
// tests use plain fakes. Menus are plain data so their content is testable without Electron.
import type { WindowBounds } from "./settings.ts";
import type { WorkspaceId } from "./workspaces.ts";

/** Electron menu roles the shell uses (edit shortcuts, reload, zoom, devtools, window). */
export type MenuRole =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "reload"
  | "forceReload"
  | "toggleDevTools"
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
  | "togglefullscreen"
  | "minimize"
  | "close";

export type MenuItemModel =
  | Readonly<{ type: "separator" }>
  | Readonly<{ type: "role"; role: MenuRole }>
  | Readonly<{
      type: "item";
      label: string;
      enabled?: boolean;
      accelerator?: string;
      onClick?: () => void;
    }>
  | Readonly<{
      type: "submenu";
      label: string;
      items: readonly MenuItemModel[];
    }>;

export interface WorkspaceWindow {
  /** Size and position when neither minimised nor maximised. */
  readonly bounds: () => WindowBounds;
  /** Show, restore when minimised, and focus. */
  readonly focus: () => void;
  readonly load: (url: string) => void;
  /** Called each time the window starts closing; a page may still cancel the close. */
  readonly onClose: (listener: () => void) => void;
  /** Called once, after the window is gone. */
  readonly onClosed: (listener: () => void) => void;
}

export type WindowRequest = Readonly<{
  workspaceId: WorkspaceId;
  title: string;
  bounds: WindowBounds | undefined;
}>;

export type WindowFactory = (request: WindowRequest) => WorkspaceWindow;

export interface TrayPort {
  readonly setMenu: (items: readonly MenuItemModel[]) => void;
  readonly setToolTip: (text: string) => void;
}

export type DesktopNotification = Readonly<{
  title: string;
  body: string;
  onClick?: () => void;
}>;

export type NotifyPort = (notification: DesktopNotification) => void;

/** Runs `task` every `ms`; returns the function that stops it. */
export type EveryPort = (ms: number, task: () => void) => () => void;
