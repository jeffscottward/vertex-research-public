import { describe, expect, it } from "vitest";

import { AgentModelRunDetail } from "../../../../../components/portal/agent-model-run-detail.tsx";
import AgentModelRunPage, { metadata } from "./page.tsx";

describe("model run detail route", () => {
  it("renders the detail for the decoded run id", async () => {
    const page = (await AgentModelRunPage({
      params: Promise.resolve({ id: "run%3A1" }),
    })) as { type: unknown; props: { runId: string } };
    expect(page.type).toBe(AgentModelRunDetail);
    expect(page.props.runId).toBe("run:1");
    expect(metadata.title).toBe("Model run");
  });
});
