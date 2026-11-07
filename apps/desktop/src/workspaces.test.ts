import { describe, expect, it } from "vitest";

import {
  isWorkspaceId,
  siteUrlFor,
  WORKSPACES,
  windowTitle,
  workspaceById,
  workspaceForPath,
} from "./workspaces.ts";

describe("workspaces", () => {
  it("has unique ids and paths", () => {
    expect(new Set(WORKSPACES.map((w) => w.id)).size).toBe(WORKSPACES.length);
    expect(new Set(WORKSPACES.map((w) => w.path)).size).toBe(WORKSPACES.length);
  });

  it("recognises workspace ids", () => {
    expect(isWorkspaceId("charts")).toBe(true);
    expect(isWorkspaceId("orders")).toBe(false);
    expect(isWorkspaceId(3)).toBe(false);
  });

  it("looks up a workspace by id", () => {
    expect(workspaceById("journal").path).toBe("/journal");
  });

  it("maps a path to its workspace, including sub-paths", () => {
    expect(workspaceForPath("/charts")?.id).toBe("charts");
    expect(workspaceForPath("/charts/ES")?.id).toBe("charts");
    expect(workspaceForPath("/chartsx")).toBeNull();
    expect(workspaceForPath("/settings")).toBeNull();
  });

  it("builds site URLs and window titles", () => {
    expect(siteUrlFor("https://v.example", "/charts?symbol=SPY")).toBe(
      "https://v.example/charts?symbol=SPY"
    );
    expect(windowTitle(workspaceById("price-alerts"))).toBe("Vertex · Alerts");
  });
});
