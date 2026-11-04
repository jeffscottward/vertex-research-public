import { describe, expect, it } from "vitest";

import {
  ResearchReportDetail,
  ResearchReportsCatalog,
} from "../../../../components/portal/research-reports.tsx";
import ResearchReportPage, {
  metadata as reportMetadata,
} from "./[reportId]/page.tsx";
import ResearchReportsPage, { metadata } from "./page.tsx";

describe("research dossier routes", () => {
  it("renders the catalog", () => {
    expect((ResearchReportsPage() as { type: unknown }).type).toBe(
      ResearchReportsCatalog
    );
    expect(metadata.title).toBe("Research dossiers");
  });

  it("renders the detail for the decoded report id", async () => {
    const page = (await ResearchReportPage({
      params: Promise.resolve({ reportId: "NVDA%20" }),
    })) as { type: unknown; props: { reportId: string } };
    expect(page.type).toBe(ResearchReportDetail);
    expect(page.props.reportId).toBe("NVDA ");
    const malformed = (await ResearchReportPage({
      params: Promise.resolve({ reportId: "%E0%A4%A" }),
    })) as { props: { reportId: string } };
    expect(malformed.props.reportId).toBe("%E0%A4%A");
    expect(reportMetadata.title).toBe("Research dossier");
  });
});
