import { decimalUnits } from "@darkfactory/shared/vertex";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  array,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  rows,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import type {
  ResearchChatSourceInputPort,
  ResearchChatSourceInputs,
  ResearchChatSourceRequest,
} from "./vertex-research-chat-source-ports.ts";

// Concrete-source ports return original data, never an accepted/authorized flag.
// The API composition supplies its existing governed output owner. No public
// constructor accepts these ports from a request or worker recipe.
export type ResearchChatDebateSourceOptions = Readonly<{
  configuration: VertexRecord;
  reviewerActorId: string;
  validate: (
    name: "configuration" | "step" | "plan" | "reviewInput",
    raw: unknown
  ) => VertexRecord;
  readSelectedArtifact: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    pin: VertexRecord
  ) => Promise<Uint8Array>;
  readPublished: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    pin: VertexRecord,
    at: string
  ) => Promise<Readonly<{ pin: VertexRecord; expiresAt: string }>>;
  sourceInputs: ResearchChatSourceInputPort;
}>;
const runTable = "vertex_research_chat_debate_runs";
const stepTable = "vertex_research_chat_debate_steps";
const reviewTable = "vertex_research_chat_derived_dependencies";
const minimum = (...values: string[]): string =>
  values.reduce((a, b) => (time(a) <= time(b) ? a : b));

export const createResearchChatDebateOperations = (
  ctx: PersistenceContext,
  options: ResearchChatDebateSourceOptions
) => {
  const configurationPin = ctx.capture(options.configuration),
    reviewerActorId = identifier(options.reviewerActorId);
  const same = async (a: unknown, b: unknown): Promise<boolean> =>
    (await ctx.hash(a)) === (await ctx.hash(b));
  const current = (at: string, ...ends: string[]): void => {
    const now = time(ctx.now());
    if (now < time(at) || ends.some((end) => now >= time(end))) fail("stale");
  };
  const save = async (
    tx: Transaction,
    table: string,
    scope: VertexScope,
    value: VertexRecord,
    columns: VertexRecord
  ): Promise<void> => {
    await insert(tx, table, scope, {
      ...columns,
      record_hash: await ctx.hash(value),
      payload: value,
    });
  };
  const grant = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    resource: string,
    action: "read" | "publish" | "review",
    at: string,
    expected?: VertexRecord
  ): Promise<VertexRecord> => {
    await ctx.authorize(principal, scope, collection, resource, action, at);
    const found = await rows(
      tx,
      sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${principal.actorId} and b.collection_key = ${collection ?? ""} and b.resource_id = ${resource} limit 129`
    );
    if (found.length > 128) return fail("denied");
    for (const row of found) {
      const value = object(row["payload"]);
      if (
        (await ctx.hash(value)) !== row["record_hash"] ||
        value["version"] !== row["current_version"] ||
        value["revision"] !== row["revision"] ||
        value["granteeActorId"] !== principal.actorId ||
        value["collectionId"] !== collection ||
        value["resourceId"] !== resource ||
        !(await same(value["scope"], scope))
      )
        return fail("integrity");
      if (
        value["status"] !== "granted" ||
        !array(value["actions"], 8).includes(action) ||
        time(value["recordedAt"]) > time(at) ||
        time(value["validFrom"]) > time(at)
      )
        continue;
      const pin = {
        grantId: value["grantId"],
        version: value["version"],
        revision: value["revision"],
        recordSha256: row["record_hash"],
        expiresAt: value["expiresAt"],
      };
      if (expected && !(await same(pin, expected))) continue;
      // A fresh selection may choose a different live grant. An already pinned
      // review must instead fail on exact-grant expiry, never silently rebind.
      if (!expected && time(ctx.now()) >= time(value["expiresAt"])) continue;
      current(at, string(value["expiresAt"]));
      return pin;
    }
    return fail("denied");
  };
  const reviewResource = (responseRequestId: string): string =>
    `research-chat-derived-review:${identifier(responseRequestId)}`;
  const useResource = async (
    plan: VertexRecord,
    pin: VertexRecord
  ): Promise<string> =>
    `research-chat-derived-use:${await ctx.hash({ responseRequestId: plan["responseRequestId"], debateRunId: object(plan["debate"])["debateRunId"], predecessor: pin })}`;
  const readRun = async (
    tx: Transaction,
    scope: VertexScope,
    debateRunId: string
  ): Promise<VertexRecord | null> => {
    const row = await one(
      tx,
      runTable,
      scope,
      sql`debate_run_id = ${debateRunId}`
    );
    if (!row) return null;
    const value = object(row["payload"]);
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      value["profile"] !== "vertex-research-chat-debate-run-v1" ||
      value["debateRunId"] !== debateRunId ||
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment
    )
      return fail("integrity");
    for (const [column, key] of Object.entries({
      owner_actor_id: "ownerActorId",
      thread_id: "threadId",
      run_key: "runKey",
      configuration_sha256: "configurationSha256",
      human_window_sha256: "humanWindowSha256",
      collection_id: "collectionId",
      snapshot_id: "snapshotId",
    }))
      if (row[column] !== value[key]) return fail("integrity");
    return value;
  };
  const charges = async (
    tx: Transaction,
    scope: VertexScope,
    run: VertexRecord
  ): Promise<VertexRecord[]> => {
    const found = await rows(
      tx,
      sql`select * from vertex_research_chat_debate_steps where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and debate_run_id = ${run["debateRunId"]} order by ordinal asc limit 6`
    );
    if (found.length > 5) return fail("integrity");
    let tokens = 0n,
      usd = 0n;
    const result: VertexRecord[] = [];
    for (let i = 0; i < found.length; i++) {
      const row = requirePresent(found[i], "found[i]"),
        value = object(row["payload"]);
      if (
        (await ctx.hash(value)) !== row["record_hash"] ||
        value["profile"] !== "vertex-research-chat-debate-charge-v1" ||
        value["debateRunId"] !== run["debateRunId"] ||
        value["ordinal"] !== i + 1 ||
        Number(row["ordinal"]) !== i + 1 ||
        value["accountAlias"] !== scope.accountAlias ||
        value["environment"] !== scope.environment ||
        value["state"] !== row["state"] ||
        !["reserved", "spent"].includes(string(value["state"]))
      )
        return fail("integrity");
      for (const [column, key] of Object.entries({
        response_request_id: "responseRequestId",
        plan_id: "planId",
        plan_sha256: "planSha256",
        charged_tokens: "chargedTokens",
        charged_usd_units: "chargedUsdUnits",
      }))
        if (String(row[column]) !== String(value[key]))
          return fail("integrity");
      if (
        value["chargedTokens"] !== String(run["turnTokens"]) ||
        value["chargedUsdUnits"] !==
          decimalUnits(string(run["turnCostUsd"])).toString()
      )
        return fail("integrity");
      tokens += BigInt(string(value["chargedTokens"]));
      usd += BigInt(string(value["chargedUsdUnits"]));
      result.push(value);
    }
    if (
      tokens > BigInt(String(run["aggregateTokens"])) ||
      usd > decimalUnits(string(run["aggregateCostUsd"]))
    )
      return fail("denied");
    return result;
  };
  const planRow = async (
    tx: Transaction,
    scope: VertexScope,
    responseRequestId: string
  ): Promise<VertexRecord> => {
    const row = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return fail("denied");
    const plan = options.validate("plan", ctx.capture(row["payload"])),
      { planId, planSha256, ...body } = plan;
    if (
      plan["format"] !== "vertex-research-chat-plan-v2" ||
      (await ctx.hash(plan)) !== row["record_hash"] ||
      (await ctx.hash(body)) !== planSha256 ||
      planId !== `chat-plan-${planSha256}` ||
      row["plan_id"] !== planId ||
      row["plan_sha256"] !== planSha256 ||
      row["owner_actor_id"] !== plan["ownerActorId"] ||
      plan["responseRequestId"] !== responseRequestId ||
      plan["accountAlias"] !== scope.accountAlias ||
      plan["environment"] !== scope.environment
    )
      return fail("integrity");
    return plan;
  };
  // First verify every backwards edge using immutable rows BEFORE calling the
  // recursive existing output owner. This bounds traversal and excludes cycles,
  // future-output preapproval, cross-run, cross-owner and cross-corpus reuse.
  const prepareSourceInputs = async (
    principal: VertexPrincipal,
    command: VertexRecord,
    purpose: string,
    planSha256: string | null
  ): Promise<ResearchChatSourceInputs> => {
    if (command["environment"] !== "research") return fail("denied");
    const scope = {
      accountAlias: identifier(command["accountAlias"]),
      environment: "research" as const,
    };
    const request: ResearchChatSourceRequest = {
      scope,
      ownerActorId: principal.actorId,
      requesterActorId: principal.actorId,
      threadId: identifier(command["threadId"]),
      responseRequestId: `response-${await ctx.hash({ operation: "requestResponse", actorId: principal.actorId, scope, threadId: command["threadId"], idempotencyKey: command["idempotencyKey"] })}`,
      requestSha256: await ctx.hash({
        operation: "requestResponse",
        actorId: principal.actorId,
        input: command,
      }),
      planSha256,
      planExpiresAt: null,
      purpose,
      predecessors: array(object(command["debate"])["predecessors"], 4).map(
        object
      ),
    };
    return {
      request,
      token: await options.sourceInputs.prepareSourceInputs(request),
    };
  };
  const disposeSourceInputs = (inputs: ResearchChatSourceInputs): void => {
    options.sourceInputs.disposeSourceInputs(inputs.token);
  };
  const recheckSourceInputsForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    plan: VertexRecord,
    inputs: ResearchChatSourceInputs | undefined,
    at: string,
    includeBytes = false
  ) => {
    if (!inputs || plan["ownerActorId"] !== principal.actorId)
      return fail("denied");
    const expected: ResearchChatSourceRequest = {
      ...inputs.request,
      scope: {
        accountAlias: identifier(plan["accountAlias"]),
        environment: "research",
      },
      ownerActorId: principal.actorId,
      requesterActorId: principal.actorId,
      threadId: identifier(plan["threadId"]),
      responseRequestId: identifier(plan["responseRequestId"]),
      requestSha256: string(plan["requestSha256"]),
      planSha256:
        inputs.request.planSha256 === null ? null : string(plan["planSha256"]),
      predecessors: array(object(plan["debate"])["predecessors"], 4).map(
        object
      ),
    };
    if (!(await same(expected, inputs.request))) return fail("denied");
    return options.sourceInputs.recheckSourceInputsForTransaction(
      tx,
      expected,
      inputs.token,
      at,
      includeBytes
    );
  };
  const sources = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    plan: VertexRecord,
    at: string,
    expectedGrants?: readonly VertexRecord[]
  ) => {
    const debate = object(plan["debate"]),
      pins = array(debate["predecessors"], 4).map(object);
    const run = await readRun(tx, scope, identifier(debate["debateRunId"]));
    if (
      !run ||
      run["ownerActorId"] !== principal.actorId ||
      plan["ownerActorId"] !== principal.actorId ||
      run["threadId"] !== plan["threadId"] ||
      run["collectionId"] !== plan["collectionId"] ||
      run["snapshotId"] !== plan["snapshotId"] ||
      run["humanWindowSha256"] !== debate["humanWindowSha256"] ||
      !(await same(run["configuration"], debate["configuration"]))
    )
      return fail("denied");
    for (const key of [
      "runKey",
      "participantIds",
      "synthesizerId",
      "turnTokens",
      "turnCostUsd",
      "aggregateTokens",
      "aggregateCostUsd",
    ] as const)
      if (!(await same(run[key], debate[key]))) return fail("integrity");
    if (!(await same(run["reviewPins"], plan["reviewPins"])))
      return fail("denied");
    if (expectedGrants && expectedGrants.length !== pins.length)
      return fail("integrity");
    const existing = await charges(tx, scope, run);
    if (
      pins.length !== Number(debate["ordinal"]) - 1 ||
      pins.length > existing.length
    )
      return fail("denied");
    const checked: {
        pin: VertexRecord;
        expiresAt: string;
        bytes?: Uint8Array;
      }[] = [],
      grants: VertexRecord[] = [];
    try {
      for (let i = 0; i < pins.length; i++) {
        const pin = requirePresent(pins[i], "pins[i]"),
          charge = requirePresent(existing[i], "existing[i]");
        if (
          pin["ordinal"] !== i + 1 ||
          charge["responseRequestId"] !== pin["responseRequestId"] ||
          charge["planId"] !== pin["planId"] ||
          charge["planSha256"] !== pin["planSha256"] ||
          pin["responseRequestId"] === plan["responseRequestId"]
        )
          return fail("denied");
        const original = await planRow(
            tx,
            scope,
            identifier(pin["responseRequestId"])
          ),
          prior = object(original["debate"]);
        if (
          original["ownerActorId"] !== principal.actorId ||
          original["threadId"] !== plan["threadId"] ||
          original["collectionId"] !== plan["collectionId"] ||
          original["snapshotId"] !== plan["snapshotId"] ||
          !(await same(original["reviewPins"], plan["reviewPins"])) ||
          original["participantId"] !== pin["participantId"] ||
          original["runId"] !== pin["runId"] ||
          prior["debateRunId"] !== debate["debateRunId"] ||
          prior["ordinal"] !== i + 1 ||
          prior["humanWindowSha256"] !== debate["humanWindowSha256"]
        )
          return fail("denied");
        for (const key of [
          "configuration",
          "runKey",
          "participantIds",
          "synthesizerId",
          "turnTokens",
          "turnCostUsd",
          "aggregateTokens",
          "aggregateCostUsd",
        ] as const)
          if (!(await same(prior[key], debate[key]))) return fail("integrity");
        if (!(await same(prior["predecessors"], pins.slice(0, i))))
          return fail("integrity");
        const read = await grant(
          tx,
          principal,
          scope,
          identifier(plan["collectionId"]),
          identifier(pin["copyId"]),
          "read",
          ctx.now(),
          expectedGrants
            ? (object(requirePresent(expectedGrants[i], "expectedGrants[i]"))[
                "read"
              ] as VertexRecord)
            : undefined
        );
        const source = await options.readPublished(
          tx,
          principal,
          scope,
          pin,
          ctx.now()
        );
        checked.push(source);
        if (!(await same(source.pin, pin))) return fail("integrity");
        grants.push({ read });
        current(at, source.expiresAt, string(read["expiresAt"]));
      }
      return {
        run,
        existing,
        sources: checked,
        grants,
        expiresAt: minimum(
          string(run["expiresAt"]),
          ...checked.map((s) => s.expiresAt),
          ...grants.map((g) => string(object(g["read"])["expiresAt"]))
        ),
      };
    } catch (error) {
      for (const value of checked) value.bytes?.fill(0);
      throw error;
    }
  };
  const prepareForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    input: Readonly<{
      request: VertexRecord;
      responseRequestId: string;
      configuration: VertexRecord;
      messages: readonly VertexRecord[];
      selection: VertexRecord;
      sourceInputs?: ResearchChatSourceInputs;
    }>,
    at: string
  ) => {
    const request = input.request,
      step = options.validate("step", request["debate"]);
    if (scope.environment !== "research") return fail("denied");
    if (
      configurationPin["contractName"] !== "ResearchChatDebateConfiguration" ||
      configurationPin["schemaVersion"] !== "1.0.0"
    )
      return fail("invalid");
    const selected = array(input.selection["artifacts"], 512)
      .map(object)
      .filter((entry) => entry["role"] === "tool-config");
    if (
      (
        await Promise.all(
          selected.map((entry) => same(entry["artifact"], configurationPin))
        )
      ).filter(Boolean).length !== 1
    )
      return fail("denied");
    const bytes = await options.readSelectedArtifact(
      tx,
      principal,
      scope,
      configurationPin
    );
    let config: VertexRecord;
    try {
      if ((await ctx.digest(bytes)) !== configurationPin["artifactSha256"])
        return fail("integrity");
      config = options.validate(
        "configuration",
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      );
      if ((await ctx.hash(config)) !== configurationPin["artifactSha256"])
        return fail("integrity");
    } finally {
      bytes.fill(0);
    }
    const participants = array(config["participantIds"], 2),
      ordinal = Number(step["ordinal"]);
    if (
      config["accountAlias"] !== scope.accountAlias ||
      config["environment"] !== scope.environment ||
      participants.length !== 2 ||
      request["participantId"] !==
        (ordinal === 5
          ? config["synthesizerId"]
          : participants[(ordinal - 1) % 2])
    )
      return fail("denied");
    const budget = object(input.configuration["budgets"]);
    if (
      BigInt(String(budget["requestTokens"])) >
        BigInt(String(config["turnTokens"])) ||
      decimalUnits(string(budget["requestCostUsd"])) >
        decimalUnits(string(config["turnCostUsd"])) ||
      decimalUnits(string(budget["tokenizeCostUsd"])) +
        decimalUnits(string(budget["completionCostUsd"])) >
        decimalUnits(string(config["turnCostUsd"]))
    )
      return fail("denied");
    const humanMessages = await Promise.all(
      input.messages.map(async (message) => {
        const author = object(message["author"]);
        if (
          author["kind"] !== "user" ||
          author["actorId"] !== principal.actorId
        )
          return fail("denied");
        return {
          message_id: message["messageId"],
          sequence: message["sequence"],
          record_sha256: await ctx.hash(message),
          author: { kind: "user", actor_id: author["actorId"] },
          body: message["body"],
        };
      })
    );
    const humanWindowSha256 = await ctx.hash({
      threadId: request["threadId"],
      parentMessageId: request["parentMessageId"],
      snapshotRevision: request["snapshotRevision"],
      contextStartSequence: request["contextStartSequence"],
      messages: humanMessages,
    });
    const debateRunId = `debate-${await ctx.hash({ scope, ownerActorId: principal.actorId, threadId: request["threadId"], runKey: step["runKey"] })}`;
    const body = {
      profile: "vertex-research-chat-debate-run-v1",
      ...scope,
      debateRunId,
      ownerActorId: principal.actorId,
      threadId: request["threadId"],
      runKey: step["runKey"],
      configuration: configurationPin,
      configurationSha256: configurationPin["artifactSha256"],
      humanWindowSha256,
      collectionId: input.configuration["collectionId"],
      snapshotId: input.configuration["snapshotId"],
      reviewPins: input.configuration["reviewPins"],
      participantIds: config["participantIds"],
      synthesizerId: config["synthesizerId"],
      turnTokens: config["turnTokens"],
      turnCostUsd: config["turnCostUsd"],
      aggregateTokens: config["aggregateTokens"],
      aggregateCostUsd: config["aggregateCostUsd"],
      expiresAt: config["expiresAt"],
    };
    let run = await readRun(tx, scope, debateRunId);
    if (!run) {
      if (ordinal !== 1) return fail("denied");
      await save(tx, runTable, scope, body, {
        debate_run_id: debateRunId,
        owner_actor_id: principal.actorId,
        thread_id: request["threadId"],
        run_key: step["runKey"],
        configuration_sha256: configurationPin["artifactSha256"],
        human_window_sha256: humanWindowSha256,
        collection_id: body.collectionId,
        snapshot_id: body.snapshotId,
      });
      run = body;
    } else if (!(await same(run, body))) return fail("conflict");
    current(at, string(run["expiresAt"]));
    const debate = {
      profile: "vertex-research-chat-debate-plan-v1",
      debateRunId,
      runKey: step["runKey"],
      ordinal,
      kind: ordinal === 5 ? "synthesis" : "statement",
      configuration: configurationPin,
      participantIds: config["participantIds"],
      synthesizerId: config["synthesizerId"],
      humanWindowSha256,
      predecessors: step["predecessors"],
      turnTokens: config["turnTokens"],
      turnCostUsd: config["turnCostUsd"],
      aggregateTokens: config["aggregateTokens"],
      aggregateCostUsd: config["aggregateCostUsd"],
    };
    const draft = {
      ...request,
      ownerActorId: principal.actorId,
      responseRequestId: input.responseRequestId,
      collectionId: body.collectionId,
      snapshotId: body.snapshotId,
      reviewPins: body.reviewPins,
      debate,
      requestSha256: await ctx.hash({
        operation: "requestResponse",
        actorId: principal.actorId,
        input: request,
      }),
      planSha256: input.sourceInputs?.request.planSha256,
    };
    const joined = await sources(tx, principal, scope, draft, at);
    if (
      (joined.existing.length >= ordinal &&
        requirePresent(
          joined.existing[ordinal - 1],
          "joined.existing[ordinal - 1]"
        )["responseRequestId"] !== input.responseRequestId) ||
      joined.existing.length < ordinal - 1
    )
      return fail("conflict");
    const prepared = await recheckSourceInputsForTransaction(
      tx,
      principal,
      draft,
      input.sourceInputs,
      ctx.now(),
      true
    );
    if (
      !(await same(
        prepared.sources.map((source) => source.pin),
        joined.sources.map((source) => source.pin)
      ))
    ) {
      for (const source of prepared.sources) source.bytes?.fill(0);
      return fail("integrity");
    }
    return {
      debate,
      sources: prepared.sources,
      expiresAt: minimum(string(config["expiresAt"]), joined.expiresAt),
      useExpiresAt: prepared.expiresAt,
    };
  };
  const reviews = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord
  ): Promise<VertexRecord[]> => {
    const found = await rows(
      tx,
      sql`select * from vertex_research_chat_derived_dependencies where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and response_request_id = ${plan["responseRequestId"]} order by revision asc limit 65`
    );
    if (found.length > 64) return fail("integrity");
    const result: VertexRecord[] = [];
    for (let i = 0; i < found.length; i++) {
      const row = requirePresent(found[i], "found[i]"),
        value = object(row["payload"]);
      if (
        (await ctx.hash(value)) !== row["record_hash"] ||
        value["profile"] !== "vertex-research-chat-derived-use-review-v1" ||
        value["accountAlias"] !== scope.accountAlias ||
        value["environment"] !== scope.environment ||
        value["responseRequestId"] !== plan["responseRequestId"] ||
        value["planId"] !== plan["planId"] ||
        value["planSha256"] !== plan["planSha256"] ||
        value["ownerActorId"] !== plan["ownerActorId"] ||
        value["reviewerActorId"] !== reviewerActorId ||
        value["reviewerActorId"] === value["ownerActorId"] ||
        value["revision"] !== i + 1 ||
        Number(row["revision"]) !== i + 1 ||
        value["supersedesReviewId"] !== (result[i - 1]?.["reviewId"] ?? null) ||
        !(await same(value["debate"], plan["debate"]))
      )
        return fail("integrity");
      for (const [column, key] of Object.entries({
        review_id: "reviewId",
        plan_id: "planId",
        plan_sha256: "planSha256",
        reviewer_actor_id: "reviewerActorId",
        owner_actor_id: "ownerActorId",
        idempotency_key: "idempotencyKey",
        decision: "decision",
      }))
        if (row[column] !== value[key]) return fail("integrity");
      if (
        !["accepted", "rejected"].includes(string(value["decision"])) ||
        time(value["reviewedAt"]) >= time(value["expiresAt"]) ||
        (i > 0 &&
          time(value["reviewedAt"]) <
            time(requirePresent(result[i - 1], "result[i - 1]")["reviewedAt"]))
      )
        return fail("integrity");
      result.push(value);
    }
    return result;
  };
  const currentForTransaction = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    at: string
  ): Promise<string> => {
    const owner = { actorId: identifier(plan["ownerActorId"]) },
      debate = object(plan["debate"]);
    if (!(await same(debate["configuration"], configurationPin)))
      return fail("denied");
    const configBytes = await options.readSelectedArtifact(
      tx,
      owner,
      scope,
      configurationPin
    );
    try {
      if (
        (await ctx.digest(configBytes)) !== configurationPin["artifactSha256"]
      )
        return fail("integrity");
    } finally {
      configBytes.fill(0);
    }
    const history = await reviews(tx, scope, plan),
      review = history.at(-1);
    if (review?.["decision"] !== "accepted") return fail("denied");
    const joined = await sources(
      tx,
      owner,
      scope,
      plan,
      at,
      array(review["sourceGrants"], 4).map(object)
    );
    const reviewer = { actorId: reviewerActorId };
    const authority = await grant(
      tx,
      reviewer,
      scope,
      null,
      reviewResource(identifier(plan["responseRequestId"])),
      "review",
      ctx.now(),
      object(review["reviewerGrant"])
    );
    const uses = array(review["useGrants"], 4).map(object);
    if (uses.length !== Number(debate["ordinal"]) - 1) return fail("integrity");
    const bounds = [
      joined.expiresAt,
      string(authority["expiresAt"]),
      string(review["expiresAt"]),
      string(plan["expiresAt"]),
    ];
    for (let i = 0; i < uses.length; i++) {
      const pin = object(array(debate["predecessors"], 4)[i]);
      const accepted = await grant(
        tx,
        owner,
        scope,
        null,
        await useResource(plan, pin),
        "publish",
        ctx.now(),
        uses[i]
      );
      bounds.push(string(accepted["expiresAt"]));
    }
    const end = minimum(...bounds);
    current(at, end);
    return end;
  };
  const recordResearchChatDerivedUseReview = async (
    principal: VertexPrincipal,
    raw: unknown
  ): Promise<VertexRecord> => {
    const input = options.validate("reviewInput", ctx.capture(raw)),
      scope: VertexScope = {
        accountAlias: identifier(input["accountAlias"]),
        environment: "research",
      };
    if (
      input["environment"] !== "research" ||
      principal.actorId !== reviewerActorId
    )
      return fail("denied");
    return await ctx.run(
      principal,
      scope,
      null,
      reviewResource(identifier(input["responseRequestId"])),
      "review",
      async (tx, at) => {
        const plan = await planRow(
            tx,
            scope,
            identifier(input["responseRequestId"])
          ),
          owner = { actorId: identifier(plan["ownerActorId"]) };
        if (
          plan["ownerActorId"] === principal.actorId ||
          plan["planId"] !== input["planId"] ||
          plan["planSha256"] !== input["planSha256"]
        )
          return fail("denied");
        const commandSha256 = await ctx.hash({ principal, input }),
          history = await reviews(tx, scope, plan);
        const previous = history.at(-1),
          replay = history.find(
            (r) => r["idempotencyKey"] === input["idempotencyKey"]
          );
        // Historical idempotency ACK only: every dependent use independently
        // requires the latest accepted revision and its exact live grant pins.
        if (replay) {
          if (replay["commandSha256"] !== commandSha256)
            return fail("conflict");
          return replay;
        }
        if (
          (previous?.["reviewId"] ?? null) !== input["expectedReviewId"] ||
          history.length >= 64
        )
          return fail("conflict");
        const reviewerGrant = await grant(
          tx,
          principal,
          scope,
          null,
          reviewResource(identifier(plan["responseRequestId"])),
          "review",
          ctx.now()
        );
        // Rejection/revocation remains possible after sources close. It grants no
        // dependent use and never demands revived source authority to revoke it.
        let sourceGrants: VertexRecord[] = [],
          useGrants: VertexRecord[] = [];
        const bounds = [
          string(plan["expiresAt"]),
          string(reviewerGrant["expiresAt"]),
        ];
        if (input["decision"] === "accepted") {
          const joined = await sources(tx, owner, scope, plan, at);
          sourceGrants = joined.grants;
          bounds.push(joined.expiresAt);
          for (const pin of array(
            object(plan["debate"])["predecessors"],
            4
          ).map(object)) {
            // Metadata review is independent; reviewer does not receive source bytes.
            await ctx.authorize(
              principal,
              scope,
              identifier(plan["collectionId"]),
              identifier(pin["copyId"]),
              "read",
              ctx.now()
            );
            const use = await grant(
              tx,
              owner,
              scope,
              null,
              await useResource(plan, pin),
              "publish",
              ctx.now()
            );
            useGrants.push(use);
            bounds.push(string(use["expiresAt"]));
          }
        }
        if (
          input["decision"] === "accepted" &&
          time(input["expiresAt"]) > time(minimum(...bounds))
        )
          return fail("stale");
        current(
          at,
          string(input["expiresAt"]),
          string(reviewerGrant["expiresAt"])
        );
        const value = {
          profile: "vertex-research-chat-derived-use-review-v1",
          ...scope,
          responseRequestId: plan["responseRequestId"],
          planId: plan["planId"],
          planSha256: plan["planSha256"],
          ownerActorId: plan["ownerActorId"],
          reviewerActorId,
          reviewerGrant,
          reviewId: `derived-review-${commandSha256}`,
          revision: history.length + 1,
          commandSha256,
          idempotencyKey: input["idempotencyKey"],
          decision: input["decision"],
          supersedesReviewId: input["expectedReviewId"],
          debate: plan["debate"],
          sourceGrants,
          useGrants,
          reviewedAt: at,
          expiresAt: input["expiresAt"],
        };
        await save(tx, reviewTable, scope, value, {
          response_request_id: plan["responseRequestId"],
          review_id: value.reviewId,
          plan_id: plan["planId"],
          plan_sha256: plan["planSha256"],
          revision: value.revision,
          reviewer_actor_id: reviewerActorId,
          owner_actor_id: plan["ownerActorId"],
          idempotency_key: input["idempotencyKey"],
          decision: input["decision"],
        });
        if (input["decision"] === "accepted")
          await currentForTransaction(tx, scope, plan, ctx.now());
        return value;
      },
      true
    );
  };
  const reserveForTransaction = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    at: string
  ): Promise<void> => {
    await currentForTransaction(tx, scope, plan, at);
    const debate = object(plan["debate"]),
      run = await readRun(tx, scope, identifier(debate["debateRunId"]));
    if (!run) return fail("integrity");
    const existing = await charges(tx, scope, run),
      ordinal = Number(debate["ordinal"]),
      prior = existing[ordinal - 1];
    if (prior) {
      if (
        prior["responseRequestId"] !== plan["responseRequestId"] ||
        prior["planSha256"] !== plan["planSha256"] ||
        prior["requestSha256"] !== plan["requestSha256"]
      )
        return fail("conflict");
      return;
    }
    if (
      ordinal !== existing.length + 1 ||
      ordinal > 5 ||
      BigInt(ordinal) * BigInt(String(run["turnTokens"])) >
        BigInt(String(run["aggregateTokens"])) ||
      BigInt(ordinal) * decimalUnits(string(run["turnCostUsd"])) >
        decimalUnits(string(run["aggregateCostUsd"]))
    )
      return fail("denied");
    const value = {
      profile: "vertex-research-chat-debate-charge-v1",
      ...scope,
      debateRunId: run["debateRunId"],
      ordinal,
      responseRequestId: plan["responseRequestId"],
      planId: plan["planId"],
      planSha256: plan["planSha256"],
      requestSha256: plan["requestSha256"],
      state: "reserved",
      chargedTokens: String(run["turnTokens"]),
      chargedUsdUnits: decimalUnits(string(run["turnCostUsd"])).toString(),
      reservedAt: at,
      actualTokens: null,
      observedCostUpperBoundUsdUnits: null,
    };
    await save(tx, stepTable, scope, value, {
      debate_run_id: run["debateRunId"],
      ordinal,
      response_request_id: plan["responseRequestId"],
      plan_id: plan["planId"],
      plan_sha256: plan["planSha256"],
      state: "reserved",
      charged_tokens: value.chargedTokens,
      charged_usd_units: value.chargedUsdUnits,
    });
    await charges(tx, scope, run);
  };
  const requireReservationForTransaction = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord
  ): Promise<void> => {
    const debate = object(plan["debate"]),
      run = await readRun(tx, scope, identifier(debate["debateRunId"]));
    if (!run) return fail("integrity");
    const values = await charges(tx, scope, run),
      charge = values[Number(debate["ordinal"]) - 1];
    if (
      !charge ||
      charge["responseRequestId"] !== plan["responseRequestId"] ||
      charge["planSha256"] !== plan["planSha256"] ||
      charge["requestSha256"] !== plan["requestSha256"]
    )
      return fail("denied");
  };
  const settleForTransaction = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    usage: VertexRecord,
    tokenizeCostUsd: string
  ): Promise<void> => {
    await requireReservationForTransaction(tx, scope, plan);
    const debate = object(plan["debate"]),
      run = await readRun(tx, scope, identifier(debate["debateRunId"]));
    if (!run) return fail("integrity");
    const values = await charges(tx, scope, run),
      prior = requirePresent(
        values[Number(debate["ordinal"]) - 1],
        'values[Number(debate["ordinal"]) - 1]'
      );
    const tokens = BigInt(String(usage["totalTokens"])),
      usd =
        decimalUnits(tokenizeCostUsd) +
        decimalUnits(string(usage["completionCostUsd"]));
    if (
      tokens < 0n ||
      tokens > BigInt(string(prior["chargedTokens"])) ||
      usd > BigInt(string(prior["chargedUsdUnits"]))
    )
      return fail("denied");
    const value = {
      ...prior,
      state: "spent",
      actualTokens: tokens.toString(),
      observedCostUpperBoundUsdUnits: usd.toString(),
    };
    if (prior["state"] === "spent") {
      if (!(await same(value, prior))) return fail("integrity");
      return;
    }
    const recordHash = await ctx.hash(value);
    await tx.execute(
      sql`update vertex_research_chat_debate_steps set state = 'spent', payload = ${JSON.stringify(value)}::jsonb, record_hash = ${recordHash} where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and debate_run_id = ${debate["debateRunId"]} and ordinal = ${debate["ordinal"]} and state = 'reserved'`
    );
    const after = (await charges(tx, scope, run))[
      Number(debate["ordinal"]) - 1
    ];
    if (!(after && (await same(after, value)))) return fail("integrity");
  };
  // Metadata-only read for the original owner's stepwise UI. This neither
  // issues grants nor prepares/approves a future step nor reads advisory bytes.
  const readRunForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    runKey: string
  ) => {
    const debateRunId = `debate-${await ctx.hash({ scope, ownerActorId: principal.actorId, threadId, runKey })}`;
    const run = await readRun(tx, scope, debateRunId);
    if (!run) return null;
    if (
      run["ownerActorId"] !== principal.actorId ||
      run["threadId"] !== threadId ||
      run["runKey"] !== runKey ||
      !(await same(run["configuration"], configurationPin))
    )
      return fail("denied");
    const selectedBytes = await options.readSelectedArtifact(
      tx,
      principal,
      scope,
      configurationPin
    );
    try {
      if (
        (await ctx.digest(selectedBytes)) !== configurationPin["artifactSha256"]
      )
        return fail("integrity");
      const selected = options.validate(
        "configuration",
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(selectedBytes)
        )
      );
      if (
        (await ctx.hash(selected)) !== configurationPin["artifactSha256"] ||
        time(ctx.now()) >= time(selected["expiresAt"])
      )
        return fail("stale");
    } finally {
      selectedBytes.fill(0);
    }
    const values = await charges(tx, scope, run);
    const steps: {
      charge: (typeof values)[number];
      plan: Awaited<ReturnType<typeof planRow>>;
    }[] = [];
    for (const charge of values) {
      const plan = await planRow(
        tx,
        scope,
        identifier(charge["responseRequestId"])
      );
      if (
        plan["ownerActorId"] !== principal.actorId ||
        plan["threadId"] !== threadId ||
        object(plan["debate"])["debateRunId"] !== debateRunId ||
        object(plan["debate"])["ordinal"] !== charge["ordinal"] ||
        plan["planSha256"] !== charge["planSha256"]
      )
        return fail("integrity");
      steps.push({ charge, plan });
    }
    return { run, steps };
  };
  const sourceReviewShaForTransaction = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord
  ): Promise<string> => {
    const history = await reviews(tx, scope, plan),
      review = history.at(-1);
    if (review?.["decision"] !== "accepted") return fail("denied");
    return ctx.hash(review);
  };
  return Object.freeze({
    prepareForTransaction,
    currentForTransaction,
    recordResearchChatDerivedUseReview,
    reserveForTransaction,
    requireReservationForTransaction,
    settleForTransaction,
    readRunForTransaction,
    useResource,
    reviewResource,
    prepareSourceInputs,
    disposeSourceInputs,
    recheckSourceInputsForTransaction,
    sourceReviewShaForTransaction,
  });
};
