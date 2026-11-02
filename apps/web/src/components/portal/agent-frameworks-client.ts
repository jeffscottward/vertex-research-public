"use client";

import {
  type AgentFrameworkOutput,
  type AgentFrameworkStatusValue,
  type ApiClient,
  createApiClient,
} from "@darkfactory/api";

// Operator read of the framework reference sheets (agentModelRuns.frameworks). Research only.

export interface AgentFrameworksGateway {
  readonly frameworks: () => Promise<readonly AgentFrameworkOutput[]>;
}

const createAgentFrameworksGateway = (
  client: ApiClient
): AgentFrameworksGateway => ({
  frameworks: async () =>
    (await client.agentModelRuns.frameworks({})).frameworks,
});

export const createBrowserAgentFrameworksGateway =
  (): AgentFrameworksGateway => {
    let gateway: AgentFrameworksGateway | undefined;
    return Object.freeze({
      frameworks: () => {
        gateway ??= createAgentFrameworksGateway(
          createApiClient({ baseUrl: window.location.origin })
        );
        return gateway.frameworks();
      },
    });
  };

export const FRAMEWORK_STATUS_LABELS: Readonly<
  Record<AgentFrameworkStatusValue, string>
> = Object.freeze({
  adapted: "Adapted code",
  external: "Runs upstream unmodified",
  reimplemented: "Re-implemented in Vertex",
});

export const POINT_IN_TIME_LABELS: Readonly<
  Record<AgentFrameworkOutput["dataSources"][number]["pointInTime"], string>
> = Object.freeze({
  caller: "Point in time: as supplied",
  no: "Not point in time",
  yes: "Point in time",
});
