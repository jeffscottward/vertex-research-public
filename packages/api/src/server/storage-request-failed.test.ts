import { describe, expect, it } from "vitest";

import {
  storageReadFailedMessage,
  storageWriteFailedMessage,
} from "./storage-request-failed.ts";

const NOW = Date.parse("2026-11-15T14:02:30Z");

describe("storage request failed messages", () => {
  it("names the cause, the time and the next step of a failed read", () => {
    expect(storageReadFailedMessage("Plays", NOW)).toBe(
      "Plays storage: the database returned an error at 14:02 UTC. Nothing was changed. Try again."
    );
    expect(storageReadFailedMessage("Plays")).toMatch(/at \d\d:\d\d UTC/u);
  });

  it("does not claim a failed write changed nothing", () => {
    expect(storageWriteFailedMessage("Strategy definition", NOW)).toBe(
      "Strategy definition storage: the database returned an error at 14:02 UTC. Reload to check whether the change was saved."
    );
    expect(storageWriteFailedMessage("Strategy definition")).toMatch(
      /at \d\d:\d\d UTC/u
    );
  });
});
