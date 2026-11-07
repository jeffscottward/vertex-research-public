import { describe, expect, it, vi } from "vitest";

import { appMenu } from "./app-menu.ts";
import { labels, menuItem } from "./test-fakes.ts";
import { WORKSPACES } from "./workspaces.ts";

describe("appMenu", () => {
  it("has the standard menus with edit and view roles", () => {
    const menu = appMenu({ openWorkspace: vi.fn(), quit: vi.fn() });
    expect(labels(menu)).toEqual([
      "Vertex",
      "Edit",
      "View",
      "Workspaces",
      "Window",
    ]);
    const edit = menu[1];
    expect(edit?.type === "submenu" && labels(edit.items)).toContain(
      "role:paste"
    );
  });

  it("opens each workspace with Ctrl/Cmd and its digit", () => {
    // Accelerators are single digits, so there can be at most nine workspaces.
    expect(WORKSPACES.length).toBeLessThanOrEqual(9);
    const openWorkspace = vi.fn();
    const menu = appMenu({ openWorkspace, quit: vi.fn() });
    const charts = menuItem(menu, "Charts");
    expect(charts?.accelerator).toBe("CmdOrCtrl+2");
    charts?.onClick?.();
    expect(openWorkspace).toHaveBeenCalledWith("charts");
    const workspaces = menu[3];
    const items = workspaces?.type === "submenu" ? workspaces.items : [];
    expect(items).toHaveLength(WORKSPACES.length);
    const accelerators = items.map((item) =>
      item.type === "item" ? item.accelerator : undefined
    );
    expect(accelerators).toEqual(
      WORKSPACES.map((_, index) => `CmdOrCtrl+${index + 1}`)
    );
  });

  it("quits from the Vertex menu", () => {
    const quit = vi.fn();
    menuItem(
      appMenu({ openWorkspace: vi.fn(), quit }),
      "Quit Vertex"
    )?.onClick?.();
    expect(quit).toHaveBeenCalledOnce();
  });
});
