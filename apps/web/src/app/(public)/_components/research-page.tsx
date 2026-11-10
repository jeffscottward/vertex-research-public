import { PublicLink } from "./public-content.tsx";

export interface ResearchPublicPageProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly introduction: string;
  readonly sections: readonly Readonly<{
    title: string;
    body: string;
    note: string;
  }>[];
}

export const ResearchPublicPage = ({
  eyebrow,
  title,
  introduction,
  sections,
}: ResearchPublicPageProps) => (
  <>
    <section
      className="df-container vx-section"
      aria-labelledby="public-page-title"
    >
      <header className="vx-page-heading">
        <p className="vx-eyebrow">{eyebrow}</p>
        <h1 id="public-page-title">{title}</h1>
        <p>{introduction}</p>
      </header>
      <div className="vx-editorial-grid">
        <div className="vx-prose">
          <p>
            Source-backed research begins with a clear boundary between what is
            known, what is inferred, and what has not been verified.
          </p>
          <PublicLink href="/sign-in">Enter the workspace</PublicLink>
        </div>
        <dl className="vx-principle-list">
          {sections.map((section, index) => (
            <div key={section.title}>
              <dt>
                <span className="vx-index">0{index + 1}</span>
                <h2 className="text-xl">{section.title}</h2>
              </dt>
              <dd>
                <p>{section.body}</p>
                <p className="mt-4 text-muted-foreground text-sm leading-relaxed">
                  {section.note}
                </p>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  </>
);
