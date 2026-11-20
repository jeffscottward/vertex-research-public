"use client";

import {
  type ApiClient,
  createApiClient,
  type OpenbbInsiderClustersOutput,
} from "@darkfactory/api";
import type { InsiderClustersSettings } from "./insider-clusters-params.ts";

// Read-only market-wide Form 4 cluster buys (openbb.insiderClusters).
export interface InsiderClustersGateway {
  readonly clusters: (
    settings: InsiderClustersSettings
  ) => Promise<OpenbbInsiderClustersOutput>;
}

export const createInsiderClustersGateway = (
  client: ApiClient
): InsiderClustersGateway => ({
  clusters: ({ days }) => client.openbb.insiderClusters({ days }),
});

export const createBrowserInsiderClustersGateway =
  (): InsiderClustersGateway => {
    let gateway: InsiderClustersGateway | undefined;
    return Object.freeze({
      clusters: (settings: InsiderClustersSettings) => {
        gateway ??= createInsiderClustersGateway(
          createApiClient({ baseUrl: window.location.origin })
        );
        return gateway.clusters(settings);
      },
    });
  };
