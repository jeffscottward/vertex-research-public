import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdentifierSchema } from "./vertex.ts";
import { VERTEX_READ_ERRORS } from "./vertex-read.ts";

export const VertexNotificationDeliveryInputSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: z.enum(["research", "paper"]),
    grantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    version: z.string().regex(/^[1-9][0-9]{0,29}$/),
    eventId: IdentifierSchema,
  })
  .strict();

const MillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(253_402_300_799_999)
  .refine((value) => !Object.is(value, -0));
const RecordedDeliverySchema = z
  .object({
    status: z.enum(["pending", "accepted", "rejected", "unknown", "not-sent"]),
    admittedAt: MillisecondsSchema,
    expiresAt: MillisecondsSchema,
    outcomeAt: MillisecondsSchema.nullable(),
    receipt: z.literal("unconfirmed"),
    retryable: z.literal(false),
  })
  .strict()
  .refine((value) => {
    return (
      value.expiresAt > value.admittedAt &&
      value.expiresAt - value.admittedAt <= 86_400_000 &&
      (value.status === "pending") === (value.outcomeAt === null) &&
      (value.outcomeAt === null || value.outcomeAt >= value.admittedAt)
    );
  });

// Provider acceptance is not proof of device display, email receipt or delivery.
// Historical absence never authorizes retry, resend or fresh admission.
export const VertexNotificationDeliveryOutputSchema = z.union([
  z
    .object({
      status: z.literal("not-found"),
      receipt: z.literal("unconfirmed"),
      retryable: z.literal(false),
    })
    .strict(),
  RecordedDeliverySchema,
]);
export type VertexNotificationDeliveryInput = z.infer<
  typeof VertexNotificationDeliveryInputSchema
>;
export type VertexNotificationDeliveryOutput = Readonly<
  z.infer<typeof VertexNotificationDeliveryOutputSchema>
>;

export const vertexNotificationReadContract = {
  delivery: oc
    .errors(VERTEX_READ_ERRORS)
    .route({
      method: "GET",
      path: "/vertex/notifications/delivery",
      operationId: "vertex.notifications.delivery",
      summary:
        "Read authorized historical notification acceptance without recipient details",
      tags: ["Vertex"],
    })
    .input(VertexNotificationDeliveryInputSchema)
    .output(VertexNotificationDeliveryOutputSchema),
};
