"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { VertexReadGateway } from "../../components/research/vertex-client.ts";
import { ScopeChooser } from "../experience/shared.tsx";
import type { ExperienceScope } from "../experience/ports.ts";
import { createBrowserChartReadTransport } from "./transport.ts";

// Modules reads its catalog through a gateway bound to the chosen account
// scope; ScopeChooser picks a granted scope, nobody types one.
export const ScopedArtifactReads = ({
  children,
}: {
  readonly children: (gateway: VertexReadGateway) => ReactNode;
}) => {
  const [transport] = useState(createBrowserChartReadTransport);
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  const gateway = useMemo(
    () => (scope === null ? null : transport.scoped(scope)),
    [transport, scope]
  );
  return (
    <div>
      <ScopeChooser
        label="Artifact account scope"
        onSelect={setScope}
        onRetire={() => setScope(null)}
      />
      {gateway === null ? null : (
        <div key={JSON.stringify(scope)}>{children(gateway)}</div>
      )}
    </div>
  );
};
