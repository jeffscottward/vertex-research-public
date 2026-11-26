import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceSettingsPage, { metadata } from "./page.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WorkspaceSettingsPage", () => {
  it("keeps zero extra DOM footprint when flags are off and reflects server-side ui-experiments-panel when on", () => {
    expect(metadata.title).toBe("Workspace settings");

    vi.stubEnv("VERTEX_UI_FLAGS", "");
    const offHtml = renderToStaticMarkup(<WorkspaceSettingsPage />);
    expect(offHtml).not.toContain("data-server-ui-preview");
    expect(offHtml).not.toContain("data-feature-flags-section");

    vi.stubEnv("VERTEX_UI_FLAGS", "ui-experiments-panel=on");
    const onHtml = renderToStaticMarkup(<WorkspaceSettingsPage />);
    expect(onHtml).toContain('data-server-ui-preview="on"');
  });
});
