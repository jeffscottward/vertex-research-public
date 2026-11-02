import type { AgentModelRunOutput } from "@darkfactory/api";
import { Badge, StatusBadge } from "@darkfactory/ui";
import { ShieldAlert } from "lucide-react";

import { isAdjustedVersion } from "./agent-model-runs-client.ts";

const RESEARCH_ONLY_TEXT = "Research only. Agent ratings never place orders.";

export const ResearchOnlyNote = () => (
  <p
    className="flex items-center gap-2 text-muted-foreground text-sm"
    data-research-only="true"
  >
    <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
    {RESEARCH_ONLY_TEXT}
  </p>
);

// A rating is a research label. An unrated run says so; it is never shown as hold.
export const RatingBadge = ({
  rating,
  ratingSource,
}: Pick<AgentModelRunOutput, "rating" | "ratingSource">) =>
  rating === null ? (
    <Badge data-rating="unrated" variant="ghost">
      Unrated
    </Badge>
  ) : (
    <Badge
      data-rating={rating}
      title={
        ratingSource === "mapped"
          ? "Mapped from the model's wording"
          : undefined
      }
      variant="outline"
    >
      {rating}
      {ratingSource === "mapped" ? " (mapped)" : ""}
    </Badge>
  );

const STATUS_TONE = {
  cancelled: "neutral",
  failed: "destructive",
  queued: "neutral",
  running: "info",
  succeeded: "success",
} as const;

export const RunStatusBadge = ({
  status,
}: Pick<AgentModelRunOutput, "status">) => (
  <StatusBadge status={STATUS_TONE[status]}>{status}</StatusBadge>
);

export const FrameworkLabel = ({
  framework,
  frameworkVersion,
}: Pick<AgentModelRunOutput, "framework" | "frameworkVersion">) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    <span>{framework}</span>
    {frameworkVersion === null ? null : (
      <span className="font-mono text-muted-foreground text-xs">
        {frameworkVersion}
      </span>
    )}
    {isAdjustedVersion(frameworkVersion) ? (
      <Badge
        title="Built from a locally adjusted framework"
        variant="secondary"
      >
        adjusted
      </Badge>
    ) : null}
  </span>
);
