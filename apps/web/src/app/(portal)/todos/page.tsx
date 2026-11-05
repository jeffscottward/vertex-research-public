import { PageHeader } from "@darkfactory/ui";

import { TodosWorkspace } from "../../../components/portal/todos-workspace.tsx";

export const metadata = { title: "Todos" };

export default function TodosPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        description="Your open research and trading to-dos, with due dates and tags."
        title="Todos"
      />
      <TodosWorkspace />
    </div>
  );
}
