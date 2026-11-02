import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import {
  snapshotVertexChatCopyBinding,
  vertexChatCopyKey,
  VERTEX_CHAT_COPY_FENCE_PROFILE,
  MAX_VERTEX_CHAT_COPY_BYTES,
  type VertexChatCopyBinding,
} from "./chat-copies.ts";
import {
  createVertexR2ChatCopyCapabilities,
  type VertexR2ChatCopyOptions,
} from "./r2-chat-copies.ts";
import {
  createVertexR2ObjectStore,
  type VertexR2Bucket,
  type VertexR2Object,
  type VertexR2PutOptions,
  type VertexR2GetOptions,
} from "./r2.ts";

// Offline structural fake only. Conditions are evaluated at COMMIT, after any
// injected pause, never at dispatch. No service/bucket qualification follows.
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const checksum = (value: string): ArrayBuffer =>
  Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
    .buffer as ArrayBuffer;
const scope = {
  accountAlias: "fixture:account",
  environment: "research" as const,
};
const profile = "a".repeat(64);
const fixture = (
  text = "synthetic private copy",
  change: Partial<VertexChatCopyBinding> = {}
) => {
  const bytes = new TextEncoder().encode(text);
  const binding: VertexChatCopyBinding = {
    scope: { ...scope },
    ownerActorId: "fixture:owner",
    threadId: "fixture:thread",
    responseRequestId: "fixture:request",
    copyId: "fixture:copy",
    kind: "context",
    reservationSha256: "b".repeat(64),
    storageProfileSha256: profile,
    maximumBytes: 1024,
    content: { sha256: hash(bytes), byteLength: bytes.byteLength },
    ...change,
  };
  return { binding, bytes, key: vertexChatCopyKey(binding) };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    return (reject = deny);
  });
  return { promise, resolve, reject };
};
interface DeferredVoid {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}
interface Row {
  bytes: Uint8Array;
  object: VertexR2Object;
}
const copyObject = (object: VertexR2Object): VertexR2Object => ({
  ...object,
  uploaded: new Date(object.uploaded.getTime()),
  checksums: { sha256: object.checksums.sha256?.slice(0) },
  httpMetadata: { ...object.httpMetadata },
  customMetadata: { ...object.customMetadata },
});
const transport = () => {
  const rows = new Map<string, Row>();
  const events: string[] = [];
  let uploads = 0;
  const cancellations = vi.fn();
  const stream = (
    chunks: readonly Uint8Array[]
  ): ReadableStream<Uint8Array> => {
    let index = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (index === chunks.length) {
            controller.close();
          } else {
            controller.enqueue(chunks[index++]!);
          }
        },
        cancel: cancellations,
      },
      { highWaterMark: 0 }
    );
  };
  const plans: {
    entered: DeferredVoid;
    release: DeferredVoid;
    finished: DeferredVoid;
    loseAck: boolean;
  }[] = [];
  const pauseNextPut = (loseAck = false) => {
    const plan = {
      entered: deferred<void>(),
      release: deferred<void>(),
      finished: deferred<void>(),
      loseAck,
    };
    plans.push(plan);
    return plan;
  };
  const head = vi.fn(async (key: string): Promise<VertexR2Object | null> => {
    events.push("head");
    const row = rows.get(key);
    return row
      ? {
          ...copyObject(row.object),
          range: { offset: 0, length: row.object.size },
        }
      : null;
  });
  const put = vi.fn(
    async (
      key: string,
      value: Uint8Array,
      options: VertexR2PutOptions
    ): Promise<VertexR2Object | null> => {
      events.push("put");
      const bytes = new Uint8Array(value);
      const absent = options.onlyIf.get("If-None-Match");
      const matchHeader = options.onlyIf.get("If-Match");
      const matches =
        matchHeader === null
          ? null
          : /^"([A-Za-z0-9_.:-]{1,256})"$/.exec(matchHeader)?.[1];
      if (
        !(
          (absent === "*" && matchHeader === null) ||
          (absent === null && typeof matches === "string")
        )
      )
        throw new Error("unsafe fixture write");
      if (hash(bytes) !== options.sha256)
        throw new Error("fixture checksum mismatch");
      const plan = plans.shift();
      plan?.entered.resolve();
      if (plan) await plan.release.promise;
      // There is deliberately no await between testing the condition and storing.
      const current = rows.get(key);
      let result: VertexR2Object | null = null;
      if (
        (absent === "*" && !current) ||
        (matches !== null && current?.object.etag === matches)
      ) {
        uploads += 1;
        const object: VertexR2Object = {
          key,
          size: bytes.byteLength,
          etag: `opaque-etag-${uploads}`,
          version: `upload-${uploads}`,
          uploaded: new Date("2026-09-24T10:00:00.000Z"),
          checksums: { sha256: checksum(options.sha256) },
          httpMetadata: { ...options.httpMetadata },
          customMetadata: { ...options.customMetadata },
        };
        rows.set(key, { bytes, object });
        result = copyObject(object);
      }
      plan?.finished.resolve();
      if (plan?.loseAck) throw new Error("fixture lost acknowledgement");
      return result;
    }
  );
  const get = vi.fn(
    async (
      key: string,
      options: VertexR2GetOptions
    ): Promise<VertexR2Object | null> => {
      events.push("get");
      const row = rows.get(key);
      if (!row) return null;
      if (row.object.etag !== options.onlyIf.etagMatches)
        return copyObject(row.object);
      const bytes = row.bytes.slice(
        options.range.offset,
        options.range.offset + options.range.length
      );
      return {
        ...copyObject(row.object),
        range: { offset: 0, length: bytes.byteLength },
        body: stream([bytes]),
      };
    }
  );
  const bucket: VertexR2Bucket = { head, get, put };
  const bind = (
    options: Partial<Omit<VertexR2ChatCopyOptions, "bucket">> = {}
  ) =>
    createVertexR2ChatCopyCapabilities({
      bucket,
      scope,
      storageProfileSha256: profile,
      maximumBytes: 1024,
      ...options,
    });
  return {
    rows,
    events,
    head,
    put,
    get,
    bucket,
    bind,
    pauseNextPut,
    stream,
    cancellations,
    uploads: () => uploads,
  };
};
const seeded = async () => {
  const fake = transport();
  const value = fixture();
  const adapter = fake.bind();
  expect((await adapter.createCopy(value.binding, value.bytes)).status).toBe(
    "live"
  );
  return { ...fake, ...value, adapter, row: fake.rows.get(value.key)! };
};
const reserved = (binding: VertexChatCopyBinding): VertexChatCopyBinding => ({
  ...binding,
  content: null,
});
const invalid = { status: "invalid" };
const conflict = { status: "conflict" };
const unknown = { status: "unknown" };

afterEach(() => vi.useRealTimers());

describe("isolated research chat copy storage primitives", () => {
  it("uses a canonical exclusive key disjoint from legacy content addressing", () => {
    const value = fixture();
    expect(value.key).toBe(
      `vertex/chat-copy/v1/${profile}/fixture%3Aaccount/research/fixture%3Aowner/fixture%3Athread/fixture%3Arequest/context/fixture%3Acopy`
    );
    expect(vertexChatCopyKey(reserved(value.binding))).toBe(value.key);
    const keys = [
      "ownerActorId",
      "threadId",
      "responseRequestId",
      "copyId",
    ].map((field) => vertexChatCopyKey({ ...value.binding, [field]: "other" }));
    keys.push(
      vertexChatCopyKey({ ...value.binding, kind: "model-input" }),
      vertexChatCopyKey({ ...value.binding, kind: "derived-output" })
    );
    expect(new Set([value.key, ...keys]).size).toBe(7);
    return expect(value.key.startsWith("vertex/v1/")).toBe(false);
  });

  it("creates once, reconciles identical bytes, and returns immutable opaque proofs", async () => {
    const fake = await seeded();
    expect(fake.events).toEqual(["put"]);
    const result = await fake.adapter.createCopy(fake.binding, fake.bytes);
    expect(result.status).toBe("live");
    expect(fake.uploads()).toBe(1);
    expect(fake.events).toEqual(["put", "put", "head", "get"]);
    expect(
      fake.put.mock.calls.every(
        (call) => call[2].onlyIf.get("If-None-Match") === "*"
      )
    ).toBe(true);
    expect(
      fake.put.mock.calls.every(
        (call) => call[2].httpMetadata.cacheControl === "no-store"
      )
    ).toBe(true);
    if (result.status !== "live") throw new Error("expected fixture live");
    expect(result.proof.etag).not.toBe(result.proof.sha256);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proof)).toBe(true);
    return expect(fake.get.mock.calls[0]![1]).toEqual({
      onlyIf: { etagMatches: result.proof.etag },
      range: { offset: 0, length: fake.bytes.byteLength },
    });
  });

  it("rejects exact-shape, scope, profile, size and digest failures before all I/O", async () => {
    const fake = transport();
    const adapter = fake.bind();
    const value = fixture();
    const bad: unknown[] = [
      { ...value.binding, extra: true },
      { ...value.binding, key: "vertex/v1/legacy" },
      { ...value.binding, ownerActorId: "owner\n" },
      { ...value.binding, reservationSha256: `${"b".repeat(64)}\n` },
      { ...value.binding, storageProfileSha256: "A".repeat(64) },
      { ...value.binding, storageProfileSha256: "c".repeat(64) },
      { ...value.binding, scope: { ...scope, environment: "paper" } },
      { ...value.binding, scope: { ...scope, environment: "live" } },
      { ...value.binding, scope: { ...scope, accountAlias: "other" } },
      { ...value.binding, scope: { ...scope, accountAlias: "account\n" } },
      { ...value.binding, maximumBytes: 0 },
      { ...value.binding, maximumBytes: 1.5 },
      { ...value.binding, maximumBytes: Number.MAX_SAFE_INTEGER },
      { ...value.binding, maximumBytes: 1025 },
      { ...value.binding, content: { ...value.binding.content, extra: true } },
      {
        ...value.binding,
        content: { sha256: value.binding.content!.sha256, byteLength: 0 },
      },
      {
        ...value.binding,
        content: { sha256: value.binding.content!.sha256, byteLength: 2000 },
      },
      { ...value.binding, content: undefined },
      { ...value.binding, kind: "manifest" },
      Object.create(value.binding),
      null,
    ];
    for (const item of bad) {
      const binding = item as VertexChatCopyBinding;
      expect(await adapter.createCopy(binding, value.bytes)).toEqual(invalid);
      expect(await adapter.inspectCopy(binding)).toEqual(invalid);
      expect(await adapter.readCopy(binding)).toEqual(invalid);
      expect(await adapter.fenceCopy(binding)).toEqual(invalid);
    }
    expect(
      await adapter.createCopy(reserved(value.binding), value.bytes)
    ).toEqual(invalid);
    expect(
      await adapter.createCopy(
        value.binding,
        new Uint8Array(value.bytes.byteLength)
      )
    ).toEqual(invalid);
    expect(
      await adapter.createCopy(value.binding, value.bytes.slice(1))
    ).toEqual(invalid);
    return expect(fake.events).toEqual([]);
  });

  it("rejects executable records, byte subclasses/proxies/shared buffers and overlong encoded keys", async () => {
    const fake = transport();
    const value = fixture();
    const getter = vi.fn(() => value.binding.ownerActorId);
    const binding = Object.defineProperty(
      { ...value.binding },
      "ownerActorId",
      { get: getter }
    );
    expect(await fake.bind().createCopy(binding, value.bytes)).toEqual(invalid);
    expect(
      await fake.bind().inspectCopy({
        ...value.binding,
        scope: Object.defineProperty({ ...scope }, "accountAlias", {
          get: getter,
        }),
      })
    ).toEqual(invalid);
    expect(
      await fake.bind().readCopy({
        ...value.binding,
        content: Object.defineProperty(
          { sha256: hash(value.bytes), byteLength: value.bytes.byteLength },
          "sha256",
          { get: getter }
        ),
      })
    ).toEqual(invalid);
    class Subclass extends Uint8Array {}
    const bodies = [
      new Subclass(value.bytes),
      new Uint8Array(new SharedArrayBuffer(value.bytes.byteLength)),
      new Proxy(value.bytes, {}),
      Object.defineProperty(new Uint8Array(value.bytes), "byteLength", {
        get: getter,
      }),
    ];
    for (const body of bodies)
      expect(await fake.bind().createCopy(value.binding, body)).toEqual(
        invalid
      );
    expect(getter).not.toHaveBeenCalled();
    const long = `a${":".repeat(159)}`;
    expect(() =>
      vertexChatCopyKey({
        ...value.binding,
        scope: { ...scope, accountAlias: long },
        ownerActorId: long,
        threadId: long,
        responseRequestId: long,
        copyId: long,
      })
    ).toThrow();
    return expect(fake.events).toEqual([]);
  });

  it("captures every caller field and byte before the first await", async () => {
    const fake = transport();
    const value = fixture();
    const originalBytes = new Uint8Array(value.bytes);
    const mutable = JSON.parse(JSON.stringify(value.binding));
    const options = {
      bucket: fake.bucket,
      scope: { ...scope },
      storageProfileSha256: profile,
      maximumBytes: 1024,
    };
    const adapter = createVertexR2ChatCopyCapabilities(options);
    const pending = adapter.createCopy(mutable, value.bytes);
    mutable.ownerActorId = "changed";
    mutable.scope.accountAlias = "changed";
    mutable.content.sha256 = "c".repeat(64);
    mutable.maximumBytes = 1;
    value.bytes.fill(0);
    options.scope.accountAlias = "changed";
    options.storageProfileSha256 = "c".repeat(64);
    expect((await pending).status).toBe("live");
    expect(fake.rows.get(value.key)!.bytes).toEqual(originalBytes);
    expect(fake.rows.size).toBe(1);
    return expect(
      Object.isFrozen(snapshotVertexChatCopyBinding(value.binding).scope)
    ).toBe(true);
  });

  it("seals absence with stable fixed bytes even before the output hash is bound", async () => {
    const fake = transport();
    const value = fixture("x", { maximumBytes: 1 });
    const adapter = fake.bind({ maximumBytes: 1 });
    expect(await adapter.inspectCopy(reserved(value.binding))).toEqual({
      status: "missing",
    });
    const result = await adapter.fenceCopy(reserved(value.binding));
    expect(result.status).toBe("fenced");
    const { content: _content, ...base } = value.binding;
    const bindingSha256 = hash(
      new TextEncoder().encode(canonicalArtifactJson(base))
    );
    const marker = new TextEncoder().encode(
      canonicalArtifactJson({
        profile: VERTEX_CHAT_COPY_FENCE_PROFILE,
        bindingSha256,
      })
    );
    expect(fake.rows.get(value.key)!.bytes).toEqual(marker);
    expect(marker.byteLength).toBeGreaterThan(1);
    expect((await adapter.fenceCopy(value.binding)).status).toBe("fenced");
    expect((await adapter.createCopy(value.binding, value.bytes)).status).toBe(
      "fenced"
    );
    expect((await adapter.readCopy(value.binding)).status).toBe("fenced");
    expect(fake.get).not.toHaveBeenCalled();
    return expect(fake.uploads()).toBe(1);
  });

  it("fences a live payload with its observed opaque ETag and never returns its content", async () => {
    const fake = await seeded();
    const before = fake.row.object.etag;
    const inspect = await fake.adapter.inspectCopy(fake.binding);
    expect(inspect.status).toBe("live");
    expect("bytes" in inspect).toBe(false);
    const result = await fake.adapter.fenceCopy(fake.binding);
    expect(result.status).toBe("fenced");
    expect("bytes" in result).toBe(false);
    expect(fake.put.mock.calls[1]![2].onlyIf.get("If-None-Match")).toBe("*");
    expect(fake.put.mock.calls[2]![2].onlyIf.get("If-Match")).toBe(
      `"${before}"`
    );
    expect(fake.put.mock.calls[2]![2].onlyIf.get("If-None-Match")).toBe(null);
    expect(fake.rows.get(fake.key)!.bytes).not.toEqual(fake.bytes);
    expect(fake.get).not.toHaveBeenCalled();
    return expect((await fake.adapter.readCopy(fake.binding)).status).toBe(
      "fenced"
    );
  });

  it("distinguishes marker-shaped payload bytes from fence provenance even with the same digest", async () => {
    const fake = transport();
    const value = fixture();
    const { content: _content, ...base } = value.binding;
    const bindingSha256 = hash(
      new TextEncoder().encode(canonicalArtifactJson(base))
    );
    const bytes = new TextEncoder().encode(
      canonicalArtifactJson({
        profile: VERTEX_CHAT_COPY_FENCE_PROFILE,
        bindingSha256,
      })
    );
    const binding = {
      ...value.binding,
      content: { sha256: hash(bytes), byteLength: bytes.byteLength },
    };
    const adapter = fake.bind();
    expect((await adapter.createCopy(binding, bytes)).status).toBe("live");
    expect((await adapter.inspectCopy(binding)).status).toBe("live");
    expect(await adapter.fenceCopy(reserved(binding))).toEqual(conflict);
    expect((await adapter.fenceCopy(binding)).status).toBe("fenced");
    expect(fake.rows.get(value.key)!.bytes).toEqual(bytes);
    expect(fake.uploads()).toBe(2);
    expect((await adapter.readCopy(binding)).status).toBe("fenced");
    expect(
      fake.rows.get(value.key)!.object.customMetadata!["vertexChatCopyState"]
    ).toBe("fenced");
    return expect(
      fake.rows.get(value.key)!.object.httpMetadata!.cacheControl
    ).toBe("no-store");
  });

  it("will not overwrite unexplained payload with an unbound reservation or foreign commitment", async () => {
    const fake = await seeded();
    expect(await fake.adapter.fenceCopy(reserved(fake.binding))).toEqual(
      conflict
    );
    expect(
      await fake.adapter.fenceCopy({
        ...fake.binding,
        reservationSha256: "d".repeat(64),
      })
    ).toEqual(conflict);
    expect(fake.uploads()).toBe(1);
    expect(fake.rows.get(fake.key)!.bytes).toEqual(fake.bytes);
    return expect(fake.get).not.toHaveBeenCalled();
  });

  it("cannot resurrect a marker when a delayed payload commits after fencing", async () => {
    const fake = transport();
    const value = fixture();
    const adapter = fake.bind();
    const delay = fake.pauseNextPut();
    const writing = adapter.createCopy(value.binding, value.bytes);
    await delay.entered.promise;
    expect((await adapter.fenceCopy(reserved(value.binding))).status).toBe(
      "fenced"
    );
    delay.release.resolve();
    expect((await writing).status).toBe("fenced");
    expect(fake.uploads()).toBe(1);
    return expect((await adapter.inspectCopy(value.binding)).status).toBe(
      "fenced"
    );
  });

  it("conditionally replaces a payload that commits before the delayed absent-marker attempt", async () => {
    const fake = transport();
    const value = fixture();
    const adapter = fake.bind();
    const delay = fake.pauseNextPut();
    const fencing = adapter.fenceCopy(value.binding);
    await delay.entered.promise;
    expect((await adapter.createCopy(value.binding, value.bytes)).status).toBe(
      "live"
    );
    delay.release.resolve();
    expect((await fencing).status).toBe("fenced");
    expect(fake.uploads()).toBe(2);
    return expect(
      (await adapter.createCopy(value.binding, value.bytes)).status
    ).toBe("fenced");
  });

  it("two concurrent cleanup callers converge through commit-time conditions", async () => {
    const fake = await seeded();
    const results = await Promise.all([
      fake.adapter.fenceCopy(fake.binding),
      fake.adapter.fenceCopy(fake.binding),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fenced",
      "fenced",
    ]);
    expect(fake.uploads()).toBe(2);
    for (const call of fake.put.mock.calls) {
      expect(
        call[2].onlyIf.has("If-Match") !== call[2].onlyIf.has("If-None-Match")
      ).toBe(true);
    }
  });

  it.each(["payload", "marker"])(
    "preserves unknown lost %s ACK and allows later explicit reconciliation",
    async (kind) => {
      const fake = transport();
      const value = fixture();
      const adapter = fake.bind();
      const delay = fake.pauseNextPut(true);
      const pending =
        kind === "payload"
          ? adapter.createCopy(value.binding, value.bytes)
          : adapter.fenceCopy(value.binding);
      await delay.entered.promise;
      delay.release.resolve();
      expect(await pending).toEqual(unknown);
      expect(fake.events).toEqual(["put"]);
      expect((await adapter.inspectCopy(value.binding)).status).toBe(
        kind === "payload" ? "live" : "fenced"
      );
      return expect((await adapter.fenceCopy(value.binding)).status).toBe(
        "fenced"
      );
    }
  );

  it.each(["abort", "timeout"])(
    "%s after dispatch leaves acceptance unknown and cannot reopen a later fence",
    async (mode) => {
      if (mode === "timeout") vi.useFakeTimers();
      const fake = transport();
      const value = fixture();
      const controller = new AbortController();
      const adapter = fake.bind({
        signal: controller.signal,
        operationTimeoutMs: 25,
      });
      const delay = fake.pauseNextPut(true);
      const pending = adapter.createCopy(value.binding, value.bytes);
      await delay.entered.promise;
      if (mode === "abort") {
        controller.abort();
      } else await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toEqual(unknown);
      const independent = fake.bind();
      expect((await independent.fenceCopy(value.binding)).status).toBe(
        "fenced"
      );
      delay.release.resolve();
      await delay.finished.promise;
      expect((await independent.inspectCopy(value.binding)).status).toBe(
        "fenced"
      );
      return expect(fake.uploads()).toBe(1);
    }
  );

  it("an aborted dispatched marker can still commit and only a later observation proves fencing", async () => {
    const fake = transport();
    const value = fixture();
    const controller = new AbortController();
    const delay = fake.pauseNextPut();
    const pending = fake
      .bind({ signal: controller.signal })
      .fenceCopy(reserved(value.binding));
    await delay.entered.promise;
    controller.abort();
    expect(await pending).toEqual(unknown);
    expect(fake.rows.size).toBe(0);
    delay.release.resolve();
    await delay.finished.promise;
    return expect((await fake.bind().inspectCopy(value.binding)).status).toBe(
      "fenced"
    );
  });

  it("a malformed marker ACK after actual commit stays unknown, not no-effect", async () => {
    const fake = transport();
    const value = fixture();
    const nativePut = fake.put.getMockImplementation()!;
    fake.put.mockImplementationOnce(async (key, bytes, options) => {
      const result = await nativePut(key, bytes, options);
      return { ...result!, etag: "*" };
    });
    const adapter = fake.bind();
    expect(await adapter.fenceCopy(value.binding)).toEqual(unknown);
    expect(fake.events).toEqual(["put"]);
    expect(fake.uploads()).toBe(1);
    return expect((await adapter.inspectCopy(value.binding)).status).toBe(
      "fenced"
    );
  });

  it("cancellation before dispatch stops input inspection and performs no I/O", async () => {
    const fake = transport();
    const value = fixture();
    const controller = new AbortController();
    controller.abort();
    const adapter = fake.bind({ signal: controller.signal });
    const inspectInput = vi.fn(() => Object.prototype);
    const binding = new Proxy(value.binding, { getPrototypeOf: inspectInput });
    expect(await adapter.createCopy(binding, value.bytes)).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    expect(await adapter.fenceCopy(binding)).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    expect(await adapter.inspectCopy(binding)).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    expect(await adapter.readCopy(binding)).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    expect(inspectInput).not.toHaveBeenCalled();
    return expect(fake.events).toEqual([]);
  });

  it.each([429, 500])(
    "does not turn provider error %i into success or no effect",
    async (status) => {
      const fake = transport();
      const value = fixture();
      fake.put.mockRejectedValue({
        status,
        message: "private provider diagnostic",
      });
      expect(await fake.bind().createCopy(value.binding, value.bytes)).toEqual(
        unknown
      );
      expect(await fake.bind().fenceCopy(value.binding)).toEqual(unknown);
      expect(fake.head).not.toHaveBeenCalled();
      fake.head.mockRejectedValue({ status });
      return expect(await fake.bind().inspectCopy(value.binding)).toEqual({
        status: "unavailable",
        reason: "backend",
      });
    }
  );

  it("malformed mutation acknowledgement is unknown, not a safe-to-retry invalid input", async () => {
    const fake = transport();
    const value = fixture();
    fake.put.mockResolvedValue({ key: "foreign" } as VertexR2Object);
    expect(await fake.bind().createCopy(value.binding, value.bytes)).toEqual(
      unknown
    );
    expect(await fake.bind().fenceCopy(value.binding)).toEqual(unknown);
    return expect(fake.head).not.toHaveBeenCalled();
  });

  it("treats known miss followed by absent HEAD as a no-delete invariant conflict", async () => {
    const fake = transport();
    const value = fixture();
    fake.put.mockResolvedValue(null);
    expect(await fake.bind().createCopy(value.binding, value.bytes)).toEqual(
      conflict
    );
    expect(await fake.bind().fenceCopy(value.binding)).toEqual(conflict);
    return expect(fake.put).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated conditional misses without unconditional fallback or retry polling", async () => {
    const fake = await seeded();
    fake.put.mockResolvedValue(null);
    expect(await fake.adapter.fenceCopy(fake.binding)).toEqual(conflict);
    expect(fake.put.mock.calls.length).toBeLessThanOrEqual(4);
    expect(fake.head.mock.calls.length).toBeLessThanOrEqual(3);
    return expect(fake.uploads()).toBe(1);
  });

  it.each([
    "key",
    "size",
    "sha",
    "metadata",
    "extra",
    "etag",
    "wildcard",
    "list",
    "weak",
    "quoted",
    "version",
    "time",
    "http",
    "cache",
    "range",
  ])(
    "rejects foreign/malformed %s metadata without reading or replacing",
    async (mode) => {
      const fake = await seeded();
      const object = copyObject(fake.row.object);
      const altered =
        mode === "key"
          ? { ...object, key: "vertex/v1/legacy" }
          : mode === "size"
            ? { ...object, size: object.size + 1 }
            : mode === "sha"
              ? { ...object, checksums: { sha256: checksum("c".repeat(64)) } }
              : mode === "metadata"
                ? {
                    ...object,
                    customMetadata: {
                      ...object.customMetadata,
                      vertexReservationSha256: "d".repeat(64),
                    },
                  }
                : mode === "extra"
                  ? {
                      ...object,
                      customMetadata: {
                        ...object.customMetadata,
                        extra: "unowned",
                      },
                    }
                  : mode === "etag"
                    ? { ...object, etag: "etag\n" }
                    : mode === "wildcard"
                      ? { ...object, etag: "*" }
                      : mode === "list"
                        ? { ...object, etag: "first,second" }
                        : mode === "weak"
                          ? { ...object, etag: "W/validator" }
                          : mode === "quoted"
                            ? { ...object, etag: '"validator"' }
                            : mode === "version"
                              ? { ...object, version: "version\n" }
                              : mode === "time"
                                ? { ...object, uploaded: new Date(Number.NaN) }
                                : mode === "http"
                                  ? {
                                      ...object,
                                      httpMetadata: {
                                        contentType: "text/plain",
                                      },
                                    }
                                  : mode === "cache"
                                    ? {
                                        ...object,
                                        httpMetadata: {
                                          ...object.httpMetadata,
                                          cacheControl: "public",
                                        },
                                      }
                                    : {
                                        ...object,
                                        range: {
                                          offset: 1,
                                          length: object.size,
                                        },
                                      };
      fake.head.mockResolvedValue(altered);
      expect(await fake.adapter.inspectCopy(fake.binding)).toEqual(conflict);
      expect(await fake.adapter.readCopy(fake.binding)).toEqual(conflict);
      expect(await fake.adapter.fenceCopy(fake.binding)).toEqual(conflict);
      expect(fake.get).not.toHaveBeenCalled();
      return expect(fake.uploads()).toBe(1);
    }
  );

  it("does not accept a content collision based on matching metadata alone", async () => {
    const fake = await seeded();
    fake.row.bytes.fill(0);
    expect(await fake.adapter.createCopy(fake.binding, fake.bytes)).toEqual(
      conflict
    );
    expect(await fake.adapter.readCopy(fake.binding)).toEqual(conflict);
    return expect(fake.uploads()).toBe(1);
  });

  it("reads bounded bytes but does not turn a successful historical read into continuing authority", async () => {
    const fake = await seeded();
    const result = await fake.adapter.readCopy(fake.binding);
    expect(result.status).toBe("live");
    if (result.status !== "live") throw new Error("expected fixture bytes");
    expect(result.bytes).toEqual(fake.bytes);
    result.bytes.fill(0);
    expect(fake.row.bytes).toEqual(fake.bytes);
    expect((await fake.adapter.fenceCopy(fake.binding)).status).toBe("fenced");
    return expect((await fake.adapter.readCopy(fake.binding)).status).toBe(
      "fenced"
    );
  });

  it.each(["etag", "version", "timestamp", "condition"])(
    "refuses a %s race between HEAD and conditional GET",
    async (mode) => {
      const fake = await seeded();
      const object = copyObject(fake.row.object);
      const body = fake.stream([fake.bytes]);
      const response = {
        ...object,
        range: { offset: 0, length: object.size },
        body,
      };
      fake.get.mockResolvedValue(
        mode === "etag"
          ? { ...response, etag: "changed" }
          : mode === "version"
            ? { ...response, version: "changed" }
            : mode === "timestamp"
              ? { ...response, uploaded: new Date("2026-09-25T10:00:00Z") }
              : object
      );
      return expect(
        (await fake.adapter.readCopy(fake.binding)).status
      ).not.toBe("live");
    }
  );

  it.each(["truncated", "oversized", "empty", "hash", "shared"])(
    "rejects %s stream content and cancels unfinished bodies",
    async (mode) => {
      const fake = await seeded();
      const bytes =
        mode === "truncated"
          ? fake.bytes.slice(1)
          : mode === "oversized"
            ? new Uint8Array(fake.bytes.byteLength + 1)
            : mode === "empty"
              ? new Uint8Array()
              : mode === "shared"
                ? new Uint8Array(new SharedArrayBuffer(fake.bytes.byteLength))
                : new Uint8Array(fake.bytes.byteLength);
      fake.get.mockResolvedValue({
        ...copyObject(fake.row.object),
        range: { offset: 0, length: fake.bytes.byteLength },
        body: fake.stream([bytes]),
      });
      expect(await fake.adapter.readCopy(fake.binding)).toEqual(conflict);
      return expect(fake.cancellations).toHaveBeenCalledTimes(
        ["oversized", "empty", "shared"].includes(mode) ? 1 : 0
      );
    }
  );

  it("caps streaming work even for arbitrarily many individually valid small chunks", async () => {
    const fake = transport();
    const value = fixture("x".repeat(65_537), { maximumBytes: 65_537 });
    const adapter = fake.bind({ maximumBytes: 65_537 });
    expect((await adapter.createCopy(value.binding, value.bytes)).status).toBe(
      "live"
    );
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (emitted++ < 65_537) {
            controller.enqueue(new Uint8Array([120]));
          } else {
            controller.close();
          }
        },
        cancel: fake.cancellations,
      },
      { highWaterMark: 0 }
    );
    fake.get.mockResolvedValue({
      ...copyObject(fake.rows.get(value.key)!.object),
      range: { offset: 0, length: value.bytes.byteLength },
      body,
    });
    expect(await adapter.readCopy(value.binding)).toEqual(conflict);
    return expect(fake.cancellations).toHaveBeenCalledTimes(1);
  });

  it("discards late conditional GET bodies and consumes late provider rejections", async () => {
    const fake = await seeded();
    const controller = new AbortController();
    const gate = deferred<VertexR2Object | null>();
    const entered = deferred<void>();
    fake.get.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const pending = fake
      .bind({ signal: controller.signal })
      .readCopy(fake.binding);
    await entered.promise;
    controller.abort();
    expect(await pending).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    gate.resolve({
      ...copyObject(fake.row.object),
      body: fake.stream([fake.bytes]),
    });
    await Promise.resolve();
    await Promise.resolve();
    return expect(fake.cancellations).toHaveBeenCalledTimes(1);
  });

  it("validates configuration without touching the bucket or invoking option getters", () => {
    const fake = transport();
    const getter = vi.fn(() => profile);
    const options = {
      bucket: fake.bucket,
      scope,
      storageProfileSha256: profile,
      maximumBytes: 1024,
    };
    const bad = [
      { ...options, extra: true },
      { ...options, storageProfileSha256: `${profile}\n` },
      { ...options, maximumBytes: MAX_VERTEX_CHAT_COPY_BYTES + 1 },
      { ...options, maximumBytes: 0 },
      { ...options, operationTimeoutMs: 0 },
      { ...options, scope: { ...scope, environment: "live" } },
      { ...options, operationTimeoutMs: null },
      Object.defineProperty({ ...options }, "storageProfileSha256", {
        get: getter,
      }),
    ];
    for (const value of bad)
      expect(() =>
        createVertexR2ChatCopyCapabilities(value as VertexR2ChatCopyOptions)
      ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    return expect(fake.events).toEqual([]);
  });

  return it("keeps legacy factory shape/default deletion denial and explicitly enables only account research", async () => {
    const fake = transport();
    const base = { bucket: fake.bucket, scope, collectionId: null };
    const legacy = createVertexR2ObjectStore(base);
    expect(Object.keys(legacy).sort()).toEqual([
      "objectCapabilities",
      "objects",
    ]);
    const explicit = createVertexR2ObjectStore({
      ...base,
      chatCopyProfileSha256: profile,
    });
    expect(Object.keys(explicit.chatCopyCapabilities!).sort()).toEqual([
      "createCopy",
      "fenceCopy",
      "inspectCopy",
      "readCopy",
    ]);
    const value = fixture();
    expect(await legacy.objects.delete(value.key)).toEqual({
      status: "unavailable",
      state: "disabled",
    });
    expect((await legacy.objects.get(value.key)).status).toBe("unavailable");
    expect(() =>
      createVertexR2ObjectStore({
        ...base,
        collectionId: "fixture:collection",
        chatCopyProfileSha256: profile,
      })
    ).toThrow();
    expect(() =>
      createVertexR2ObjectStore({
        ...base,
        scope: { ...scope, environment: "paper" },
        chatCopyProfileSha256: profile,
      })
    ).toThrow();
    expect(() =>
      createVertexR2ObjectStore({
        ...base,
        chatCopyProfileSha256: `${profile}\n`,
      })
    ).toThrow();
    const getter = vi.fn(() => profile);
    expect(() =>
      createVertexR2ObjectStore(
        Object.defineProperty({ ...base }, "chatCopyProfileSha256", {
          get: getter,
        })
      )
    ).toThrow();
    expect(() =>
      createVertexR2ObjectStore(
        Object.defineProperty(
          { ...base, chatCopyProfileSha256: profile },
          "bucket",
          { get: getter }
        )
      )
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    return expect(fake.events).toEqual([]);
  });
});
