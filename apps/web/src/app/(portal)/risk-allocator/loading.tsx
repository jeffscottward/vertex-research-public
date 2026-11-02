import { Skeleton } from "@darkfactory/ui";

export default function RiskAllocatorLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading risk allocator</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
