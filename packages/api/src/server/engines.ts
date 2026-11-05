import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  ENGINE_STATUS_MAX_ENGINES,
  ENGINE_STATUS_STALE_SECONDS,
  type EnginesStatusOutput,
  EnginesStatusOutputSchema,
} from "../contracts/engines.ts";
import type { ApiContext } from "./context.ts";
import {
  fetchLoopbackStatus,
  type LoopbackStatusFile,
  LoopbackStatusError,
  type LoopbackStatusOptions,
  loopbackStatusUrl,
  toLoopbackStatusProcedureError,
} from "./loopback-status.ts";
import { requireOperator } from "./operator-access.ts";

// Engines view: GET /status.json from the loopback file server on the Vertex host. The rig writes
// that file through a forced-command SSH key (infra/rig/engine-status). Unit state only.

const ENGINE_STATUS_FILE: LoopbackStatusFile = {
  label: "Engine status",
  envName: "ENGINE_STATUS_URL",
  file: "status.json",
  maxBytes: 256 * 1024,
  missing: "No engine status pushed yet",
};

const epoch = z.number().int().positive().nullable();

// Collector document `vertex-engine-status-v1` (infra/rig/engine-status/collect.py).
const UpstreamSchema = z.object({
  schema: z.literal("vertex-engine-status-v1"),
  generatedAt: z.number().int().positive(),
  engines: z
    .array(
      z.object({
        unit: z.string().regex(/^[A-Za-z0-9@._-]{1,120}$/u),
        timerActive: z.boolean(),
        serviceState: z.string().max(20),
        result: z.string().max(40),
        exitStatus: z.number().int().nullable(),
        lastRunAt: epoch,
        lastExitAt: epoch,
        nextRunAt: epoch,
      })
    )
    .max(ENGINE_STATUS_MAX_ENGINES),
});

const iso = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

export const toEnginesStatus = (
  raw: unknown,
  now: Date
): EnginesStatusOutput => {
  const parsed = UpstreamSchema.safeParse(raw);
  if (!parsed.success)
    throw new LoopbackStatusError(
      "UPSTREAM_ERROR",
      "Engine status file has an unexpected shape"
    );
  const { engines, generatedAt } = parsed.data;
  return EnginesStatusOutputSchema.parse({
    generatedAt: new Date(generatedAt * 1000).toISOString(),
    stale: now.getTime() / 1000 - generatedAt > ENGINE_STATUS_STALE_SECONDS,
    engines: engines.map((engine) => ({
      ...engine,
      lastRunAt: iso(engine.lastRunAt),
      lastExitAt: iso(engine.lastExitAt),
      nextRunAt: iso(engine.nextRunAt),
    })),
  });
};

export const engineStatusUrl = (base: string | null): string =>
  loopbackStatusUrl(base, ENGINE_STATUS_FILE);

export const fetchEnginesStatus = async (
  base: string | null,
  options: LoopbackStatusOptions = {}
): Promise<EnginesStatusOutput> =>
  toEnginesStatus(
    await fetchLoopbackStatus(base, ENGINE_STATUS_FILE, options),
    (options.now ?? (() => new Date()))()
  );

let engineStatusOptions: LoopbackStatusOptions = {};
export const setEngineStatusOptionsForTesting = (
  options: LoopbackStatusOptions
): void => {
  engineStatusOptions = options;
};

const api = implement(appContract).$context<ApiContext>();

const enginesStatus = api.engines.status
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    try {
      return await fetchEnginesStatus(
        context.engineStatus ?? null,
        engineStatusOptions
      );
    } catch (error) {
      throw toLoopbackStatusProcedureError(
        error,
        errors,
        "Engine status read failed"
      );
    }
  });

export const enginesRouter = { status: enginesStatus };
