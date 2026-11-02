import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import { validateVertexCommand } from "./vertex-command-input.ts";
import {
  array,
  digestString,
  fail,
  identifier,
  object,
  one,
  type PersistenceContext,
  rows,
  scopeWhere,
  string,
} from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";

// Internal read-only owner. Caller owns the existing scoped transaction/lock;
// no worker credential, lease issuance, expiry transition or nested transaction.
export const readResearchProposalForTransaction = async (
  ctx: PersistenceContext,
  tx: Transaction,
  principal: VertexPrincipal,
  scope: VertexScope,
  artifactId: string,
  at: string
) => {
  identifier(artifactId);
  const found = await one(
    tx,
    "vertex_research_proposals",
    scope,
    sql`artifact_id = ${artifactId} and actor_id = ${identifier(principal.actorId)}`
  );
  if (!found) return null;
  const collection = identifier(found["collection_id"]);
  const metadata = await ctx.artifact(
    tx,
    principal,
    scope,
    collection,
    artifactId,
    "read",
    at
  );
  if (metadata?.contractName !== "AgentRun") return fail("denied");
  const record = await one(
    tx,
    "vertex_records",
    scope,
    sql`artifact_id = ${artifactId} and collection_key = ${collection} and contract_name = 'AgentRun'`
  );
  if (
    !record ||
    record["record_hash"] !== metadata.artifactSha256 ||
    (await ctx.hash(record["payload"])) !== metadata.artifactSha256
  )
    return fail("integrity");
  const proposal = object(found["payload"]);
  if (
    (await ctx.hash(proposal)) !== found["proposal_hash"] ||
    proposal["question"] !== found["question"] ||
    proposal["role"] !== found["role"] ||
    proposal["proposalOnly"] !== true ||
    proposal["executionAuthorized"] !== false ||
    typeof proposal["question"] !== "string" ||
    proposal["question"].length < 1 ||
    proposal["question"].length > 2000
  )
    return fail("integrity");
  const run = await ctx.validate("AgentRun", record["payload"]);
  if (
    run["status"] !== "queued" ||
    run["agentRole"] !== proposal["role"] ||
    (await ctx.hash(run["inputEvidenceIds"])) !==
      (await ctx.hash(proposal["evidenceIds"]))
  )
    return fail("integrity");
  let original: Readonly<{
    requestHash: string;
    command: VertexRecord;
    policy: VertexRecord;
    committedAt: string;
  }> | null = null;
  if (
    string(run["runId"]).startsWith("backtest-request-") ||
    Object.hasOwn(proposal, "backtestExpectation")
  ) {
    // Recover the ORIGINAL typed command, not just a self-consistent proposal.
    const receipts = await rows(
      tx,
      sql`select * from vertex_command_receipts where ${scopeWhere(scope)} and actor_id = ${principal.actorId} and kind = 'research' and target_artifact_id = ${artifactId} limit 2`
    );
    if (receipts.length !== 1) return fail("integrity");
    const receipt = requirePresent(receipts[0], "receipts[0]");
    const stored = object(receipt["command"]);
    const command = object(stored["command"]);
    const policy = object(stored["commandPolicy"]);
    const requestHash = digestString(receipt["request_hash"]);
    await validateVertexCommand(ctx, principal, scope, {
      kind: "research",
      command,
      requestHash,
      idempotencyKey: identifier(receipt["idempotency_key"]),
    });
    const expected = object(command["backtestExpectation"]);
    const selected = object(expected["policy"]);
    const result = { artifactId, sha256: metadata.artifactSha256, value: run };
    const originalProposal = {
      question: command["question"],
      evidenceIds: command["evidenceIds"],
      role: command["role"],
      proposalOnly: true,
      executionAuthorized: false,
      backtestExpectation: expected,
    };
    if (
      Object.keys(stored).length !== 2 ||
      receipt["collection_key"] !== collection ||
      command["collectionId"] !== collection ||
      artifactId !== `agent-${requestHash}` ||
      run["runId"] !== `backtest-request-${requestHash}` ||
      run["taskContract"] !== expected["taskContract"] ||
      selected["selectionId"] !== policy["selectionId"] ||
      selected["selectionSha256"] !== policy["selectionSha256"] ||
      selected["selectionRevision"] !== policy["selectionRevision"] ||
      (await ctx.hash(originalProposal)) !== found["proposal_hash"] ||
      (await ctx.hash(receipt["result"])) !== (await ctx.hash(result)) ||
      (await ctx.hash({ result, commandPolicy: policy })) !==
        receipt["result_hash"]
    )
      return fail("integrity");
    original = {
      requestHash,
      command,
      policy,
      committedAt: string(receipt["committed_at"]),
    };
  }
  const evidenceIds = array(proposal["evidenceIds"], 32).map(identifier);
  const links = await rows(
    tx,
    sql`select * from vertex_research_proposal_evidence where ${scopeWhere(scope)} and artifact_id = ${artifactId} order by ordinal limit 33`
  );
  if (links.length !== evidenceIds.length) return fail("integrity");
  for (const [index, link] of links.entries()) {
    if (link["evidence_id"] !== evidenceIds[index]) return fail("integrity");
    const evidence = await ctx.artifact(
      tx,
      principal,
      scope,
      collection,
      identifier(link["evidence_artifact_id"]),
      "read",
      ctx.now()
    );
    if (!evidence || evidence.artifactSha256 !== link["evidence_sha256"])
      return fail("denied");
  }
  await ctx.authorize(
    principal,
    scope,
    collection,
    artifactId,
    "read",
    ctx.now()
  );
  return { metadata, run, proposal: structuredClone(proposal), original };
};
