import { ResearchPublicPage } from "../_components/research-page.tsx";

export const metadata = {
  title: "Platform",
  description:
    "Source-aware read tools for module manifests, dataset context, and research evidence.",
};

export default function FeaturesPage() {
  return (
    <ResearchPublicPage
      eyebrow="Vertex Research / Platform"
      title="A workspace for the evidence behind the idea."
      introduction="Read the method, inspect the data context, and examine the claim. Vertex keeps those layers connected without treating them as interchangeable."
      sections={[
        {
          title: "Module catalog",
          body: "Inspect a module’s declared capabilities, instrument coverage, data requirements, artifact identity, and lifecycle reasons.",
          note: "Read-only manifests. Listing a module does not activate it or establish runtime readiness.",
        },
        {
          title: "Dataset context",
          body: "Look up a dataset by exact identity. Read its source provenance, time interval, capture time, adjustment method, and vintage availability.",
          note: "Manifest access depends on authorization and a connected source. It is not a live market feed.",
        },
        {
          title: "Research evidence",
          body: "Read a collection-scoped evidence record with its attribution, source locator, method, limitations, and review status alongside the claim.",
          note: "No imports, acceptance changes, or generated evidence are performed by this read surface.",
        },
        {
          title: "Explicit boundaries",
          body: "Unavailable sources remain unavailable. Missing records stay missing. Failed validation prevents an artifact from being displayed.",
          note: "Charting, research runs, backtesting, portfolio analysis, and broker actions are not connected in this workspace.",
        },
      ]}
    />
  );
}
