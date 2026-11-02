import { Skeleton } from "@darkfactory/ui";

export default function BacktestsLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading backtests</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
