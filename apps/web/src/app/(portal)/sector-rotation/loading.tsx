import { Skeleton } from "@darkfactory/ui";

export default function SectorRotationLoading() {
  return (
    <div aria-busy="true" className="space-y-6" role="status">
      <span className="sr-only">Loading sector rotation</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="aspect-square w-full max-w-2xl" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
