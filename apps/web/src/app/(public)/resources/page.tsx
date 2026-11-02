import { ResearchPublicPage } from "../_components/research-page.tsx";

export const metadata = {
  title: "Field guide",
  description:
    "How to read identities, provenance, review status, and unavailable states in Vertex Research.",
};

export default function ResourcesPage() {
  return (
    <ResearchPublicPage
      eyebrow="Vertex Research / Field guide"
      title="Read the record. Understand the context."
      introduction="A short guide to the language used in the workspace. These distinctions matter more than a polished result."
      sections={[
        {
          title: "Identity is not access",
          body: "A dataset ID or collection ID locates a record. The authenticated server still determines whether your session may read it. Ask the source owner for the exact identifiers.",
          note: "Identifiers begin with a letter or number and may contain letters, numbers, underscores, periods, colons, and hyphens; maximum 160 characters.",
        },
        {
          title: "Provenance is not validity",
          body: "A source identity, snapshot, and content hash help trace an artifact. They do not, by themselves, establish that a claim is correct, complete, or suitable for a decision.",
          note: "Use attribution, method, and limitations to evaluate the record in context.",
        },
        {
          title: "Capture time is not freshness",
          body: "Capture time records when an artifact was captured. An availability cutoff and data vintage describe a different boundary. Neither should be silently replaced with the current time.",
          note: "Dataset intervals are displayed with an inclusive start and exclusive end.",
        },
        {
          title: "Unavailable is a useful answer",
          body: "An empty catalog, denied access, a missing identity, an unavailable service, and a malformed response are different states. The workspace keeps them distinct and avoids substituting sample data.",
          note: "For a failed read, check your identifier or session first. Retry only when the source or connection is available.",
        },
      ]}
    />
  );
}
