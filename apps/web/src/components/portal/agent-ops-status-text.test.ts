import { describe, expect, it } from "vitest";

import {
  describeAgentApiKeyFailure,
  formatDuration,
  formatMetrics,
  formatTimestamp,
} from "./agent-ops-client.tsx";

describe("agent ops status text", () => {
  it("names a missing timestamp by its caller's state", () => {
    expect(formatTimestamp(null)).toBe("not recorded");
    expect(formatTimestamp(null, "running")).toBe("running");
    return expect(formatTimestamp(new Date("2026-11-15T10:20:00Z"))).toBe(
      "2026-11-15 10:20"
    );
  });

  it("names a task that has not started and empty metrics", () => {
    expect(formatDuration({ finishedAt: null, startedAt: null })).toBe(
      "not started"
    );
    return expect(formatMetrics({})).toBe("no metrics reported");
  });

  it("says no key changed when the key service does not respond", () => {
    return expect(describeAgentApiKeyFailure({ code: "UNAVAILABLE" })).toBe(
      "Agent API key service did not respond (503). No key was changed. Retry."
    );
  });
});
