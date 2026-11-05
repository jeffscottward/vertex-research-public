import { Skeleton } from "@darkfactory/ui";

export default function PickListsLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading pick lists</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
