import { PageHeader } from "@darkfactory/ui";

import { TodosWorkspace } from "../../../components/portal/todos-workspace.tsx";

export const metadata = { title: "Todos" };

export default function TodosPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Todos" />
      <TodosWorkspace />
    </div>
  );
}
