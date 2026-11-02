import type { Transaction } from "./client.ts";
import type {
  VertexAction,
  VertexAuthorization,
  VertexClock,
  VertexPrincipal,
  VertexScope,
} from "./vertex-ports.ts";

// Internal control persistence interface, not a new public Vertex wire contract.
// The API binds a real authenticated principal; no request-supplied actor proof.
export type VertexGrantBinding = Readonly<{
  grantId: string;
  granteeActorId: string;
  scope: VertexScope;
  collectionId: string | null;
  resourceId: string;
  actions: readonly VertexAction[];
}>;
export type VertexIssueGrantInput = VertexGrantBinding &
  Readonly<{
    principal: VertexPrincipal;
    version: string;
    expectedVersion: string | null;
    validFrom: string;
    expiresAt: string;
  }>;
export type VertexRevokeGrantInput = Readonly<{
  principal: VertexPrincipal;
  grantId: string;
  scope: VertexScope;
  collectionId: string | null;
  version: string;
  expectedVersion: string;
}>;
export type VertexGrantVersion = VertexGrantBinding &
  Readonly<{
    version: string;
    revision: string;
    status: "granted" | "revoked";
    validFrom: string;
    expiresAt: string;
    recordedAt: string;
    recordedByActorId: string;
  }>;
export type VertexGrantPrivilegeRequest = Readonly<{
  principal: VertexPrincipal;
  action: "issue-grant" | "revoke-grant";
  // Revocation resolves the full existing immutable target binding first.
  binding: VertexGrantBinding;
  version: string;
  expectedVersion: string | null;
  validFrom: string;
  expiresAt: string;
  now: string;
}>;
export type VertexAuthorizationOptions = Readonly<{
  clock: VertexClock;
  // Separate trusted privileged policy. Content grants cannot issue grants.
  // Missing, throwing or anything other than true always denies mutation.
  privilegedAuthorization?: Readonly<{
    authorize: (request: VertexGrantPrivilegeRequest) => Promise<boolean>;
  }>;
}>;
export type VertexCleanupDiscoveryCursor = Readonly<{
  accountAlias: string;
  environment: "research";
  afterGrantId: string;
}>;
export type VertexCleanupDiscoveryPage = Readonly<{
  responseRequestIds: readonly string[];
  nextCursor: VertexCleanupDiscoveryCursor | null;
}>;
export type VertexCleanupAuthority<T> = Readonly<{
  value: T;
  checkedAt: string;
  expiresAt: string;
}>;
export type VertexCleanupAuthorizationInput = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  now: string;
}>;
export type VertexAuthorizationRepository = VertexAuthorization &
  Readonly<{
    // Only current, explicitly granted read/account-scope at collectionId:null
    // lists a scope. Content access still requires its own exact grant.
    listAuthorizedScopes: (
      principal: VertexPrincipal
    ) => Promise<readonly VertexScope[]>;
    // Private transaction-local metadata authority. Caller holds authorization
    // global then Vertex scope locks; these methods never start another transaction.
    discoverCleanupFamilies: (
      tx: Transaction,
      input: VertexCleanupAuthorizationInput &
        Readonly<{ cursor: VertexCleanupDiscoveryCursor | null; limit: number }>
    ) => Promise<VertexCleanupAuthority<VertexCleanupDiscoveryPage>>;
    authorizeCleanupFamily: (
      tx: Transaction,
      input: VertexCleanupAuthorizationInput &
        Readonly<{ responseRequestId: string }>
    ) => Promise<VertexCleanupAuthority<null>>;
    issueGrant: (
      input: VertexIssueGrantInput
    ) => Promise<"recorded" | "duplicate">;
    revokeGrant: (
      input: VertexRevokeGrantInput
    ) => Promise<"recorded" | "duplicate">;
  }>;
