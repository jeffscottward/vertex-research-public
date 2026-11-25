// What: Vertex workspace settings tab: account links, session privacy notes and workspace utility destinations.
// Used by: /settings/workspace (SETTINGS_NAVIGATION "Workspace" tab).
// See: apps/web/src/features/experience/utilities.tsx#SettingsWorkspaceSections; apps/web/src/app/(portal)/settings/layout.tsx.
import { FeatureFlagsPanel } from "../../../../components/feature-flags-panel.tsx";
import { SettingsWorkspaceSections } from "../../../../features/experience/utilities.tsx";
import { isServerFeatureFlagEnabled } from "../../../../lib/server-feature-flags.ts";

export const metadata = { title: "Workspace settings" };

export default function WorkspaceSettingsPage() {
  const serverPreviewActive = isServerFeatureFlagEnabled(
    "ui-experiments-panel"
  );
  return (
    <>
      <SettingsWorkspaceSections />
      <FeatureFlagsPanel
        className="mt-6"
        serverPreviewActive={serverPreviewActive}
      />
    </>
  );
}
