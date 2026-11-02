"use client";

import {
  type ApiClient,
  createApiClient,
  NAUTILUS_ARM_STATEMENT,
  type NautilusArmChangeOutput,
  type NautilusArmStatusOutput,
} from "@darkfactory/api";

// Nautilus node arm switch (nautilusArm.*). `arm` sends the owner's password, the typed reason, the image
// version the owner saw and the exact statement; the server checks the password, writes the audit record
// and asks the VPS to arm once. `disarm` is one call without a password.
export interface NautilusArmGateway {
  readonly arm: (
    input: Readonly<{ imageVersion: string; password: string; reason: string }>
  ) => Promise<NautilusArmChangeOutput>;
  readonly disarm: () => Promise<NautilusArmChangeOutput>;
  readonly status: () => Promise<NautilusArmStatusOutput>;
}

export const createNautilusArmGateway = (
  client: ApiClient
): NautilusArmGateway => ({
  arm: (input) =>
    client.nautilusArm.arm({ ...input, statement: NAUTILUS_ARM_STATEMENT }),
  disarm: () => client.nautilusArm.disarm({}),
  status: () => client.nautilusArm.status({}),
});

export const createBrowserNautilusArmGateway = (): NautilusArmGateway => {
  let gateway: NautilusArmGateway | undefined;
  const current = (): NautilusArmGateway => {
    gateway ??= createNautilusArmGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze<NautilusArmGateway>({
    arm: (input) => current().arm(input),
    disarm: () => current().disarm(),
    status: () => current().status(),
  });
};
