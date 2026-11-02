"use client";

import { Button } from "@darkfactory/ui";

import { useEffect, useState, useSyncExternalStore } from "react";
import { RotateCcw } from "lucide-react";
import type { VertexReadGateway } from "./vertex-client.ts";
import { ScopedArtifactReads } from "../../features/charts/data-binding.tsx";
import { createReadResource, type ReadResource } from "./read-resource.ts";
import { ModuleResults } from "./research-views.tsx";
import { useResearchReadScope } from "./read-scope.tsx";

const useReadState = <Input, Value>(resource: ReadResource<Input, Value>) => {
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  );
  useEffect(() => () => resource.clear(), [resource]);
  return state;
};

const ModulesContent = ({
  gateway,
}: {
  readonly gateway: VertexReadGateway;
}) => {
  const scope = useResearchReadScope();
  const [resource] = useState(() =>
    createReadResource(
      (_input: undefined, signal) => gateway.modules(signal),
      12_000,
      scope ?? undefined
    )
  );
  const state = useReadState(resource);
  useEffect(() => {
    void resource.load(undefined);
    return;
  }, [resource]);
  const reload = () => {
    void resource.load(undefined);
    return;
  };
  return (
    <section aria-label="Module catalog" className="vx-work-section">
      <div className="vx-section-toolbar">
        <p className="vx-caption">
          Read-only catalog · no module activation controls
        </p>
        <Button
          variant="outline"
          disabled={state.type === "loading"}
          onClick={reload}
          type="button"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Refresh catalog
        </Button>
      </div>
      <ModuleResults state={state} retry={reload} />
    </section>
  );
};

export const ModulesWorkspace = ({
  gateway,
}: {
  readonly gateway?: VertexReadGateway;
}) => {
  return gateway === undefined ? (
    <ScopedArtifactReads>
      {(scoped) => <ModulesContent gateway={scoped} />}
    </ScopedArtifactReads>
  ) : (
    <ModulesContent gateway={gateway} />
  );
};
