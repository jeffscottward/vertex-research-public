import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// install-history.sh runs as root on QuantVPS, so the test never runs the whole file. It cuts the
// market hours guard (the text between the two marker comments) and runs that block with a fixed
// New York time (test hook VERTEX_DEPLOY_NY_TIME).
const text = readFileSync(
  fileURLToPath(new URL("./install-history.sh", import.meta.url)),
  "utf8"
);
const START = "# market-hours-guard:start\n";
const END = "# market-hours-guard:end\n";
const block = text.slice(text.indexOf(START), text.indexOf(END));

const guard = (time: string) => {
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${block}\necho guard-passed`],
    {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        VERTEX_DEPLOY_NY_TIME: time,
      },
    }
  );
  return { status: result.status, stdout: result.stdout };
};

describe("install-history.sh market hours guard", () => {
  it("sits after the host-config check and before the first write", () => {
    expect(text.indexOf(START)).toBeGreaterThan(text.indexOf("RIG_IPS=$("));
    expect(text.indexOf(END)).toBeGreaterThan(text.indexOf(START));
    expect(text.indexOf("mkdir -p")).toBeGreaterThan(text.indexOf(END));
    expect(block).toContain("America/New_York");
  });

  it("refuses on a weekday from 08:30 to 15:59 New York time and changes nothing", () => {
    for (const time of ["1 0830 EST", "3 1200 EDT", "5 1559 EDT"]) {
      const result = guard(time);
      expect(result.status).toBe(3);
      expect(result.stdout).toContain(
        "market hours (08:30-16:00 New York time on a weekday) or unknown time: no QuantVPS deploy now; nothing changed"
      );
      expect(result.stdout).not.toContain("guard-passed");
    }
  });

  it("allows 08:29, 16:00 and the weekend", () => {
    for (const time of [
      "1 0829 EST",
      "5 1600 EDT",
      "6 1200 EST",
      "7 0900 EDT",
    ]) {
      const result = guard(time);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("guard-passed");
      expect(result.stdout).toContain(
        "market hours guard: test hook VERTEX_DEPLOY_NY_TIME replaces the clock"
      );
    }
  });

  it("counts a time that cannot be read as market hours", () => {
    for (const time of [
      "6 1200 UTC",
      "6 1200",
      "8 1200 EST",
      "6 2500 EST",
      "x",
    ]) {
      expect(guard(time).status).toBe(3);
    }
  });

  it("has no override", () => {
    expect(block).not.toMatch(/ALLOW/u);
  });
});
