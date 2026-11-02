// What: Vertex workspace settings tab: account links, session privacy notes and workspace utility destinations.
// Used by: /settings/workspace (SETTINGS_NAVIGATION "Workspace" tab).
// See: apps/web/src/features/experience/utilities.tsx#SettingsWorkspaceSections; apps/web/src/app/(portal)/settings/layout.tsx.
import { SettingsWorkspaceSections } from "../../../../features/experience/utilities.tsx";

export const metadata = { title: "Workspace settings" };

export default function WorkspaceSettingsPage() {
  return <SettingsWorkspaceSections />;
}
