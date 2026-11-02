// Pure paper deployment request view helpers: views, labels, limits form parsing, allowed actions and links.
import type {
  DeploymentLimitsOutput,
  DeploymentRequestOutput,
  DeploymentRequestStatusValue,
} from "@darkfactory/api";

export const DEPLOYMENT_VIEWS = ["monitor", "requests"] as const;
export type DeploymentView = (typeof DEPLOYMENT_VIEWS)[number];
export const DEPLOYMENT_VIEW_LABELS: Readonly<Record<DeploymentView, string>> =
  Object.freeze({
    monitor: "Monitor",
    requests: "Requests",
  });
export const isDeploymentView = (value: unknown): value is DeploymentView => {
  return (
    typeof value === "string" &&
    (DEPLOYMENT_VIEWS as readonly string[]).includes(value)
  );
};

export const NOT_DISPATCHED_LABEL = "Not dispatched — submission disabled";

export const REQUEST_STATUS_LABELS: Readonly<
  Record<DeploymentRequestStatusValue, string>
> = Object.freeze({
  draft: "Draft",
  requested: "Requested",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
});

export type RequestTone = "success" | "warning" | "danger" | "info" | "neutral";
export const REQUEST_STATUS_TONE: Readonly<
  Record<DeploymentRequestStatusValue, RequestTone>
> = Object.freeze({
  draft: "neutral",
  requested: "info",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral",
});

export const TONE_CLASS: Readonly<Record<RequestTone, string>> = Object.freeze({
  success: "border-success-border bg-success-subtle text-success-foreground",
  warning: "border-warning-border bg-warning-subtle text-warning-foreground",
  danger: "border-destructive-border bg-destructive-subtle text-destructive",
  info: "border-primary bg-muted text-foreground",
  neutral: "border-border bg-muted text-muted-foreground",
});

export const TIMEFRAME_OPTIONS = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
] as const;

export type LimitKey = keyof DeploymentLimitsOutput;
export const LIMIT_FIELDS: readonly Readonly<{
  key: LimitKey;
  label: string;
  integer: boolean;
}>[] = Object.freeze([
  { key: "maxOrderSize", label: "Max order size", integer: false },
  { key: "maxPosition", label: "Max position", integer: false },
  { key: "maxOrdersPerMinute", label: "Max orders / minute", integer: true },
  { key: "dailyLossLimit", label: "Daily loss limit", integer: false },
]);

export type LimitsForm = Record<LimitKey, string>;
export const EMPTY_LIMITS_FORM: LimitsForm = Object.freeze({
  maxOrderSize: "",
  maxPosition: "",
  maxOrdersPerMinute: "",
  dailyLossLimit: "",
});

export const limitsToForm = (limits: DeploymentLimitsOutput): LimitsForm => ({
  maxOrderSize: String(limits.maxOrderSize),
  maxPosition: String(limits.maxPosition),
  maxOrdersPerMinute: String(limits.maxOrdersPerMinute),
  dailyLossLimit: String(limits.dailyLossLimit),
});

// All four are required and > 0; orders per minute is whole; order size may not exceed position.
export const limitsFromForm = (
  form: LimitsForm
): DeploymentLimitsOutput | string => {
  const result: Partial<Record<LimitKey, number>> = {};
  for (const field of LIMIT_FIELDS) {
    const text = form[field.key].trim();
    if (text === "") return `${field.label} is required.`;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0)
      return `${field.label} must be greater than 0.`;
    if (field.integer && !Number.isInteger(value))
      return `${field.label} must be a whole number.`;
    result[field.key] = value;
  }
  const limits = result as DeploymentLimitsOutput;
  if (limits.maxOrderSize > limits.maxPosition)
    return "Max order size must not exceed max position.";
  return limits;
};

export type RequestActions = Readonly<{
  edit: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  withdraw: boolean;
}>;

export const requestActions = (
  status: DeploymentRequestStatusValue
): RequestActions => ({
  edit: status === "draft",
  submit: status === "draft",
  approve: status === "requested",
  reject: status === "requested",
  withdraw:
    status === "draft" || status === "requested" || status === "approved",
});

// Approval needs the exact strategy slug typed by the operator (the server re-checks it).
export const slugConfirmed = (
  request: Pick<DeploymentRequestOutput, "strategySlug">,
  typed: string
): boolean => {
  return typed.trim() === request.strategySlug;
};

export const formatParams = (
  params: Readonly<Record<string, number | boolean | string>>
): string => {
  const entries = Object.entries(params);
  return entries.length === 0
    ? "—"
    : entries.map(([name, value]) => `${name}=${String(value)}`).join(" · ");
};

// Deep link into the Requests view: a new request for a strategy, or one request's detail.
export const newRequestHref = (strategyId: string): string => {
  return `/deployments?view=requests&new=${encodeURIComponent(strategyId)}`;
};
