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
 *
 * Card vertex-timeout-scale-stale-under-load (2026-11-20): a scale measured
 * once before the run missed two things. The run's own workers are not in the
 * load yet when the config loads (32 workers on 32 CPUs double the load), and
 * the load of other sessions changes during a 15-minute run. The config
 * therefore publishes a load floor (the load before the run plus the run's
 * workers), and a setup file measures again before each test file.
 */
export const TIMEOUT_SCALE_ENV = "VITEST_TIMEOUT_SCALE";

/**
 * The load floor of a measured run: the one-minute load before the run plus
 * the run's own maximum worker count. Unset when the scale is pinned.
 */
export const LOAD_FLOOR_ENV = "VITEST_TIMEOUT_LOAD_FLOOR";

/** Vitest's default deadlines, before scaling. */
const DEFAULT_TEST_TIMEOUT_MS = 5000;
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

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

/** Environment variables this module may set; process.env satisfies it. */
type MutableEnvironment = Record<string, string | undefined>;

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

/** A scale and, when it was measured, the CPU supply behind it. */
export interface ResolvedScale {
  readonly scale: number;
  /** Undefined when VITEST_TIMEOUT_SCALE pinned the scale. */
  readonly supply: CpuSupply | undefined;
}

/**
 * The scale for this process. A valid VITEST_TIMEOUT_SCALE wins, so nested
 * Vitest runs reuse their parent's value and a person can pin it; otherwise
 * the scale is measured.
 */
export const resolveTimeoutScale = (
  env: Environment,
  measure: () => CpuSupply = measureCpuSupply
): ResolvedScale => {
  const pinned = pinnedScale(env);
  if (pinned !== undefined) {
    return { scale: pinned, supply: undefined };
  }
  const supply = measure();
  return { scale: timeoutScale(supply), supply };
};

/** The default test and hook deadlines, in milliseconds. */
export interface DefaultTimeouts {
  readonly testTimeout: number;
  readonly hookTimeout: number;
}

/** The default test and hook deadlines for one scale. */
export const scaledDefaults = (scale: number): DefaultTimeouts => ({
  testTimeout: Math.round(DEFAULT_TEST_TIMEOUT_MS * scale),
  hookTimeout: Math.round(DEFAULT_HOOK_TIMEOUT_MS * scale),
});

/** The run as Vitest resolved it, after the command-line options. */
export interface ResolvedRun {
  /** Most test workers this run starts at the same time. */
  readonly maxWorkers: number;
  readonly testTimeout: number;
  readonly hookTimeout: number;
}

/**
 * Publishes the load floor for the per-file setup and the scale that counts
 * the run's own workers. A `configureVitest` plugin hook calls it, because
 * only then is the worker count of the run known. It returns a log line on
 * the first publication when the scale is above 1. A pinned scale or a
 * deadline set on the command line keeps the deadlines static: the floor is
 * removed and the setup file then changes nothing.
 */
export const publishLoadFloor = (
  env: MutableEnvironment,
  start: ResolvedScale,
  run: ResolvedRun
): string | undefined => {
  const configured = scaledDefaults(start.scale);
  if (
    start.supply === undefined ||
    run.testTimeout !== configured.testTimeout ||
    run.hookTimeout !== configured.hookTimeout
  ) {
    delete env[LOAD_FLOOR_ENV];
    return undefined;
  }
  const floor = String(start.supply.loadAverage + run.maxWorkers);
  if (env[LOAD_FLOOR_ENV] === floor) {
    return undefined;
  }
  env[LOAD_FLOOR_ENV] = floor;
  const scale = timeoutScale({ ...start.supply, loadAverage: Number(floor) });
  env[TIMEOUT_SCALE_ENV] = String(scale);
  const { hostCpus, loadAverage, quotaCpus } = start.supply;
  return scale > 1
    ? `[vitest] timeouts x${scale}: load ${loadAverage.toFixed(1)} + ${run.maxWorkers} workers on ${hostCpus} CPUs, CPU quota ${quotaCpus}; measured again before each test file`
    : undefined;
};

const LOAD_FLOOR_FORMAT = /^\d+(?:\.\d+)?$/u;

/**
 * The deadlines for one test file (scripts/lib/test-timeout-setup.ts calls
 * it before each file). The load is the larger of the current one-minute
 * load and the run's load floor: early in a run the one-minute average does
 * not show the run's own workers yet. It publishes the new scale for
 * scaledTimeout() and returns the deadlines for vi.setConfig. Without a
 * valid floor (pinned scale) it returns an empty object, which changes
 * nothing.
 */
export const fileTimeouts = (
  env: MutableEnvironment,
  measure: () => CpuSupply = measureCpuSupply
): Partial<DefaultTimeouts> => {
  const floor = env[LOAD_FLOOR_ENV];
  if (floor === undefined || !LOAD_FLOOR_FORMAT.test(floor)) {
    return {};
  }
  const supply = measure();
  const scale = timeoutScale({
    ...supply,
    loadAverage: Math.max(supply.loadAverage, Number(floor)),
  });
  env[TIMEOUT_SCALE_ENV] = String(scale);
  return scaledDefaults(scale);
};

/**
 * A per-test or per-suite budget, scaled like the default timeouts.
 * vitest.config.ts and its plugin hook publish the scale in
 * VITEST_TIMEOUT_SCALE before any worker starts, and the setup file updates it
 * before each test file; without it the budget stays unchanged.
 */
export const scaledTimeout = (
  milliseconds: number,
  env: Environment = process.env
): number => Math.round(milliseconds * (pinnedScale(env) ?? 1));
