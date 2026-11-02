import type { DatabaseExecutor } from "@darkfactory/db/server";
import type * as RedactionModule from "@darkfactory/observability/redaction";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowPersistenceInputError,
  createWorkflowRepository,
} from "./workflow-repository.ts";

// One file-wide mock with a per-test result. The repository module graph then
// loads once, with the static import, before any test starts. A per-test
// vi.resetModules() and dynamic import put that load (about 3 s idle, more
// under load) inside the first test's 5 s limit.
const redaction = vi.hoisted(() => ({
  result: undefined as { value: unknown } | undefined,
}));

vi.mock("@darkfactory/observability/redaction", async (importOriginal) => {
  const actual = await importOriginal<typeof RedactionModule>();
  return {
    ...actual,
    redact: (...input: Parameters<typeof actual.redact>): unknown =>
      redaction.result === undefined
        ? actual.redact(...input)
        : redaction.result.value,
  };
});

const repositoryWithRedaction = (redacted: unknown) => {
  redaction.result = { value: redacted };
  const execute = vi.fn();
  const database = { execute } as unknown as DatabaseExecutor;
  return { execute, repository: createWorkflowRepository(database) };
};

afterEach(() => {
  redaction.result = undefined;
});

describe("workflow persistence redaction failures", () => {
  it("rejects a text redaction that does not remain text", async () => {
    const { execute, repository } = repositoryWithRedaction({ redacted: true });

    const failure = repository.failRetainedResource({
      runId: "run-1",
      leaseOwner: "cleanup-worker",
      fence: 2,
      error: "cleanup failed",
    });
    await expect(failure).rejects.toBeInstanceOf(WorkflowPersistenceInputError);
    await expect(failure).rejects.toThrow("cleanup.error must be text");
    return expect(execute).not.toHaveBeenCalled();
  });

  return it("rejects text that expands beyond its limit during redaction", async () => {
    const { execute, repository } = repositoryWithRedaction(
      "x".repeat(4 * 1024 + 1)
    );

    const failure = repository.failRetainedResource({
      runId: "run-1",
      leaseOwner: "cleanup-worker",
      fence: 2,
      error: "cleanup failed",
    });
    await expect(failure).rejects.toBeInstanceOf(WorkflowPersistenceInputError);
    await expect(failure).rejects.toThrow(
      "cleanup.error exceeds its storage limit"
    );
    return expect(execute).not.toHaveBeenCalled();
  });
});
