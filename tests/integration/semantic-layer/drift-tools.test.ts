import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_DRIFT_THRESHOLDS } from "../../../packages/api/src/forward-drift.ts";
import { type EvalBackend, startEvalBackend } from "./harness.ts";

// The drift monitors of fixture.sql must have the row shape the API writes (all five thresholds), so the
// assistant's drift_status tool (backtestRuns/drift/list) answers on the eval backend instead of failing
// the output contract with a 500.
let backend: EvalBackend;

describe("drift_status on the eval fixture", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("lists the three fixture monitors with their levels and thresholds", async () => {
    const result = await backend.callProcedure("backtestRuns/drift/list", {
      limit: 50,
    });
    if (!result.ok) throw new Error(result.message);
    const { monitors, openAlerts } = result.value as {
      monitors: readonly Readonly<{
        id: string;
        level: string;
        thresholds: Readonly<Record<string, unknown>>;
      }>[];
      openAlerts: readonly unknown[];
    };
    expect(
      monitors.map((monitor) => [monitor.id, monitor.level]).sort()
    ).toEqual([
      ["m_mom", "warn"],
      ["m_mr", "ok"],
      ["m_orb", "alert"],
    ]);
    // The fixture copies the defaults into SQL; a changed default must change the fixture too.
    for (const monitor of monitors) {
      expect(monitor.thresholds).toEqual(DEFAULT_DRIFT_THRESHOLDS);
    }
    expect(openAlerts).toEqual([]);
  });

  // drift_monitor_get reads the same rows. With no forward points in the fixture it answers with the
  // evaluated level "insufficient", not the stored level that drift_status lists.
  it.each(["m_orb", "m_mom", "m_mr"])(
    "answers drift_monitor_get for %s",
    async (id) => {
      const result = await backend.callProcedure("backtestRuns/drift/get", {
        id,
      });
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toMatchObject({ id, level: "insufficient" });
    }
  );
});
