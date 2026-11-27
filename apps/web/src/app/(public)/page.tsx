import { ArrowDown, ArrowUpRight } from "lucide-react";
import { PublicLink } from "./_components/public-content.tsx";

const principles = [
  {
    title: "Each claim shows its source",
    body: "Inspect the origin, capture time, and limitations of the evidence behind a research claim. A citation is where the check starts.",
  },
  {
    title: "Missing context stays visible",
    body: "Keep dataset vintages, module requirements, and acceptance status in view. The workspace shows missing context and does not fill it in.",
  },
  {
    title: "Research is separate from execution",
    body: "Separate investigation from execution. Reviewing an artifact never authorizes a trade, changes a portfolio, or activates a module.",
  },
] as const;

export const metadata = {
  title: "Evidence-first research workspace",
  description:
    "Vertex Research brings source provenance, data context, and research constraints into one deliberate workspace.",
};

export default function HomePage() {
  return (
    <>
      <section className="df-container vx-hero" aria-labelledby="home-title">
        <div className="vx-hero-copy">
          <h1 id="home-title">See the evidence behind every research claim</h1>
          <p className="vx-lede">
            Vertex Research shows what supports a claim, what limits it, and
            what remains unknown.
          </p>
          <div className="vx-actions">
            <PublicLink href="/sign-in">
              {"Enter the workspace "}
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </PublicLink>
            <PublicLink href="#research-principles" variant="link">
              {"Explore our approach "}
              <ArrowDown aria-hidden="true" className="size-4" />
            </PublicLink>
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Research tooling. Not investment advice or an execution service.
          </p>
        </div>
        <aside
          className="vx-research-plate"
          aria-labelledby="research-plate-title"
        >
          <h2 id="research-plate-title">Three questions for each claim</h2>
          <ol className="vx-plate-sequence">
            <li>
              <span>Question</span>
              <p>What would change your view?</p>
            </li>
            <li>
              <span>Evidence</span>
              <p>Where does the claim come from?</p>
            </li>
            <li>
              <span>Context</span>
              <p>What does the source leave out?</p>
            </li>
          </ol>
          <p className="vx-plate-note">
            This is a research method. It makes no claim about performance.
          </p>
        </aside>
      </section>
      <section
        className="vx-principles"
        id="research-principles"
        tabIndex={-1}
        aria-labelledby="principles-title"
      >
        <div className="df-container vx-editorial-grid">
          <div>
            <h2 id="principles-title">How the workspace handles evidence</h2>
          </div>
          <dl className="vx-principle-list">
            {principles.map((principle) => (
              <div key={principle.title}>
                <dt>
                  <h3>{principle.title}</h3>
                </dt>
                <dd>{principle.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
      <section
        className="df-container vx-editorial-grid vx-section"
        aria-labelledby="workspace-title"
      >
        <div>
          <h2 id="workspace-title">What you can read in the workspace</h2>
        </div>
        <div className="vx-prose">
          <p>
            Read module manifests. Look up a dataset by its catalog identity.
            Inspect an evidence record with its attribution, method, and
            limitations alongside the claim.
          </p>
          <p>
            Availability comes from the connected source. When a service is
            unavailable, the workspace says so. The workspace does not simulate
            a market feed and does not invent research results.
          </p>
          <PublicLink href="/features" variant="secondary">
            {"Explore the platform "}
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </PublicLink>
        </div>
      </section>
      <section className="vx-closing" aria-labelledby="home-next-title">
        <div className="df-container">
          <h2 id="home-next-title">Open the workspace</h2>
          <PublicLink href="/sign-in">
            {"Sign in to Vertex Research "}
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </PublicLink>
        </div>
      </section>
    </>
  );
}
