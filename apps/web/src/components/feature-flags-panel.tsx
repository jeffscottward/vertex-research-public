// What: Dev/viewer experimental UI feature-flag toggle panel and non-invasive smoke usage.
// Used by: apps/web/src/app/(portal)/settings/workspace/page.tsx, apps/web/src/lab/entries/data-settings.tsx.
// Guard: Renders nothing in production when all flags are at their off defaults.
"use client";

import { Badge, Button, cn, Panel } from "@darkfactory/ui";
import { FlaskConical, RotateCcw } from "lucide-react";

import {
  FEATURE_FLAG_REGISTRY,
  FEATURE_FLAGS_QUERY_PARAM,
  type FeatureFlagArea,
  type FeatureFlagSource,
} from "../lib/feature-flags.ts";
import {
  FeatureGate,
  useFeatureFlag,
  useFeatureFlags,
} from "./feature-flags-provider.tsx";

const AREA_LABELS: Readonly<Record<FeatureFlagArea, string>> = Object.freeze({
  research: "Research",
  ui: "UI",
});

const SOURCE_LABELS: Readonly<Record<FeatureFlagSource, string>> =
  Object.freeze({
    default: "Default",
    env: "Environment",
    localStorage: "Browser override",
    query: "Query param",
  });

const FeatureFlagRow = ({
  entry,
  onToggle,
}: {
  readonly entry: {
    readonly enabled: boolean;
    readonly name: keyof typeof FEATURE_FLAG_REGISTRY;
    readonly source: FeatureFlagSource;
  };
  readonly onToggle: (
    name: keyof typeof FEATURE_FLAG_REGISTRY,
    enabled: boolean
  ) => void;
}) => {
  const definition = FEATURE_FLAG_REGISTRY[entry.name];
  const lockedByQuery = entry.source === "query";
  const labelId = `feature-flag-label-${entry.name}`;
  return (
    <li
      className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
      data-feature-flag-row={entry.name}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground text-sm" id={labelId}>
            {definition.label}
          </span>
          <Badge variant="secondary">{AREA_LABELS[definition.area]}</Badge>
          <Badge
            data-feature-flag-source={entry.source}
            variant={entry.enabled ? "default" : "outline"}
          >
            {SOURCE_LABELS[entry.source]}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          {definition.description}
        </p>
        <p className="font-mono text-muted-foreground text-xs">
          {entry.name}
          {lockedByQuery
            ? ` · controlled by ?${FEATURE_FLAGS_QUERY_PARAM}= query param`
            : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        <span
          className={cn(
            "font-medium text-xs",
            entry.enabled ? "text-foreground" : "text-muted-foreground"
          )}
          data-feature-flag-state={entry.enabled ? "on" : "off"}
        >
          {entry.enabled ? "On" : "Off"}
        </span>
        <button
          aria-checked={entry.enabled}
          aria-labelledby={labelId}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
          data-feature-flag-toggle={entry.name}
          disabled={lockedByQuery}
          onClick={() => onToggle(entry.name, !entry.enabled)}
          role="switch"
          type="button"
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex h-6 w-11 shrink-0 items-center rounded-full border p-0.5 transition-colors",
              entry.enabled
                ? "border-primary bg-primary"
                : "border-border bg-muted"
            )}
          >
            <span
              className={cn(
                "block size-4 rounded-full bg-background shadow-xs transition-transform",
                entry.enabled ? "translate-x-5" : "translate-x-0"
              )}
            />
          </span>
        </button>
      </div>
    </li>
  );
};

export interface FeatureFlagsPanelProps {
  readonly className?: string;
  readonly serverPreviewActive?: boolean;
}

export const FeatureFlagsPanel = ({
  className,
  serverPreviewActive = false,
}: FeatureFlagsPanelProps = {}) => {
  const {
    allowClientOverrides,
    clearOverrides,
    localOverrides,
    resolved,
    setOverride,
  } = useFeatureFlags();

  const hasUiPreview = useFeatureFlag("ui-experiments-panel");
  const hasResearchPrototype = useFeatureFlag("research-prototype-slot");
  const hasAnyActiveSmoke = hasUiPreview || hasResearchPrototype;
  const localOverrideCount = Object.keys(localOverrides).length;

  if (!(allowClientOverrides || hasAnyActiveSmoke || serverPreviewActive)) {
    return null;
  }

  return (
    <div
      className={cn("space-y-4", className)}
      data-feature-flags-section=""
      {...(serverPreviewActive ? { "data-server-ui-preview": "on" } : {})}
    >
      <FeatureGate flag="ui-experiments-panel">
        <div
          className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground"
          data-feature-flag-smoke="ui-experiments-panel"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <FlaskConical
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-sm">
                  Experimental UI preview active
                </p>
                <Badge variant="outline">Experimental</Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                Isolated under{" "}
                <code className="font-mono text-foreground">
                  ui-experiments-panel
                </code>
                . Off by default in production; UI and research views only.
              </p>
            </div>
          </div>
        </div>
      </FeatureGate>

      <FeatureGate flag="research-prototype-slot">
        <div
          className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground"
          data-feature-flag-smoke="research-prototype-slot"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <FlaskConical
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-sm">
                  Research prototype callout active
                </p>
                <Badge variant="secondary">Research</Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                Isolated under{" "}
                <code className="font-mono text-foreground">
                  research-prototype-slot
                </code>
                . Staging slot for read-only research prototypes.
              </p>
            </div>
          </div>
        </div>
      </FeatureGate>

      {allowClientOverrides ? (
        <Panel
          actions={
            localOverrideCount > 0 ? (
              <Button
                data-feature-flags-reset=""
                onClick={clearOverrides}
                size="sm"
                variant="outline"
              >
                <RotateCcw aria-hidden="true" className="size-3.5" />
                Reset overrides
              </Button>
            ) : undefined
          }
          data-feature-flags-panel=""
          description={`UI and research views only. Flags default off and never gate execution, live orders, arming, or risk settings. Override in this browser or via ?${FEATURE_FLAGS_QUERY_PARAM}=<flag>.`}
          flush
          headingId="experimental-ui-flags-heading"
          title="Experimental UI flags"
        >
          <ul className="divide-y divide-border">
            {resolved.map((entry) => (
              <FeatureFlagRow
                entry={entry}
                key={entry.name}
                onToggle={setOverride}
              />
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
};
