import { describe, expect, it } from "vitest";

import {
  MAX_TIMEOUT_SCALE,
  measureCpuSupply,
  readCgroupQuotaCpus,
  resolveTimeoutScale,
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
