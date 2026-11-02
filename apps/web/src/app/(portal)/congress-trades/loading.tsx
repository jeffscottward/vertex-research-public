import { Skeleton } from "@darkfactory/ui";

export default function CongressTradesLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading congress trades</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-11 w-full sm:w-56" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
