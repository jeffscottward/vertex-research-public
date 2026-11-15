import { ResearchScreenWorkspace } from "../../../../components/portal/research-screen.tsx";

export const metadata = { title: "Research screen" };

// The status is loaded client side through researchScreen.status, which enforces operator access.
export default function ResearchScreenPage() {
  return <ResearchScreenWorkspace />;
}
