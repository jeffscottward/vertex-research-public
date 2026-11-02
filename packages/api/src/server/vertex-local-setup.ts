import type { SafeAuthSession, SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  VertexStoreError,
  type VertexGrantPrivilegeRequest,
  type VertexIssueGrantInput,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "../contracts/vertex.ts";
import type { VertexLocalSetupOutput } from "../contracts/vertex-local-setup.ts";

// This schema and its parsed values are server-only. Never export through the
// client contract surface, serialize them in a response, or log parse errors.
const ApprovalPlanSchema = z
  .object({
    actorId: IdentifierSchema,
    grantId: IdentifierSchema,
    accountAlias: z.literal("vertex-research-local"),
    environment: z.literal("research"),
    validFrom: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .readonly();

type ApprovalPlan = z.infer<typeof ApprovalPlanSchema>;
export type VertexLocalSetupPlanOptions = Readonly<{
  configuration: unknown;
  environment: string;
  appUrl: string;
  authUrl: string;
}>;

const currentPlan = (plan: ApprovalPlan, now: string): boolean => {
  try {
    const at = timestampToEpochNanoseconds(now);
    return (
      timestampToEpochNanoseconds(plan.validFrom) <= at &&
      at < timestampToEpochNanoseconds(plan.expiresAt)
    );
  } catch {
    return false;
  }
};

const localOrigin = (
  options: VertexLocalSetupPlanOptions
): string | undefined => {
  try {
    if (options.environment !== "development") return undefined;
    const app = new URL(options.appUrl);
    if (
      app.origin !== options.appUrl ||
      options.authUrl !== app.origin ||
      app.protocol !== "https:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(app.hostname)
    )
      return undefined;
    return app.origin;
  } catch {
    return undefined;
  }
};

export const parseVertexLocalSetupPlan = (
  options: VertexLocalSetupPlanOptions,
  now = new Date().toISOString()
): ApprovalPlan | undefined => {
  if (
    localOrigin(options) === undefined ||
    typeof options.configuration !== "string" ||
    options.configuration.length > 4096
  )
    return undefined;
  try {
    const result = ApprovalPlanSchema.safeParse(
      JSON.parse(options.configuration)
    );
    if (!(result.success && currentPlan(result.data, now))) return undefined;
    return result.data;
  } catch {
    return undefined;
  }
};

export class VertexLocalSetupError extends Error {
  readonly code: "FORBIDDEN" | "CONFLICT" | "SERVICE_UNAVAILABLE";
  constructor(code: VertexLocalSetupError["code"]) {
    super(code);
    this.name = "VertexLocalSetupError";
    this.code = code;
  }
}

export type VertexLocalSetupService = Readonly<{
  initialize: (principal: SafePrincipal) => Promise<VertexLocalSetupOutput>;
}>;
export type VertexLocalSetupOptions = VertexLocalSetupPlanOptions &
  Readonly<{
    db: Database;
    request: Request;
    requireSession: () => Promise<SafeAuthSession>;
  }>;

// Separate request-scoped composition. The ordinary Vertex repository receives
// no privilegedAuthorization and cannot issue or revoke a grant.
export const createVertexLocalSetupService = (
  options: VertexLocalSetupOptions
): VertexLocalSetupService | undefined => {
  const clock = { now: () => new Date().toISOString() };
  const plan = parseVertexLocalSetupPlan(options, clock.now());
  const origin = localOrigin(options);
  if (plan === undefined || origin === undefined) return undefined;
  const requestAllowed = (): boolean => {
    try {
      const url = new URL(options.request.url);
      const site = options.request.headers.get("sec-fetch-site");
      return (
        !options.request.signal.aborted &&
        options.request.method === "POST" &&
        url.origin === origin &&
        url.pathname === "/api/orpc/vertex/localSetup/initialize" &&
        url.search === "" &&
        options.request.headers.get("origin") === origin &&
        (site === null || site === "same-origin") &&
        currentPlan(plan, clock.now())
      );
    } catch {
      return false;
    }
  };
  if (!requestAllowed()) return undefined;

  const authenticatedActor = async (): Promise<string> => {
    const session = await options.requireSession();
    if (
      !requestAllowed() ||
      session.principal.status !== "active" ||
      session.user.status !== "active" ||
      !session.user.emailVerified ||
      session.principal.userId !== plan.actorId ||
      session.user.id !== plan.actorId ||
      session.session.userId !== plan.actorId ||
      !Number.isFinite(session.session.expiresAt.getTime()) ||
      session.session.expiresAt.getTime() <= Date.now()
    ) {
      throw new VertexLocalSetupError("FORBIDDEN");
    }
    return session.principal.userId;
  };

  const initialize: VertexLocalSetupService["initialize"] = async (
    principal
  ) => {
    try {
      // The canonical auth principal's userId is the DB auth users.id. Vertex
      // uses actorId for that same identity; never derive it from RPC input.
      const actorId = await authenticatedActor();
      if (principal.status !== "active" || principal.userId !== actorId)
        throw new VertexLocalSetupError("FORBIDDEN");
      const input: VertexIssueGrantInput = {
        principal: { actorId },
        grantId: plan.grantId,
        granteeActorId: actorId,
        scope: {
          accountAlias: plan.accountAlias,
          environment: plan.environment,
        },
        collectionId: null,
        resourceId: "account-scope",
        actions: ["read"],
        version: "1.0.0",
        expectedVersion: null,
        validFrom: plan.validFrom,
        expiresAt: plan.expiresAt,
      };
      const authorize = async (
        request: VertexGrantPrivilegeRequest
      ): Promise<boolean> => {
        const actualActor = await authenticatedActor();
        const actualAt = clock.now();
        if (
          actualActor !== actorId ||
          !currentPlan(plan, request.now) ||
          !currentPlan(plan, actualAt) ||
          timestampToEpochNanoseconds(request.now) >
            timestampToEpochNanoseconds(actualAt)
        )
          return false;
        // Compare the entire immutable request, not just the actor or action.
        return (
          canonicalArtifactJson(request) ===
          canonicalArtifactJson({
            principal: { actorId },
            action: "issue-grant",
            binding: {
              grantId: plan.grantId,
              granteeActorId: actorId,
              scope: {
                accountAlias: plan.accountAlias,
                environment: plan.environment,
              },
              collectionId: null,
              resourceId: "account-scope",
              actions: ["read"],
            },
            version: "1.0.0",
            expectedVersion: null,
            validFrom: plan.validFrom,
            expiresAt: plan.expiresAt,
            now: request.now,
          })
        );
      };
      const authorization = createVertexAuthorization(options.db, {
        clock,
        privilegedAuthorization: { authorize },
      });
      // Existing repository locks, request hashing and version checks make an
      // exact retry duplicate-safe. No new time window or version is generated.
      const status = await authorization.issueGrant(input);
      return { status };
    } catch (error) {
      if (error instanceof VertexLocalSetupError) throw error;
      if (error instanceof VertexStoreError && error.code === "conflict")
        throw new VertexLocalSetupError("CONFLICT");
      if (error instanceof VertexStoreError && error.code === "denied")
        throw new VertexLocalSetupError("FORBIDDEN");
      throw new VertexLocalSetupError("SERVICE_UNAVAILABLE");
    }
  };
  return Object.freeze({ initialize });
};
