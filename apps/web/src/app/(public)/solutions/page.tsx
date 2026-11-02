import { ResearchPublicPage } from "../_components/research-page.tsx";

export const metadata = {
  title: "Method",
  description:
    "Keep hypotheses separate from evidence, context, and authorization.",
};

export default function SolutionsPage() {
  return (
    <ResearchPublicPage
      eyebrow="Vertex Research / Method"
      title="An idea is a question. Not a conclusion."
      introduction="A disciplined inquiry makes the basis for a conclusion inspectable. Start with what a source can support—and be equally precise about what it cannot."
      sections={[
        {
          title: "Ask a falsifiable question",
          body: "Define the claim and identify what evidence could change your view. Avoid choosing a method solely because it confirms the starting assumption.",
          note: "Method guidance, not a saved strategy editor or investment recommendation.",
        },
        {
          title: "Establish the information boundary",
          body: "Review the dataset vintage, availability cutoff, calendar, and source identity before interpreting a result. Later knowledge can change the meaning of an earlier observation.",
          note: "A source timestamp alone does not establish point-in-time correctness.",
        },
        {
          title: "Keep limitations adjacent",
          body: "Read a claim beside its method and limitations, not apart from them. Distinguish source review status from the strength or generality of the conclusion.",
          note: "An accepted evidence record does not imply an approved trade or a proven outcome.",
        },
        {
          title: "Separate research from execution",
          body: "Read access, a module manifest, and a research conclusion are not execution authority. Human decisions and system permissions remain separate boundaries.",
          note: "There are no order or quantity controls in the research workspace.",
        },
      ]}
    />
  );
}
