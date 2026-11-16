import {
  NAUTILUS_ARM_REASON_MAX,
  NAUTILUS_ARM_REASON_MIN,
  type NautilusArmStatusOutput,
  type NautilusNodeBadge,
} from "@darkfactory/api";

import { type HealthTone, sinceClock } from "./portfolio-monitor-model.ts";

// View model for the Nautilus node badge and the Arm / Disarm buttons (Mission control, operator view).
// Owner decision 2026-10-30: the node runs 24/7 and is disarmed by default.

export const NAUTILUS_POLL_MS = 15_000;

const BADGE: Readonly<
  Record<NautilusNodeBadge, Readonly<{ label: string; tone: HealthTone }>>
> = {
  down: { label: "Down", tone: "destructive" },
  "running-armed": { label: "Running · Armed", tone: "warning" },
  "running-disarmed": { label: "Running · Disarmed", tone: "success" },
  // Replaced by a definite label from armError and the container state (unknownView).
  unknown: { label: "Node state not read", tone: "neutral" },
};

// The last badge other than "unknown" this page saw, with the status check time.
export type NautilusConfirmed = Readonly<{
  badge: Exclude<NautilusNodeBadge, "unknown">;
  checkedAt: string;
}>;

const CLI_CAUSE: Readonly<Record<string, string>> = {
  "cli-bad-output": "answered in a form the VPS service could not read",
  "cli-error": "failed (error)",
  "cli-timeout": "did not answer (timeout)",
};

const clock = (value: string | null | undefined, nowMs: number): string =>
  sinceClock(value, nowMs) ?? "time not recorded";

// Badge "unknown" (wire value): the arm CLI did not answer while the container runs, or Docker was not
// readable. Arm stays hidden and Disarm available, as before.
const unknownView = (
  status: NautilusArmStatusOutput,
  confirmed: NautilusConfirmed | null
): Readonly<{ label: string; detail: string }> => {
  const nowMs = Date.parse(status.checkedAt);
  const checked = clock(status.checkedAt, nowMs);
  const code = status.armError;
  const parts: string[] = [];
  let label: string;
  if (status.container.state === "running") {
    label = "Running · arm state not read";
    const cause =
      code === null
        ? "sent no arm state and no error code"
        : (CLI_CAUSE[code] ?? `failed (code ${code})`);
    parts.push(`The arm command in the node ${cause} at ${checked}`);
  } else {
    label = "Node state not read";
    const since = clock(status.container.since ?? status.checkedAt, nowMs);
    parts.push(
      code === "ambiguous-container"
        ? `More than one node container matches since ${since}`
        : code === "docker-error"
          ? `Docker did not answer since ${since} (docker error)`
          : `Docker could not be read since ${since} (code ${code ?? "not sent"})`
    );
    const last = status.container.lastKnown;
    parts.push(
      last === null || last === undefined
        ? "no container read recorded since the VPS service started"
        : `last read: ${last.state} at ${clock(last.at, nowMs)}`
    );
  }
  if (confirmed !== null)
    parts.push(
      `last confirmed on this page: ${BADGE[confirmed.badge].label} at ${clock(confirmed.checkedAt, nowMs)}`
    );
  parts.push(
    `Arm hidden, Disarm available · next check in ${NAUTILUS_POLL_MS / 1000} s`
  );
  return { detail: parts.join(" · "), label };
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
  status: NautilusArmStatusOutput,
  confirmed: NautilusConfirmed | null = null
): NautilusArmView => {
  const badge = { key: status.badge, ...BADGE[status.badge] };
  if (status.badge === "unknown") {
    const unknown = unknownView(status, confirmed);
    return {
      arm: null,
      badge: { ...badge, label: unknown.label },
      detail: unknown.detail,
      disarm: true,
    };
  }
  const arm = status.arm;
  if (arm === null || status.badge === "down")
    return { arm: null, badge, detail: null, disarm: true };
  if (arm.armed)
    return {
      arm: null,
      badge,
      detail: `Armed by ${arm.armedBy ?? "arming user not recorded by the node"} at ${arm.armedAt ?? "arm time not recorded by the node"}${arm.reason === null ? "" : `: ${arm.reason}`}`,
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
