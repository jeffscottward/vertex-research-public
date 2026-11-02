import { PageHeader } from "@darkfactory/ui";
import { GraduationCap } from "lucide-react";
import Link from "next/link";

import { StrategyLibraryWorkspace } from "../../../components/portal/strategy-library-workspace.tsx";

export const metadata = { title: "Strategy library" };

export default function StrategyLibraryPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Link
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted"
            data-academy-link
            href="/academy"
            prefetch={false}
          >
            <GraduationCap aria-hidden className="size-4" /> Academy lessons
          </Link>
        }
        title="Strategy library"
      />
      <StrategyLibraryWorkspace />
    </div>
  );
}
