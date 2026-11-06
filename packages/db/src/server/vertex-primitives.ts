// What: Vertex scope, principal and record primitives shared by vertex-ports.ts and the feature ports it composes.
// Used by: vertex-ports.ts (re-export), vertex-research-chat-copy-ports.ts, vertex-research-chat-source-ports.ts.
export type VertexEnvironment = "research" | "paper" | "live";
export type VertexScope = Readonly<{
  accountAlias: string;
  environment: VertexEnvironment;
}>;
export type VertexPrincipal = Readonly<{ actorId: string }>;
export type VertexRecord = Readonly<Record<string, unknown>>;
