import { oc } from "@orpc/contract";
import { z } from "zod";

const VERTEX_LOCAL_SETUP_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid local setup request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: {
    status: 403,
    message: "Local research setup is not available for this account",
  },
  CONFLICT: {
    status: 409,
    message: "Local research setup conflicts with an existing record",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Local research setup could not be confirmed",
  },
} as const;

// No actor, grant, scope, time or privilege can be supplied by the browser.
const VertexLocalSetupInputSchema = z.object({}).strict();
export const VertexLocalSetupOutputSchema = z
  .object({
    status: z.enum(["recorded", "duplicate"]),
  })
  .strict();
export type VertexLocalSetupOutput = z.infer<
  typeof VertexLocalSetupOutputSchema
>;

export const vertexLocalSetupContract = {
  initialize: oc
    .errors(VERTEX_LOCAL_SETUP_ERRORS)
    .route({
      method: "POST",
      path: "/vertex/local-setup/initialize",
      operationId: "vertex.localSetup.initialize",
      summary: "Initialize the explicitly approved local research workspace",
      tags: ["Vertex"],
    })
    .input(VertexLocalSetupInputSchema)
    .output(VertexLocalSetupOutputSchema),
};
