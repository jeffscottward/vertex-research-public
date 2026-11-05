import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS } from "./agent-ops.ts";

// Engines view (audit phase 5, owner choice A 2026-11-02). Rig trading-engine timers push unit
// state only to QuantVPS (infra/rig/engine-status). Read-only and operator-only: no logs, no
// account data, and nothing here can start, stop or change an engine.

export const ENGINE_STATUS_STALE_SECONDS = 180;
export const ENGINE_STATUS_MAX_ENGINES = 100;

export const ENGINES_API_ERRORS = {
  ...AGENT_OPS_API_ERRORS,
  NOT_CONFIGURED: { status: 503, message: "Engine status not configured" },
  UNAVAILABLE: { status: 503, message: "Engine status unavailable" },
  UPSTREAM_ERROR: { status: 502, message: "Engine status unreadable" },
} as const;

export const EngineStatusSchema = z
  .object({
    unit: z.string().regex(/^[A-Za-z0-9@._-]{1,120}$/u),
    timerActive: z.boolean(),
    serviceState: z.string().max(20),
    result: z.string().max(40),
    exitStatus: z.number().int().nullable(),
    lastRunAt: z.iso.datetime().nullable(),
    lastExitAt: z.iso.datetime().nullable(),
    nextRunAt: z.iso.datetime().nullable(),
  })
  .strict();
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const EnginesStatusOutputSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    // True when the rig has not pushed for ENGINE_STATUS_STALE_SECONDS: the states may be old.
    stale: z.boolean(),
    engines: z.array(EngineStatusSchema).max(ENGINE_STATUS_MAX_ENGINES),
  })
  .strict();
export type EnginesStatusOutput = z.infer<typeof EnginesStatusOutputSchema>;

const status = oc
  .errors(ENGINES_API_ERRORS)
  .route({
    method: "GET",
    path: "/engines/status",
    operationId: "engines.status",
    summary: "Read-only state of the rig trading-engine timers (no logs)",
    tags: ["Engines"],
  })
  .input(z.object({}).strict())
  .output(EnginesStatusOutputSchema);

export const enginesContract = { status };
