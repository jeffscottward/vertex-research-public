// What: the application menu: edit and view roles (so copy, paste, reload and zoom shortcuts work),
// a Workspaces menu that opens each workspace in its own window (Ctrl/Cmd+1..9) and a Window menu.
// Used by: app.ts.
import type { MenuItemModel } from "./ports.ts";
import { WORKSPACES, type WorkspaceId } from "./workspaces.ts";

export const appMenu = (
  actions: Readonly<{
    openWorkspace: (id: WorkspaceId) => void;
    quit: () => void;
  }>
): MenuItemModel[] => [
  {
    items: [
      {
        accelerator: "CmdOrCtrl+Q",
        label: "Quit Vertex",
        onClick: actions.quit,
        type: "item",
      },
    ],
    label: "Vertex",
    type: "submenu",
  },
  {
    items: [
      { role: "undo", type: "role" },
      { role: "redo", type: "role" },
      { type: "separator" },
      { role: "cut", type: "role" },
      { role: "copy", type: "role" },
      { role: "paste", type: "role" },
      { role: "selectAll", type: "role" },
    ],
    label: "Edit",
    type: "submenu",
  },
  {
    items: [
      { role: "reload", type: "role" },
      { role: "forceReload", type: "role" },
      { role: "toggleDevTools", type: "role" },
      { type: "separator" },
      { role: "resetZoom", type: "role" },
      { role: "zoomIn", type: "role" },
      { role: "zoomOut", type: "role" },
      { type: "separator" },
      { role: "togglefullscreen", type: "role" },
    ],
    label: "View",
    type: "submenu",
  },
  {
    items: WORKSPACES.map((workspace, index) => ({
      // app-menu.test.ts keeps WORKSPACES at nine or fewer, so every one gets a digit.
      accelerator: `CmdOrCtrl+${index + 1}`,
      label: workspace.label,
      onClick: () => actions.openWorkspace(workspace.id),
      type: "item",
    })),
    label: "Workspaces",
    type: "submenu",
  },
  {
    items: [
      { role: "minimize", type: "role" },
      { role: "close", type: "role" },
    ],
    label: "Window",
    type: "submenu",
  },
];
