import { describe, expect, it } from "vitest";

import {
  ResearchReportDetail,
  ResearchReportsCatalog,
} from "../../../../components/portal/research-reports.tsx";
import ResearchReportPage, {
  metadata as reportMetadata,
} from "./[reportId]/page.tsx";
import ResearchReportsPage, { metadata } from "./page.tsx";

const detail = async (
  reportId: string,
  search: Readonly<Record<string, string | readonly string[] | undefined>> = {}
) =>
  await ResearchReportPage({
    params: Promise.resolve({ reportId }),
    searchParams: Promise.resolve(search),
  });

describe("research dossier routes", () => {
  it("renders the catalog", () => {
    expect(ResearchReportsPage().type).toBe(ResearchReportsCatalog);
    expect(metadata.title).toBe("Research dossiers");
  });

  it("renders the detail for the decoded report id", async () => {
    const page = await detail("NVDA%20");
    expect(page.type).toBe(ResearchReportDetail);
    expect(page.props.reportId).toBe("NVDA ");
    expect(page.props.initialTab).toBeUndefined();
    const malformed = await detail("%E0%A4%A");
    expect(malformed.props.reportId).toBe("%E0%A4%A");
    expect(reportMetadata.title).toBe("Research dossier");
  });

  it("passes a single ?tab= value through and ignores a repeated one", async () => {
    expect((await detail("AAA", { tab: "news" })).props.initialTab).toBe(
      "news"
    );
    expect(
      (await detail("AAA", { tab: ["news", "market"] })).props.initialTab
    ).toBeUndefined();
  });
});
