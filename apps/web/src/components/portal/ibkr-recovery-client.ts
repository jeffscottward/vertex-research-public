"use client";

import {
  type ApiClient,
  createApiClient,
  type IbkrRecoveryRequestOutput,
  type IbkrRecoveryStatusOutput,
} from "@darkfactory/api";
import { RECOVERY_CONFIRMATION } from "@darkfactory/shared/vertex";

// Human IBKR 2FA recovery (ibkrRecovery.*). `request` sends the confirmed statement; the server
// adds the operator identity, audits the request and asks the VPS to start the 2FA script once.
export interface IbkrRecoveryGateway {
  readonly request: () => Promise<IbkrRecoveryRequestOutput>;
  readonly status: () => Promise<IbkrRecoveryStatusOutput>;
}

export const createIbkrRecoveryGateway = (
  client: ApiClient
): IbkrRecoveryGateway => ({
  request: () =>
    client.ibkrRecovery.request({ confirmation: RECOVERY_CONFIRMATION }),
  status: () => client.ibkrRecovery.status({}),
});

export const createBrowserIbkrRecoveryGateway = (): IbkrRecoveryGateway => {
  let gateway: IbkrRecoveryGateway | undefined;
  const current = (): IbkrRecoveryGateway => {
    gateway ??= createIbkrRecoveryGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    request: () => current().request(),
    status: () => current().status(),
  });
};
