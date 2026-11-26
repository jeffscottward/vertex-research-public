// What: the alert for a failed upstream provider read (QuantData and others). A rejected
// credential (HTTP 401/403) adds the owner-action line, because no job rotates a key.
// Used by: options-analytics-panel.tsx (section failures) and greek-heatmap-panel.tsx (metric failures).
import { classifyConnectivityMessage } from "@darkfactory/api";

export const ProviderFailureAlert = ({
  message,
}: {
  readonly message: string;
}) => {
  const authFailed =
    classifyConnectivityMessage(message).category === "auth_failed";
  return (
    <div
      className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs"
      data-auth-error={authFailed ? "" : undefined}
      role="alert"
    >
      <p className="font-medium text-destructive">{message}</p>
      {authFailed ? (
        <p className="mt-1 text-muted-foreground">
          Owner action required: rotate the upstream provider credential (never
          auto-rotated).
        </p>
      ) : null}
    </div>
  );
};
