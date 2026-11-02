import { ResearchPublicPage } from "../_components/research-page.tsx";

export const metadata = {
  title: "About",
  description:
    "Vertex Research is evidence-first research tooling with explicit capability boundaries.",
};

export default function AboutPage() {
  return (
    <ResearchPublicPage
      eyebrow="Vertex Research / About"
      title="Clarity is a research advantage."
      introduction="Vertex Research is a workspace for examining sources, methods, and assumptions. Its purpose is to make reasoning easier to inspect—not to replace judgment with another opaque signal."
      sections={[
        {
          title: "Evidence stays close",
          body: "A claim belongs beside its source, method, and limitations. Useful research should make that relationship easier to follow.",
          note: "Source text remains untrusted content. It never becomes an instruction to the system.",
        },
        {
          title: "Uncertainty stays visible",
          body: "Unknown availability, missing context, and incomplete integration are not design problems to conceal. They are information the researcher needs.",
          note: "No simulated returns, holdings, live prices, or research results are presented as real.",
        },
        {
          title: "Authority stays explicit",
          body: "Read permissions, source rights, review status, and execution authority are separate concerns. A research interface should not blur those lines.",
          note: "Vertex Research describes research tooling, not a regulated fund, advisory relationship, or live trading service.",
        },
      ]}
    />
  );
}
