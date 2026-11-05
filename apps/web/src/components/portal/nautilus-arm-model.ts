import {
  NAUTILUS_ARM_REASON_MAX,
  NAUTILUS_ARM_REASON_MIN,
  type NautilusArmStatusOutput,
  type NautilusNodeBadge,
} from "@darkfactory/api";

import type { HealthTone } from "./portfolio-monitor-model.ts";

// View model for the Nautilus node badge and the Arm / Disarm buttons (Mission control, operator view).
// Owner decision 2026-10-30: the node runs 24/7 and is disarmed by default.

export const NAUTILUS_POLL_MS = 15_000;

const BADGE: Readonly<
  Record<NautilusNodeBadge, Readonly<{ label: string; tone: HealthTone }>>
> = {
  down: { label: "Down", tone: "destructive" },
  "running-armed": { label: "Running · Armed", tone: "warning" },
  "running-disarmed": { label: "Running · Disarmed", tone: "success" },
  unknown: { label: "Unknown", tone: "neutral" },
};

// Shown when the status call itself fails (bridge or server unreachable).
export const UNREACHABLE_BADGE = Object.freeze({
  label: "Unreachable",
  tone: "neutral" as HealthTone,
});

const DETAIL_HINT: Readonly<Record<string, string>> = {
  image_version_changed:
    "The arm record was for another image version; the node treats it as disarmed.",
  invalid_arm_record:
    "The arm record is invalid; the node treats it as disarmed.",
  kill_switch_active: "The kill switch is active; the node cannot be armed.",
};

export type NautilusArmView = Readonly<{
  badge: Readonly<{ key: NautilusNodeBadge; label: string; tone: HealthTone }>;
  // null: no Arm button. `enabled: false` with a hint explains why.
  arm: Readonly<{ enabled: boolean; hint: string | null }> | null;
  // Disarm shows unless the node confirms it is disarmed: armed, down or unknown.
  disarm: boolean;
  // "Armed by owner at 14:59 UTC: reason" and similar, or null.
  detail: string | null;
}>;

export const nautilusArmView = (
  status: NautilusArmStatusOutput
): NautilusArmView => {
  const badge = { key: status.badge, ...BADGE[status.badge] };
  const arm = status.arm;
  if (arm === null || status.badge === "down" || status.badge === "unknown")
    return { arm: null, badge, detail: null, disarm: true };
  if (arm.armed)
    return {
      arm: null,
      badge,
      detail: `Armed by ${arm.armedBy ?? "unknown"} at ${arm.armedAt ?? "unknown time"}${arm.reason === null ? "" : `: ${arm.reason}`}`,
      disarm: true,
    };
  const hint = DETAIL_HINT[arm.detail] ?? null;
  return {
    arm: { enabled: !arm.killSwitchActive, hint },
    badge,
    detail: null,
    disarm: false,
  };
};

// The same rules the server checks: one line, 10..280 characters, no edge spaces, not starting with "-".
export const reasonProblem = (reason: string): string | null => {
  if (reason.length < NAUTILUS_ARM_REASON_MIN)
    return `Write at least ${NAUTILUS_ARM_REASON_MIN} characters.`;
  if (reason.length > NAUTILUS_ARM_REASON_MAX)
    return `Use at most ${NAUTILUS_ARM_REASON_MAX} characters.`;
  if (reason !== reason.trim())
    return "Remove the spaces at the start and end.";
  if (/[\u0000-\u001f\u007f]/u.test(reason)) return "Use one line only.";
  if (reason.startsWith("-")) return "Do not start with -.";
  return null;
};
