import { describe, expect, it } from "vitest";

import { ResearchScreenWorkspace } from "../../../../components/portal/research-screen.tsx";
import ResearchScreenPage, { metadata } from "./page.tsx";

describe("research screen route", () => {
  it("renders the workspace", () => {
    expect(ResearchScreenPage().type).toBe(ResearchScreenWorkspace);
    expect(metadata.title).toBe("Research screen");
  });
});
