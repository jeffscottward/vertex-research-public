import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import {
  collectionId,
  collectionKey,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  rows,
  scopeWhere,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexOutboxLease,
  VertexPrincipal,
  VertexRecord,
  VertexScope,
  VertexStore,
} from "./vertex-ports.ts";

export const createOutboxOperations = (ctx: PersistenceContext) => {
  const enqueue = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    event: VertexRecord,
    at: string
  ): Promise<"recorded" | "duplicate"> => {
    ctx.scoped(event, scope);
    const eventId = string(event["eventId"]);
    if (!/^event-[0-9a-f]{64}$/.test(eventId)) fail("invalid");
    await ctx.authorize(principal, scope, collection, eventId, "publish", at);
    const payload = object(event["payload"]);
    ctx.scoped(payload, scope);
    if (
      payload["collectionId"] !== undefined &&
      payload["collectionId"] !== collection
    )
      fail("denied");
    if (
      event["actorId"] !== principal.actorId ||
      time(event["occurredAt"]) > time(at) ||
      time(event["receivedAt"]) > time(at)
    )
      fail("denied");
    const {
      eventId: omittedId,
      receivedAt: omittedReceived,
      ...identity
    } = event;
    if (eventId !== `event-${await ctx.hash(identity)}`) fail("integrity");
    const hash = await ctx.hash(event);
    const previous = await one(
      tx,
      "vertex_outbox",
      scope,
      sql`event_id = ${eventId} or (collection_key = ${collectionKey(collection)} and idempotency_key = ${identifier(event["idempotencyKey"])})`
    );
    if (previous) {
      if (
        previous["record_hash"] !== hash ||
        previous["collection_key"] !== collectionKey(collection) ||
        previous["event_id"] !== eventId
      )
        fail("conflict");
      return "duplicate";
    }
    await ctx.ensureAccount(tx, scope, at);
    await insert(tx, "vertex_outbox", scope, {
      collection_key: collectionKey(collection),
      event_id: eventId,
      event_type: event["eventType"],
      idempotency_key: event["idempotencyKey"],
      record_hash: hash,
      payload: event,
      available_at_ns: time(at).toString(),
      lease_owner: null,
      lease_fence: "0",
      lease_expires_at: null,
      lease_expires_at_ns: null,
      published_at: null,
      settlement_hash: null,
    });
    return "recorded";
  };
  const enqueueEvent: VertexStore["enqueueEvent"] = async (
    principal,
    scope,
    collection,
    input
  ) => {
    const value = await ctx.validate("EventEnvelope", input);
    return ctx.run(
      principal,
      scope,
      collection,
      identifier(value["eventId"]),
      "publish",
      (tx, at) => enqueue(tx, principal, scope, collection, value, at)
    );
  };
  const claimOutbox: VertexStore["claimOutbox"] = async (
    principal,
    scope,
    input
  ) => {
    const value = structuredClone(input);
    identifier(value.leaseOwner);
    if (
      !Number.isSafeInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 100
    )
      fail("invalid");
    return await ctx.run(
      principal,
      scope,
      null,
      "vertex-outbox",
      "dispatch-outbox",
      async (tx, at) => {
        const expires = time(value.leaseExpiresAt);
        const current = time(at);
        if (expires <= current || expires - current > 3_600_000_000_000n)
          fail("invalid");
        const due = await rows(
          tx,
          sql`select * from vertex_outbox where ${scopeWhere(scope)} and published_at is null and available_at_ns <= ${current.toString()} and (settlement_hash is not null or lease_expires_at_ns is null or lease_expires_at_ns <= ${current.toString()}) order by available_at_ns, event_id limit ${value.limit} for update skip locked`
        );
        const claimed: VertexOutboxLease[] = [];
        for (const row of due) {
          const collection = collectionId(row["collection_key"]);
          await ctx.authorize(
            principal,
            scope,
            collection,
            string(row["event_id"]),
            "dispatch-outbox",
            at
          );
          if ((await ctx.hash(row["payload"])) !== row["record_hash"])
            fail("integrity");
          const fence = (sequence(row["lease_fence"]) + 1n).toString();
          sequence(fence);
          const changed = await rows(
            tx,
            sql`update vertex_outbox set lease_owner = ${value.leaseOwner}, lease_fence = ${fence}, lease_expires_at = ${value.leaseExpiresAt}, lease_expires_at_ns = ${expires.toString()}, settlement_hash = null where ${scopeWhere(scope)} and collection_key = ${collectionKey(collection)} and event_id = ${row["event_id"]} and lease_fence = ${row["lease_fence"]} and published_at is null returning event_id`
          );
          if (changed.length !== 1) fail("conflict");
          claimed.push({
            eventId: string(row["event_id"]),
            scope: structuredClone(scope),
            collectionId: collection,
            eventType: string(row["event_type"]),
            payload: structuredClone(object(row["payload"])),
            leaseOwner: value.leaseOwner,
            leaseFence: fence,
            leaseExpiresAt: value.leaseExpiresAt,
          });
        }
        return claimed;
      }
    );
  };
  const settleOutbox: VertexStore["settleOutbox"] = async (
    principal,
    scope,
    input
  ) => {
    const value = structuredClone(input);
    identifier(value.eventId);
    identifier(value.leaseOwner);
    sequence(value.leaseFence);
    if (!["published", "retry"].includes(value.result)) fail("invalid");
    time(value.availableAt);
    return await ctx.run(
      principal,
      scope,
      null,
      value.eventId,
      "dispatch-outbox",
      async (tx, at) => {
        const found = await one(
          tx,
          "vertex_outbox",
          scope,
          sql`event_id = ${value.eventId}`
        );
        if (!found) return false;
        await ctx.authorize(
          principal,
          scope,
          collectionId(found["collection_key"]),
          value.eventId,
          "dispatch-outbox",
          at
        );
        const hash = await ctx.hash(value);
        if (
          found["lease_fence"] !== value.leaseFence ||
          found["lease_owner"] !== value.leaseOwner
        )
          return false;
        if (found["settlement_hash"] !== null)
          return found["settlement_hash"] === hash;
        if (
          found["published_at"] !== null ||
          found["lease_expires_at_ns"] === null ||
          BigInt(string(found["lease_expires_at_ns"])) <= time(at)
        )
          return false;
        if (value.result === "retry" && time(value.availableAt) < time(at))
          fail("invalid");
        // Retain the exact owner/fence/expiry as the settlement receipt. Reclaim
        // overwrites it with a larger fence; old settlements then fail closed.
        const changed = await rows(
          tx,
          sql`update vertex_outbox set published_at = ${value.result === "published" ? at : null}, available_at_ns = ${time(value.availableAt).toString()}, settlement_hash = ${hash} where ${scopeWhere(scope)} and event_id = ${value.eventId} and collection_key = ${found["collection_key"]} and lease_owner = ${value.leaseOwner} and lease_fence = ${value.leaseFence} and settlement_hash is null returning event_id`
        );
        return changed.length === 1;
      }
    );
  };
  return { enqueue, enqueueEvent, claimOutbox, settleOutbox };
};
