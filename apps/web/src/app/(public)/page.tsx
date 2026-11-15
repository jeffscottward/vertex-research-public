import { ArrowDown, ArrowUpRight } from "lucide-react";
import { PublicLink } from "./_components/public-content.tsx";

const principles = [
  {
    title: "Sources before signals",
    body: "Inspect the origin, capture time, and limitations of the evidence behind a research claim. A citation is a starting point, not a conclusion.",
  },
  {
    title: "Context before conclusions",
    body: "Keep dataset vintages, module requirements, and acceptance status in view. Missing context should be visible, not filled in.",
  },
  {
    title: "Research before action",
    body: "Separate investigation from execution. Reviewing an artifact never authorizes a trade, changes a portfolio, or activates a module.",
  },
] as const;

export const metadata = {
  title: "Evidence before conviction",
  description:
    "Vertex Research brings source provenance, data context, and research constraints into one deliberate workspace.",
};

export default function HomePage() {
  return (
    <>
      <section className="df-container vx-hero" aria-labelledby="home-title">
        <div className="vx-hero-copy">
          <p className="vx-eyebrow">
            Vertex Research / A clearer line of inquiry
          </p>
          <h1 id="home-title">
            {"Evidence before "}
            <span>conviction.</span>
          </h1>
          <p className="vx-lede">
            Good research is not another signal. It is knowing what supports a
            claim, what limits it, and what remains unknown.
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
          <div className="vx-plate-heading">
            <span>Research discipline</span>
            <span aria-hidden="true">VR / 01</span>
          </div>
          <h2 id="research-plate-title">
            {"Make the reasoning "}
            <em>inspectable.</em>
          </h2>
          <ol className="vx-plate-sequence">
            <li>
              <span>01 / Question</span>
              <p>What would change your view?</p>
            </li>
            <li>
              <span>02 / Evidence</span>
              <p>Where does the claim come from?</p>
            </li>
            <li>
              <span>03 / Context</span>
              <p>What does the source leave out?</p>
            </li>
          </ol>
          <p className="vx-plate-note">A method, not a performance claim.</p>
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
            <p className="vx-eyebrow">The working principle</p>
            <h2 id="principles-title">
              More context.
              <br />
              Less assumption.
            </h2>
          </div>
          <dl className="vx-principle-list">
            {principles.map((principle, index) => (
              <div key={principle.title}>
                <dt>
                  <span className="vx-index">0{index + 1}</span>
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
          <p className="vx-eyebrow">Inside the workspace</p>
          <h2 id="workspace-title">
            Follow the evidence.
            <br />
            See the boundaries.
          </h2>
        </div>
        <div className="vx-prose">
          <p>
            Read module manifests. Look up a dataset by its catalog identity.
            Inspect an evidence record with its attribution, method, and
            limitations alongside the claim.
          </p>
          <p>
            Availability comes from the connected source. When a service is
            unavailable, the workspace says so. No simulated market feed. No
            invented research results.
          </p>
          <PublicLink href="/features" variant="secondary">
            {"Explore the platform "}
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </PublicLink>
        </div>
      </section>
      <section className="vx-closing" aria-labelledby="home-next-title">
        <div className="df-container">
          <p className="vx-eyebrow">Keep the question open</p>
          <h2 id="home-next-title">
            Build conviction.
            <br />
            Keep the evidence.
          </h2>
          <PublicLink href="/sign-in">
            {"Sign in to Vertex Research "}
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </PublicLink>
        </div>
      </section>
    </>
  );
}
