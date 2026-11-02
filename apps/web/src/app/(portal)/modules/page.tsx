import { ResearchHeading } from "../../../components/research/research-views.tsx";
import { ModulesWorkspace } from "../../../components/research/research-workspace.tsx";
import { ResearchScopedWorkspace } from "../../../components/research/read-scope.tsx";

export const metadata = { title: "Modules" };

export default function ModulesPage() {
  return (
    <>
      <ResearchHeading title="Modules" />
      <ResearchScopedWorkspace>
        <ModulesWorkspace />
      </ResearchScopedWorkspace>
    </>
  );
}
