import { ConnectivityHealthPanel } from "../../../components/portal/connectivity-health-panel.tsx";
import { ConnectionsWorkspace } from "../../../features/experience/utilities.tsx";

export const metadata = { title: "Connections" };
export default function ConnectionsPage() {
  return (
    <div className="space-y-8">
      <ConnectionsWorkspace />
      <ConnectivityHealthPanel />
    </div>
  );
}
