import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebateDiagnostic } from "./vertex-research-chat-debate.test-support.ts";

const BUDGET = "VERTEX_CHAT_DEBATE_DIAGNOSTIC_SQL_BUDGET";

// With diagnostics on, each stderr write is one JSON event that names the budget.
const enabledDiagnostic = (budget: string | undefined) => {
  vi.stubEnv("VERTEX_CHAT_DEBATE_DIAGNOSTICS", "1");
  vi.stubEnv(BUDGET, budget);
  const events: unknown[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    events.push(JSON.parse(String(chunk)));
    return true;
  });
  return { diagnostic: createDebateDiagnostic(), events };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("debate diagnostic SQL budget", () => {
  it("defaults to 8,000,000 SQL attempts", () => {
    const { diagnostic, events } = enabledDiagnostic(undefined);
    diagnostic.finish();
    expect(events).toMatchObject([
      {
        event: "finally",
        sql: { attempted: 0 },
        budget: { maximumSqlAttempts: 8_000_000, aborted: false },
      },
    ]);
  });

  it("stops the run at the budget from the environment", () => {
    const { diagnostic, events } = enabledDiagnostic("2");
    const stop = "Diagnostic stop: 2 SQL-attempt budget exhausted";
    diagnostic.observeQuery?.({ sql: "select 1" });
    expect(events).toEqual([]);
    expect(() => diagnostic.observeQuery?.({ sql: "select 1" })).toThrow(stop);
    expect(events).toMatchObject([
      {
        event: "budget-abort",
        sql: { attempted: 2 },
        budget: { maximumSqlAttempts: 2, aborted: true },
      },
    ]);
    // After the stop, no further query is counted and the run cannot pass.
    expect(() => diagnostic.observeQuery?.({ sql: "select 1" })).toThrow(stop);
    expect(() => diagnostic.finish()).toThrow(stop);
    expect(events.at(-1)).toMatchObject({
      event: "finally",
      sql: { attempted: 2 },
    });
  });

  // The budget is checked with diagnostics off too: a wrong value never passes silently.
  it.each(["0", "-1", "1.5", "many", ""])("refuses the budget %j", (budget) => {
    vi.stubEnv("VERTEX_CHAT_DEBATE_DIAGNOSTICS", undefined);
    vi.stubEnv(BUDGET, budget);
    expect(() => createDebateDiagnostic()).toThrow(
      `${BUDGET} must be a positive integer`
    );
  });
});
