import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { posix } from "node:path";

/**
 * Vitest timeouts are wall-clock deadlines. On a contended host (the rig runs
 * 16 CI runners next to the pre-push lanes; load average 60-140 on 32 CPUs)
 * or in a CPU-limited cgroup, the same test needs more wall time for the same
 * CPU work, so a fixed 5 s deadline fails tests that pass alone. The scale
 * multiplies the default test and hook timeouts by the measured CPU
 * shortage. Assertions and per-test timeouts stay unchanged.
 */
export const TIMEOUT_SCALE_ENV = "VITEST_TIMEOUT_SCALE";

/** A hung test still fails: at most 8 times the default deadline. */
export const MAX_TIMEOUT_SCALE = 8;

export interface CpuSupply {
  /** Logical CPUs of the host. */
  readonly hostCpus: number;
  /** One-minute host load average (runnable and waiting tasks). */
  readonly loadAverage: number;
  /** CPU bandwidth limit of this process's cgroup chain; Infinity = none. */
  readonly quotaCpus: number;
}

/**
 * Host load above the CPU count and a cgroup quota below one CPU each slow a
 * single test thread down proportionally; both multiply. The result is
 * rounded up to one decimal and capped at MAX_TIMEOUT_SCALE.
 */
export const timeoutScale = (supply: CpuSupply): number => {
  const hostSlowdown = Math.max(1, supply.loadAverage / supply.hostCpus);
  const quotaSlowdown = Math.max(1, 1 / supply.quotaCpus);
  const scale = Math.ceil(hostSlowdown * quotaSlowdown * 10) / 10;
  return Math.min(MAX_TIMEOUT_SCALE, scale);
};

type ReadText = (path: string) => string;

/** Environment variables; process.env satisfies it. */
type Environment = Readonly<Record<string, string | undefined>>;

const FIELD_SEPARATOR = /\s+/u;

const readText: ReadText = (path) => readFileSync(path, "utf8");

/**
 * Smallest cgroup v2 `cpu.max` limit from this process's cgroup up to the
 * root, in CPUs. Returns Infinity when no level sets a limit or when the
 * host has no cgroup v2 hierarchy (for example macOS).
 */
export const readCgroupQuotaCpus = (read: ReadText = readText): number => {
  let membership: string;
  try {
    membership = read("/proc/self/cgroup");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  const line = membership.split("\n").find((entry) => entry.startsWith("0::"));
  if (line === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  let quota = Number.POSITIVE_INFINITY;
  let path = line.slice(3).trim();
  for (;;) {
    const limitFile = `/sys/fs/cgroup${path === "/" ? "" : path}/cpu.max`;
    try {
      const [max, period] = read(limitFile).trim().split(FIELD_SEPARATOR);
      const cpusAllowed = Number(max) / Number(period);
      // "max" (no limit) parses as NaN and is skipped.
      if (cpusAllowed > 0) {
        quota = Math.min(quota, cpusAllowed);
      }
    } catch {
      // This level has no cpu controller file.
    }
    if (path === "/" || path === "") {
      return quota;
    }
    path = posix.dirname(path);
  }
};

export const measureCpuSupply = (read: ReadText = readText): CpuSupply => ({
  hostCpus: cpus().length,
  // os.loadavg() always returns three numbers ([0, 0, 0] on Windows).
  loadAverage: Number(loadavg()[0]),
  quotaCpus: readCgroupQuotaCpus(read),
});

/** A valid pinned VITEST_TIMEOUT_SCALE (a number >= 1, capped), else undefined. */
const pinnedScale = (env: Environment): number | undefined => {
  const pinned = Number(env[TIMEOUT_SCALE_ENV]);
  return Number.isFinite(pinned) && pinned >= 1
    ? Math.min(MAX_TIMEOUT_SCALE, pinned)
    : undefined;
};

/**
 * The scale for this process. A valid VITEST_TIMEOUT_SCALE wins, so nested
 * Vitest runs reuse their parent's value and a person can pin it; otherwise
 * the scale is measured.
 */
export const resolveTimeoutScale = (
  env: Environment,
  measure: () => CpuSupply = measureCpuSupply
): { readonly scale: number; readonly supply: CpuSupply | undefined } => {
  const pinned = pinnedScale(env);
  if (pinned !== undefined) {
    return { scale: pinned, supply: undefined };
  }
  const supply = measure();
  return { scale: timeoutScale(supply), supply };
};

/**
 * A per-test or per-suite budget, scaled like the default timeouts.
 * vitest.config.ts publishes the scale in VITEST_TIMEOUT_SCALE before any
 * test file loads; without it the budget stays unchanged.
 */
export const scaledTimeout = (
  milliseconds: number,
  env: Environment = process.env
): number => Math.round(milliseconds * (pinnedScale(env) ?? 1));
