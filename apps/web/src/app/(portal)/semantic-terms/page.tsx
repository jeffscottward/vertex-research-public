import { PageHeader } from "@darkfactory/ui";

import { SemanticTermsWorkspace } from "../../../components/portal/semantic-terms-workspace.tsx";

export const metadata = { title: "Semantic terms" };

export default function SemanticTermsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Semantic terms" />
      <SemanticTermsWorkspace />
    </div>
  );
}
