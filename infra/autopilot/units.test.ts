import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Autopilot scheduler timer must share the :00 minute boundary with vertex-flow.timer so the
// two every-minute pollers never split a minute into <35 s halves and starve
// infra/quantvps/restart-when-idle.sh (quiet window 30 s + poll interval 5 s).
const readRepo = (relativeFromHere: string): string =>
  readFileSync(
    fileURLToPath(new URL(relativeFromHere, import.meta.url)),
    "utf8"
  );

const directives = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

describe("vertex-autopilot units", () => {
  const timer = readRepo("./vertex-autopilot.timer");
  const service = readRepo("./vertex-autopilot.service");
  const flowTimer = readRepo("../flow/quantvps/vertex-flow.timer");
  const restartScript = readRepo("../quantvps/restart-when-idle.sh");

  it("aligns to the :00 minute boundary without phase drift", () => {
    expect(directives(timer, "OnCalendar")).toEqual(["*-*-* *:*:00"]);
    expect(directives(timer, "AccuracySec")).toEqual(["1s"]);
    expect(directives(timer, "Persistent")).toEqual(["false"]);
    expect(directives(timer, "OnUnitActiveSec")).toEqual([]);
    expect(directives(timer, "OnBootSec")).toEqual([]);
    expect(directives(timer, "RandomizedDelaySec")).toEqual([]);
  });

  it("shares the exact calendar schedule of vertex-flow.timer for restart-when-idle", () => {
    expect(directives(timer, "OnCalendar")).toEqual(
      directives(flowTimer, "OnCalendar")
    );
    expect(directives(timer, "AccuracySec")).toEqual(
      directives(flowTimer, "AccuracySec")
    );
    expect(directives(flowTimer, "RandomizedDelaySec")).toEqual([]);
    // restart-when-idle keeps its 30 s quiet window and 5 s poll interval (35 s total);
    // aligned :00 ticks leave a 39-59 s gap every minute.
    expect(restartScript).toContain('QUIET="${VERTEX_RESTART_QUIET:-30}"');
    expect(restartScript).toContain('POLL="${VERTEX_RESTART_POLL:-5}"');
  });

  it("keeps the service oneshot so systemd skips overlapping ticks", () => {
    expect(directives(service, "Type")).toEqual(["oneshot"]);
    expect(directives(service, "ExecStart")).toEqual([
      "/usr/bin/env bun run vertex:autopilot:tick",
    ]);
  });
});
