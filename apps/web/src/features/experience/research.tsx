"use client";

import { lazy, Suspense, useState } from "react";
import type { ExperienceScope } from "./ports.ts";
import { ExperienceFrame, ScopeChooser } from "./shared.tsx";
// The research chat accepts only research-environment scopes.
const researchScope = (scope: ExperienceScope): boolean =>
  scope.environment === "research";
// Lazy: the chat room pulls in @copilotkit/react-core/v2 and only renders after a scope is chosen.
const ResearchChatRoom = lazy(async () => ({
  default: (await import("./research-chat-room.tsx")).ResearchChatRoom,
}));

// Owner rule (2026-10-30): no exact-ID lookups. The research job form
// (collection and evidence IDs), the source citation lookup and the dataset
// chart lookup were removed; Vertex has no list of collections, datasets or
// evidence to offer instead. The chat room opens on the first granted research
// scope (else the first granted scope).
export const ResearchWorkspace = () => {
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  return (
    <ExperienceFrame title="Research">
      <section id="research-conversations" tabIndex={-1}>
        <ScopeChooser
          onSelect={setScope}
          onRetire={() => setScope(null)}
          prefer={researchScope}
        />
        {scope === null ? null : (
          <Suspense
            fallback={
              <p className="vx-caption" role="status">
                Loading research chat…
              </p>
            }
          >
            <ResearchChatRoom scope={scope} key={JSON.stringify(scope)} />
          </Suspense>
        )}
      </section>
      <p className="vx-caption">
        <a className="vx-text-link" href="/strategies">
          Exact-version strategy review
        </a>
      </p>
    </ExperienceFrame>
  );
};
