import { deepFreezeArtifact } from "@darkfactory/shared/vertex";
import { z } from "zod";
import { TimestampSchema } from "./vertex.ts";
import {
  PortfolioSnapshotSchema,
  ProjectionContinuitySchema,
} from "./vertex-control.ts";

// Experience (oRPC) read shapes for the portfolio and continuity routes.
// vertex-control.ts is a frozen native-bundle source, so the additive status
// fields the web reads live here. Each schema accepts every value the frozen
// VertexPortfolioReadSchema / VertexContinuityReadSchema accepts, plus:
// - checkedAt: when the server found the unavailable state (older servers omit it);
// - state "not-yet-received": set with reason not-found only when the store
//   proves it: a stream is registered and no snapshot is stored yet
//   (portfolio), or no head exists for the stream (continuity).
const checkedAt = TimestampSchema.optional();
const notYetReceived = z.literal("not-yet-received").optional();

export const VertexPortfolioStatusReadSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        snapshot: PortfolioSnapshotSchema,
        status: z.literal("available"),
      })
      .strict(),
    z
      .object({
        checkedAt,
        executionAuthorized: z.literal(false),
        reason: z.enum([
          "capability-disabled",
          "source-unavailable",
          "not-configured",
          "not-found",
        ]),
        state: notYetReceived,
        status: z.literal("unavailable"),
      })
      .strict(),
  ])
  .readonly()
  .transform(deepFreezeArtifact);
export const VertexContinuityStatusReadSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        continuity: ProjectionContinuitySchema,
        status: z.literal("available"),
      })
      .strict(),
    z
      .object({
        checkedAt,
        executionAuthorized: z.literal(false),
        reason: z.enum([
          "capability-disabled",
          "source-unavailable",
          "not-found",
        ]),
        state: notYetReceived,
        status: z.literal("unavailable"),
      })
      .strict(),
  ])
  .readonly()
  .transform(deepFreezeArtifact);

export type VertexPortfolioStatusRead = z.infer<
  typeof VertexPortfolioStatusReadSchema
>;
export type VertexContinuityStatusRead = z.infer<
  typeof VertexContinuityStatusReadSchema
>;
