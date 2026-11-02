import { alertTitleClassName, alertVariants } from "@darkfactory/ui";
import type { ReactNode } from "react";
import type { ModuleManifest } from "@darkfactory/api/vertex";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import type { VertexFailure } from "./vertex-client.ts";
import type { ReadState } from "./read-resource.ts";

export const ResearchHeading = ({
  title,
  level = 1,
}: {
  readonly title: string;
  /** 2 when the page shell already renders the h1 (one h1 per page). */
  readonly level?: 1 | 2;
}) => (
  <header className="vx-page-heading">
    {level === 1 ? <h1>{title}</h1> : <h2>{title}</h2>}
  </header>
);

export const ReadNotice = ({
  title,
  children,
  loading = false,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly loading?: boolean;
}) => (
  <div
    className={alertVariants()}
    role="status"
    aria-live="polite"
    aria-busy={loading}
  >
    <p className={alertTitleClassName}>{title}</p>
    {children === undefined ||
    children === null ||
    children === false ? null : (
      <p>{children}</p>
    )}
  </div>
);

export const ReadFailure = ({
  failure,
  returnTo,
  retry,
}: {
  readonly failure: VertexFailure;
  readonly returnTo: "/modules";
  readonly retry: () => void;
}) => (
  <div className={alertVariants({ variant: "destructive" })} role="alert">
    <p className={alertTitleClassName}>{failure.title}</p>
    <p>{failure.detail}</p>
    {failure.kind === "unauthorized" ? (
      <a
        className="vx-text-link"
        href={`/sign-in?callbackURL=${encodeURIComponent(returnTo)}`}
      >
        {"Sign in to continue "}
        <ArrowUpRight aria-hidden="true" className="size-4" />
      </a>
    ) : failure.kind === "denied" ? (
      <a className="vx-text-link" href="/account">
        {"Review your account "}
        <ArrowUpRight aria-hidden="true" className="size-4" />
      </a>
    ) : failure.kind === "suspended" ? (
      <a className="vx-text-link" href={returnTo}>
        {"Verify the workspace session "}
        <ArrowUpRight aria-hidden="true" className="size-4" />
      </a>
    ) : failure.kind === "invalid" || failure.kind === "not-found" ? null : (
      <button className="vx-text-link" onClick={retry} type="button">
        <RotateCcw aria-hidden="true" className="size-4" />
        Retry read
      </button>
    )}
  </div>
);

export const ArtifactFacts = ({
  entries,
}: {
  readonly entries: readonly (readonly [string, ReactNode])[];
}) => (
  <dl className="vx-facts">
    {entries.map(([label, value]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export const ModuleResults = ({
  state,
  retry,
}: {
  readonly state: ReadState<readonly ModuleManifest[]>;
  readonly retry: () => void;
}) => {
  if (state.type === "idle" || state.type === "loading") {
    return <ReadNotice title="Reading module manifests" loading />;
  }
  if (state.type === "error")
    return (
      <ReadFailure failure={state.failure} retry={retry} returnTo="/modules" />
    );
  if (state.value.length === 0) {
    return (
      <ReadNotice title="No modules returned">
        The catalog returned no modules for this session. Runtime connection and
        readiness remain unverified.
      </ReadNotice>
    );
  }
  return (
    <div className="vx-module-list">
      <p className="sr-only" role="status">
        Module catalog loaded.
      </p>
      {state.value.map((module) => (
        <article
          className="vx-module"
          key={module.moduleId}
          aria-labelledby={`module-${module.moduleId}`}
        >
          <div className="vx-module-heading">
            <div>
              <p className="vx-eyebrow">Module manifest / {module.version}</p>
              <h2 id={`module-${module.moduleId}`}>{module.moduleId}</h2>
            </div>
            <span className="vx-status">{module.lifecycleState}</span>
          </div>
          <p className="vx-caption">
            This status describes the catalog entry. A manifest does not prove
            runtime connection or grant execution permission.
          </p>
          <ArtifactFacts
            entries={[
              ["Declared capabilities", module.capabilities.join(", ")],
              ["Runtime", module.runtime],
              [
                "Instruments",
                module.supportedInstruments.join(", ") || "None declared",
              ],
              [
                "Reason codes",
                module.reasonCodes.join(", ") || "None supplied",
              ],
            ]}
          />
          <details className="vx-details">
            <summary>Inspect requirements & artifact identity</summary>
            <ArtifactFacts
              entries={[
                ["Artifact digest", module.artifactDigest],
                [
                  "Input / output schema",
                  `${module.inputSchemaVersion} / ${module.outputSchemaVersion}`,
                ],
                ["Risk policy version", module.riskPolicyVersion],
              ]}
            />
            {module.dataRequirements.length === 0 ? (
              <p className="vx-caption">No data requirements declared.</p>
            ) : (
              <ul className="vx-requirements">
                {module.dataRequirements.map((requirement, index) => (
                  <li key={`${requirement.kind}-${index}`}>
                    <strong>{requirement.kind}</strong>
                    {" · maximum age "}
                    {requirement.maximumAgeMs}
                    {" ms · "}
                    {requirement.pointInTimeRequired
                      ? "point-in-time required"
                      : "point-in-time not required"}
                    <span>
                      Entitlement policy: {requirement.entitlementPolicyId}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </article>
      ))}
    </div>
  );
};
