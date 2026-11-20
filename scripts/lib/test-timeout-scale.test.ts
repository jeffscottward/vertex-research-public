import { describe, expect, it, vi } from "vitest";

import {
  fileTimeouts,
  LOAD_FLOOR_ENV,
  MAX_TIMEOUT_SCALE,
  measureCpuSupply,
  publishLoadFloor,
  readCgroupQuotaCpus,
  resolveTimeoutScale,
  scaledDefaults,
  scaledTimeout,
  TIMEOUT_SCALE_ENV,
  timeoutScale,
} from "./test-timeout-scale.ts";

const files =
  (contents: Record<string, string>) =>
  (path: string): string => {
    const text = contents[path];
    if (text === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return text;
  };

const SCOPE = "/user.slice/user-1000.slice/app.slice/run-1.scope";

describe("timeoutScale", () => {
  it("keeps the default deadlines on an idle host without a quota", () => {
    expect(
      timeoutScale({
        hostCpus: 32,
        loadAverage: 12,
        quotaCpus: Number.POSITIVE_INFINITY,
      })
    ).toBe(1);
  });

  it("scales by host load above the CPU count, rounded up to 0.1", () => {
    expect(
      timeoutScale({
        hostCpus: 32,
        loadAverage: 100,
        quotaCpus: Number.POSITIVE_INFINITY,
      })
    ).toBe(3.2);
  });

  it("scales by a quota below one CPU and multiplies with host load", () => {
    expect(timeoutScale({ hostCpus: 32, loadAverage: 0, quotaCpus: 0.5 })).toBe(
      2
    );
    expect(
      timeoutScale({ hostCpus: 32, loadAverage: 48, quotaCpus: 0.5 })
    ).toBe(3);
    expect(timeoutScale({ hostCpus: 32, loadAverage: 0, quotaCpus: 12 })).toBe(
      1
    );
  });

  it("never exceeds the cap, so a hung test still fails", () => {
    expect(
      timeoutScale({ hostCpus: 32, loadAverage: 140, quotaCpus: 0.25 })
    ).toBe(MAX_TIMEOUT_SCALE);
  });
});

describe("readCgroupQuotaCpus", () => {
  it("returns the smallest cpu.max limit on the path to the root", () => {
    const read = files({
      "/proc/self/cgroup": `0::${SCOPE}\n`,
      [`/sys/fs/cgroup${SCOPE}/cpu.max`]: "25000 100000\n",
      "/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/cpu.max":
        "max 100000\n",
      "/sys/fs/cgroup/user.slice/cpu.max": "1200000 100000\n",
    });
    expect(readCgroupQuotaCpus(read)).toBe(0.25);
  });

  it("reports no limit when every level is unlimited or unreadable", () => {
    const read = files({
      "/proc/self/cgroup": "0::/user.slice\n",
      "/sys/fs/cgroup/user.slice/cpu.max": "max 100000\n",
    });
    expect(readCgroupQuotaCpus(read)).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads the root level for a process in the root cgroup", () => {
    const read = files({
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/cpu.max": "50000 100000",
    });
    expect(readCgroupQuotaCpus(read)).toBe(0.5);
  });

  it("reports no limit without a cgroup v2 entry or without /proc", () => {
    expect(
      readCgroupQuotaCpus(files({ "/proc/self/cgroup": "1:cpu:/x\n" }))
    ).toBe(Number.POSITIVE_INFINITY);
    expect(readCgroupQuotaCpus(files({}))).toBe(Number.POSITIVE_INFINITY);
    expect(readCgroupQuotaCpus(files({ "/proc/self/cgroup": "0::\n" }))).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("reads the real host without throwing", () => {
    expect(readCgroupQuotaCpus()).toBeGreaterThan(0);
  });
});

describe("resolveTimeoutScale", () => {
  const busy = () => ({
    hostCpus: 32,
    loadAverage: 64,
    quotaCpus: Number.POSITIVE_INFINITY,
  });

  it("measures the host when no scale is pinned", () => {
    expect(resolveTimeoutScale({}, busy)).toEqual({
      scale: 2,
      supply: busy(),
    });
  });

  it("uses a pinned scale of at least 1, capped", () => {
    expect(resolveTimeoutScale({ [TIMEOUT_SCALE_ENV]: "1.5" }, busy)).toEqual({
      scale: 1.5,
      supply: undefined,
    });
    expect(resolveTimeoutScale({ [TIMEOUT_SCALE_ENV]: "99" }, busy).scale).toBe(
      MAX_TIMEOUT_SCALE
    );
  });

  it("ignores an invalid pinned scale and measures instead", () => {
    for (const value of ["", "0.5", "fast"]) {
      expect(
        resolveTimeoutScale({ [TIMEOUT_SCALE_ENV]: value }, busy).scale
      ).toBe(2);
    }
  });

  it("measures the real host by default", () => {
    const { scale, supply } = resolveTimeoutScale({});
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(supply?.hostCpus).toBeGreaterThan(0);
    expect(measureCpuSupply().loadAverage).toBeGreaterThanOrEqual(0);
  });
});

describe("scaledTimeout", () => {
  it("multiplies a budget by the published scale", () => {
    expect(scaledTimeout(15_000, { [TIMEOUT_SCALE_ENV]: "2.4" })).toBe(36_000);
  });

  it("keeps the budget without a valid published scale", () => {
    expect(scaledTimeout(15_000, {})).toBe(15_000);
    expect(scaledTimeout(15_000, { [TIMEOUT_SCALE_ENV]: "0" })).toBe(15_000);
  });

  it("reads the scale this Vitest run published", () => {
    expect(scaledTimeout(1000)).toBe(
      Math.round(1000 * Number(process.env[TIMEOUT_SCALE_ENV]))
    );
  });
});

describe("publishLoadFloor", () => {
  const supply = {
    hostCpus: 32,
    loadAverage: 36,
    quotaCpus: Number.POSITIVE_INFINITY,
  };
  const measured = { scale: 1.2, supply };
  const run = { maxWorkers: 32, ...scaledDefaults(1.2) };

  it("adds the run's own workers to the load before the run", () => {
    const env: Record<string, string | undefined> = {};
    expect(publishLoadFloor(env, measured, run)).toBe(
      "[vitest] timeouts x2.2: load 36.0 + 32 workers on 32 CPUs, CPU quota Infinity; measured again before each test file"
    );
    expect(env).toEqual({ [LOAD_FLOOR_ENV]: "68", [TIMEOUT_SCALE_ENV]: "2.2" });
  });

  it("logs only the first publication of the same floor", () => {
    const env: Record<string, string | undefined> = {};
    publishLoadFloor(env, measured, run);
    expect(publishLoadFloor(env, measured, run)).toBeUndefined();
    expect(env[LOAD_FLOOR_ENV]).toBe("68");
  });

  it("publishes the floor without a log line when the scale stays 1", () => {
    const env: Record<string, string | undefined> = {};
    const idle = { scale: 1, supply: { ...supply, loadAverage: 2 } };
    expect(
      publishLoadFloor(env, idle, { maxWorkers: 8, ...scaledDefaults(1) })
    ).toBeUndefined();
    expect(env).toEqual({ [LOAD_FLOOR_ENV]: "10", [TIMEOUT_SCALE_ENV]: "1" });
  });

  it("removes the floor for a pinned scale or a command-line deadline", () => {
    const pinned = { scale: 3, supply: undefined };
    const cases = [
      [pinned, { ...run, ...scaledDefaults(3) }],
      [measured, { ...run, testTimeout: 60_000 }],
      [measured, { ...run, hookTimeout: 60_000 }],
    ] as const;
    for (const [start, resolved] of cases) {
      const env: Record<string, string | undefined> = {
        [LOAD_FLOOR_ENV]: "68",
        [TIMEOUT_SCALE_ENV]: "3",
      };
      expect(publishLoadFloor(env, start, resolved)).toBeUndefined();
      expect(env).toEqual({ [TIMEOUT_SCALE_ENV]: "3" });
    }
  });
});

describe("fileTimeouts", () => {
  const now = (loadAverage: number) => () => ({
    hostCpus: 32,
    loadAverage,
    quotaCpus: Number.POSITIVE_INFINITY,
  });

  it("uses the floor while the one-minute load lags behind the run", () => {
    const env: Record<string, string | undefined> = {
      [LOAD_FLOOR_ENV]: "68",
    };
    expect(fileTimeouts(env, now(30))).toEqual({
      testTimeout: 11_000,
      hookTimeout: 22_000,
    });
    expect(env[TIMEOUT_SCALE_ENV]).toBe("2.2");
  });

  it("follows a load that rose above the floor during the run", () => {
    const env: Record<string, string | undefined> = {
      [LOAD_FLOOR_ENV]: "68.5",
    };
    expect(fileTimeouts(env, now(128))).toEqual({
      testTimeout: 20_000,
      hookTimeout: 40_000,
    });
    expect(env[TIMEOUT_SCALE_ENV]).toBe("4");
  });

  it("changes nothing without a valid floor", () => {
    for (const floor of [undefined, "", "-1", "fast", "1e3"]) {
      const env: Record<string, string | undefined> = {
        [LOAD_FLOOR_ENV]: floor,
        [TIMEOUT_SCALE_ENV]: "1.5",
      };
      expect(fileTimeouts(env, now(128))).toEqual({});
      expect(env[TIMEOUT_SCALE_ENV]).toBe("1.5");
    }
  });
});

describe("scripts/lib/test-timeout-setup.ts", () => {
  it("sets this file's deadlines from a fresh measurement", async () => {
    const saved = {
      floor: process.env[LOAD_FLOOR_ENV],
      scale: process.env[TIMEOUT_SCALE_ENV],
    };
    // Records the call without applying it, so this file keeps its own deadlines.
    const setConfig = vi
      .spyOn(vi, "setConfig")
      .mockImplementation(() => undefined);
    try {
      // A floor far above any host load: the scale is the cap, whatever the load is.
      process.env[LOAD_FLOOR_ENV] = "100000";
      vi.resetModules();
      // A dynamic import on purpose: the setup file acts when it loads, and the
      // test loads it again after setting the floor.
      await import("./test-timeout-setup.ts");
      expect(setConfig).toHaveBeenCalledWith({
        testTimeout: 40_000,
        hookTimeout: 80_000,
      });
      expect(process.env[TIMEOUT_SCALE_ENV]).toBe(String(MAX_TIMEOUT_SCALE));
    } finally {
      setConfig.mockRestore();
      // process.env stores undefined as the text "undefined", so delete instead.
      for (const [name, value] of [
        [LOAD_FLOOR_ENV, saved.floor],
        [TIMEOUT_SCALE_ENV, saved.scale],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // Only in a measured run: a pinned scale or a --testTimeout option publishes no floor.
  it.runIf(process.env[LOAD_FLOOR_ENV] !== undefined)(
    "gave this file the default deadline of its own measured scale",
    ({ task }) => {
      const published = Number(process.env[TIMEOUT_SCALE_ENV]);
      expect(published).toBeGreaterThanOrEqual(1);
      expect(task.timeout).toBe(scaledDefaults(published).testTimeout);
    }
  );
});
