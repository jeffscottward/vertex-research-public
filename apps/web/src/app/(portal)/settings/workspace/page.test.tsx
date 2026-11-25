import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceSettingsPage, { metadata } from "./page.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WorkspaceSettingsPage", () => {
  it("exposes title metadata and reflects server-side ui-experiments-panel state", () => {
    expect(metadata.title).toBe("Workspace settings");

    vi.stubEnv("VERTEX_UI_FLAGS", "");
    const offHtml = renderToStaticMarkup(<WorkspaceSettingsPage />);
    expect(offHtml).toContain('data-server-ui-preview="off"');

    vi.stubEnv("VERTEX_UI_FLAGS", "ui-experiments-panel=on");
    const onHtml = renderToStaticMarkup(<WorkspaceSettingsPage />);
    expect(onHtml).toContain('data-server-ui-preview="on"');
  });
});
