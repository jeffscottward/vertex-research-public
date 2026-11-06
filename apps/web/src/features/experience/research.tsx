"use client";

import {
  Button,
  PageHeader,
  StatusBadge,
  type StatusBadgeProps,
} from "@darkfactory/ui";
import { Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { ResearchScopedWorkspace } from "../../components/research/read-scope.tsx";
import type { ExperienceScope } from "./ports.ts";
import { ScopeChooser } from "./shared.tsx";
// The research chat accepts only research-environment scopes.
const researchScope = (scope: ExperienceScope): boolean =>
  scope.environment === "research";
// Lazy: the chat room pulls in @copilotkit/react-core/v2 and only renders after a scope is chosen.
const ResearchChatRoom = lazy(async () => ({
  default: (await import("./research-chat-room.tsx")).ResearchChatRoom,
}));

/** Id of the chat view's "Create a research room" form (research-chat-view.tsx); New room opens it. */
const RESEARCH_NEW_ROOM_ID = "research-new-room";

type ScopeStatus = Readonly<{
  label: string;
  status: StatusBadgeProps["status"];
}>;

// Header chip: the chosen scope's environment. No scope ever carries execution authority here.
const SCOPE_STATUS: Readonly<
  Record<ExperienceScope["environment"], ScopeStatus>
> = {
  live: { label: "Live scope · read only", status: "warning" },
  paper: { label: "Paper scope", status: "neutral" },
  research: { label: "Research only", status: "info" },
};
const NO_SCOPE: ScopeStatus = { label: "No scope yet", status: "neutral" };

/** Opens the chat's create-room form and puts the cursor in its title (the summary when the form is locked). */
const openNewRoom = (): void => {
  const form = document.getElementById(RESEARCH_NEW_ROOM_ID);
  if (!(form instanceof HTMLDetailsElement)) return;
  form.open = true;
  (
    form.querySelector<HTMLElement>("input[name='title']:not(:disabled)") ??
    form.querySelector<HTMLElement>("summary")
  )?.focus();
};

// Owner rule (2026-10-30): no exact-ID lookups. The research job form
// (collection and evidence IDs), the source citation lookup and the dataset
// chart lookup were removed; Vertex has no list of collections, datasets or
// evidence to offer instead. The chat room opens on the first granted research
// scope (else the first granted scope).
export const ResearchWorkspace = ({
  initialThreadId = null,
}: {
  /** Opens this research thread first (the UI lab uses it); null waits for a pick. */
  readonly initialThreadId?: string | null;
} = {}) => {
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  const status = scope === null ? NO_SCOPE : SCOPE_STATUS[scope.environment];
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            data-action="new-research-room"
            disabled={scope === null}
            onClick={openNewRoom}
          >
            <Plus aria-hidden="true" />
            New room
          </Button>
        }
        description="Discuss evidence with corpus-based research agents. Research only: nothing here authorizes a trade."
        status={
          <StatusBadge data-research-scope-status="" status={status.status}>
            {status.label}
          </StatusBadge>
        }
        title="Research"
      />
      <div className="vx-experience">
        <ResearchScopedWorkspace>
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
                <ResearchChatRoom
                  scope={scope}
                  initialThreadId={initialThreadId}
                  key={JSON.stringify(scope)}
                />
              </Suspense>
            )}
          </section>
          <p className="vx-caption">
            <a className="vx-text-link" href="/assistant">
              Open the research assistant
            </a>
            {" · "}
            <a className="vx-text-link" href="/research/reports">
              Research dossiers
            </a>
            {" · "}
            <a className="vx-text-link" href="/knowledge">
              Open the knowledge chat
            </a>
            {" · "}
            <a className="vx-text-link" href="/strategies">
              Exact-version strategy review
            </a>
          </p>
        </ResearchScopedWorkspace>
      </div>
    </div>
  );
};
