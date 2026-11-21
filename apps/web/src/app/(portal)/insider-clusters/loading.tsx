import { Skeleton } from "@darkfactory/ui";

export default function InsiderClustersLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading insider cluster buys</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-11 w-full sm:w-56" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
