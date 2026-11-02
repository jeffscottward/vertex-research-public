import { Skeleton } from "@darkfactory/ui";

export default function AcademyLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading the Academy</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="aspect-video w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
