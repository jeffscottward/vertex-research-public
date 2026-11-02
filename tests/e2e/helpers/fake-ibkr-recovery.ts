import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// Fake QuantVPS vertex-ibkr-recovery service for the browser E2E run. It speaks the v1 HTTP
// contract (docs/vertex-rebuild/quantvps-status-endpoint.md, IBKR recovery section) on loopback
// and starts nothing. It also fakes the Nautilus arm switch routes (/nautilus/*); no node exists here. Specs choose a scenario through POST /__scenario and read the received
// requests through GET /__calls. Fictional data only.

export const FAKE_IBKR_RECOVERY_TOKEN =
  "e2e-fake-ibkr-recovery-token-0123456789abcdef";
export const FAKE_IBKR_RECOVERY_HOST = "ibkr-recovery-fake";
const PREFIX = "/vertex-ibkr-recovery/v1";
const STATEMENT =
  "I request IBKR recovery only; this does not authorize trading.";

export type FakeRecoveryScenario = "logged-in" | "logged-out" | "cooldown";
// Nautilus arm switch routes (/nautilus/*): the node state the fake reports. Set through POST /__node.
export type FakeNodeScenario = "disarmed" | "armed" | "down";
const FAKE_NODE_IMAGE_VERSION = "1.4.2-e2e";
const ARM_STATEMENT = "I arm the Nautilus node; it may submit live orders.";

type Gateway = Readonly<{
  loginState: string;
  needsLogin: boolean;
  since: string | null;
  reason: string;
}>;

interface RecoveryRequest {
  requestId: string;
  actorId: string;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  state: string;
  detail: string;
  scriptRunning: boolean;
}

// Each status read after a start moves the request one step, so the browser shows every state.
const STEPS = ["requested", "waiting-for-approval", "verifying", "logged-in"];

const iso = (ms: number): string => new Date(ms).toISOString();

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

export const startFakeIbkrRecovery = async (): Promise<
  Readonly<{ port: number; close: () => Promise<void> }>
> => {
  let gateway: Gateway;
  let active: RecoveryRequest | null;
  let cooldownUntil: number | null;
  let step: number;
  let posts: unknown[];
  let node: FakeNodeScenario = "disarmed";
  let armedRecord: Readonly<{ by: string; at: string; reason: string }> | null =
    null;
  let nodePosts: unknown[] = [];

  const resetNode = (scenario: FakeNodeScenario): void => {
    node = scenario;
    nodePosts = [];
    armedRecord =
      scenario === "armed"
        ? {
            at: iso(Date.now() - 60_000),
            by: "someone-else",
            reason: "Armed before this test",
          }
        : null;
  };

  const armState = () => ({
    armed: armedRecord !== null,
    armedAt: armedRecord?.at ?? null,
    armedBy: armedRecord?.by ?? null,
    detail: armedRecord === null ? "no_arm_record" : "armed",
    imageVersion: FAKE_NODE_IMAGE_VERSION,
    killSwitchActive: false,
    reason: armedRecord?.reason ?? null,
    state: armedRecord === null ? "disarmed" : "armed",
  });

  const nodeStatus = () => ({
    arm: node === "down" ? null : armState(),
    armError: node === "down" ? "not-running" : null,
    container:
      node === "down"
        ? { health: null, state: "exited" }
        : { health: "healthy", state: "running" },
    generatedAt: iso(Date.now()),
    schema: "vertex-nautilus-arm-status-v1",
    version: "1.0.0-e2e",
  });

  // POST /nautilus/arm and /nautilus/disarm: the bridge body rules and the node refusals that matter here.
  const nodeChange = (
    action: "arm" | "disarm",
    body: Record<string, unknown>
  ): [number, unknown] => {
    nodePosts.push({ action, ...body });
    if (node === "down")
      return [409, { detail: "exited", error: "not_running" }];
    if (action === "arm") {
      if (body["statement"] !== ARM_STATEMENT)
        return [400, { error: "bad_request" }];
      if (body["imageVersion"] !== FAKE_NODE_IMAGE_VERSION)
        return [409, { detail: "version", error: "version_mismatch" }];
      armedRecord = {
        at: iso(Date.now()),
        by: String(body["actorId"]),
        reason: String(body["reason"]),
      };
    } else armedRecord = null;
    return [
      200,
      {
        action,
        arm: armState(),
        auditId: `e2e-audit-${nodePosts.length}`,
        requestId: body["requestId"],
        schema: "vertex-nautilus-arm-result-v1",
      },
    ];
  };

  const reset = (scenario: FakeRecoveryScenario): void => {
    const now = Date.now();
    step = 0;
    posts = [];
    active = null;
    cooldownUntil = null;
    gateway =
      scenario === "logged-in"
        ? {
            loginState: "logged-in",
            needsLogin: false,
            reason: "logged-in",
            since: iso(now - 3_600_000),
          }
        : {
            loginState: "logged-out",
            needsLogin: true,
            reason: "2fa-timeout",
            since: iso(now - 600_000),
          };
    if (scenario === "cooldown") {
      cooldownUntil = now + 600_000;
      active = {
        actorId: "someone-else",
        detail: "no approval within 300 s",
        finishedAt: iso(now - 60_000),
        requestedAt: iso(now - 300_000),
        requestId: "e2e-old-request",
        scriptRunning: false,
        state: "timed-out",
        updatedAt: iso(now - 60_000),
      };
    }
  };
  reset("logged-in");

  const advance = (): void => {
    if (active === null || active.finishedAt !== null) return;
    step = Math.min(step + 1, STEPS.length - 1);
    const state = STEPS[step] ?? "logged-in";
    active.state = state;
    active.updatedAt = iso(Date.now());
    active.detail = state === "logged-in" ? "account snapshot OK" : "";
    if (state === "logged-in") {
      active.finishedAt = iso(Date.now());
      active.scriptRunning = false;
      gateway = {
        loginState: "logged-in",
        needsLogin: false,
        reason: "logged-in",
        since: iso(Date.now()),
      };
    }
  };

  const status = () => ({
    cooldown: {
      seconds: 900,
      until:
        cooldownUntil !== null && cooldownUntil > Date.now()
          ? iso(cooldownUntil)
          : null,
    },
    gateway,
    generatedAt: iso(Date.now()),
    history: active === null ? [] : [active],
    request: active,
    schema: "vertex-ibkr-recovery-status-v1",
    version: "1.0.0-e2e",
  });

  // POST /request: the same gates as the real service, in the same order.
  const start = (body: Record<string, unknown>): [number, unknown] => {
    posts.push(body);
    if (body["statement"] !== STATEMENT || body["dryRun"] !== false)
      return [400, { error: "bad_request" }];
    if (active !== null && active.finishedAt === null)
      return [409, { error: "in_flight", request: active }];
    if (cooldownUntil !== null && cooldownUntil > Date.now())
      return [429, { error: "cooldown", retryAfterSeconds: 600 }];
    if (!gateway.needsLogin)
      return [409, { error: "not_needed", loginState: gateway.loginState }];
    const now = Date.now();
    cooldownUntil = now + 900_000;
    step = 0;
    active = {
      actorId: String(body["actorId"]),
      detail: "",
      finishedAt: null,
      requestedAt: iso(now),
      requestId: String(body["requestId"]),
      scriptRunning: true,
      state: "requested",
      updatedAt: iso(now),
    };
    return [
      202,
      {
        outcome: "started",
        request: active,
        schema: "vertex-ibkr-recovery-request-v1",
      },
    ];
  };

  const server = createServer(async (request, response) => {
    const send = (code: number, body: unknown): void => {
      response.writeHead(code, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (path === "/__scenario" && request.method === "POST") {
      reset(JSON.parse(await readBody(request)).scenario);
      return send(200, { ok: true });
    }
    if (path === "/__node" && request.method === "POST") {
      resetNode(JSON.parse(await readBody(request)).scenario);
      return send(200, { ok: true });
    }
    if (path === "/__calls") return send(200, { nodePosts, posts });
    if (request.headers.authorization !== `Bearer ${FAKE_IBKR_RECOVERY_TOKEN}`)
      return send(401, { error: "unauthorized" });
    if (path === `${PREFIX}/status` && request.method === "GET") {
      // Copy before advance() changes the shared request object.
      const body = structuredClone(status());
      advance();
      return send(200, body);
    }
    if (path === `${PREFIX}/nautilus/status` && request.method === "GET")
      return send(200, nodeStatus());
    if (path === `${PREFIX}/nautilus/arm` && request.method === "POST")
      return send(...nodeChange("arm", JSON.parse(await readBody(request))));
    if (path === `${PREFIX}/nautilus/disarm` && request.method === "POST")
      return send(...nodeChange("disarm", JSON.parse(await readBody(request))));
    if (path === `${PREFIX}/request` && request.method === "POST")
      return send(...start(JSON.parse(await readBody(request))));
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      server.close();
      await once(server, "close");
    },
    port,
  });
};
