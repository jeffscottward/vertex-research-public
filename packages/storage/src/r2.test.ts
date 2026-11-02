import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PutObjectInput } from "./index.ts";
import { vertexQualifiedObjectKey, type VertexStorageScope } from "./vertex.ts";
import {
  createVertexR2ObjectStore,
  isVertexR2Bucket,
  MAX_VERTEX_R2_BYTES,
  type VertexR2Bucket,
  type VertexR2GetOptions,
  type VertexR2Object,
  type VertexR2ObjectStoreOptions,
  type VertexR2PutOptions,
} from "./r2.ts";

// Authored but deliberately NOT executed during buildout. This synthetic
// transport never imports Cloudflare, contacts a provider, or grants rights.
const scope: VertexStorageScope = Object.freeze({
  accountAlias: "fixture:account",
  environment: "research",
});
const collectionId = "fixture:collection";
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const checksumBuffer = (value: string): ArrayBuffer =>
  Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
    .buffer as ArrayBuffer;
const inputFor = (
  text = "immutable fixture content",
  kind: "manifest" | "content" = "content",
  collection: string | null = collectionId
): PutObjectInput => {
  const body = new TextEncoder().encode(text);
  const checksum = hash(body);
  return {
    body,
    checksum,
    contentType:
      kind === "manifest" ? "application/json" : "application/octet-stream",
    key: vertexQualifiedObjectKey(scope, collection, kind, checksum),
  };
};

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
      bytes: Uint8Array,
      options: VertexR2PutOptions
    ): Promise<VertexR2Object | null> => {
      events.push("put");
      // Atomic critical section: the first writer stores, all others receive the
      // real binding's null conditional result, even under concurrent callers.
      if (options.onlyIf.get("If-None-Match") !== "*")
        throw new Error("fixture refused an unsafe write");
      if (hash(bytes) !== options.sha256)
        throw new Error("fixture checksum rejection");
      if (rows.has(key)) return null;
      uploads += 1;
      const object: VertexR2Object = {
        key,
        size: bytes.byteLength,
        version: `upload-${uploads}`,
        etag: `opaque-etag-${uploads}`,
        uploaded: new Date("2026-09-22T10:00:00.123Z"),
        checksums: { sha256: checksumBuffer(options.sha256) },
        httpMetadata: { ...options.httpMetadata },
        customMetadata: { ...options.customMetadata },
      };
      rows.set(key, { bytes: new Uint8Array(bytes), object });
      return copyObject(object);
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
        range: { offset: options.range.offset, length: bytes.byteLength },
        body: stream([bytes]),
      };
    }
  );
  const bucket: VertexR2Bucket = { head, get, put };
  const bind = (
    options: Partial<Omit<VertexR2ObjectStoreOptions, "bucket">> = {}
  ) => createVertexR2ObjectStore({ bucket, scope, collectionId, ...options });
  return {
    rows,
    events,
    head,
    get,
    put,
    bucket,
    bind,
    stream,
    cancellations,
    uploads: () => uploads,
  };
};

const seeded = async (
  options: Partial<Omit<VertexR2ObjectStoreOptions, "bucket">> = {}
) => {
  const fake = transport();
  const adapter = fake.bind(options);
  const input = inputFor(
    "immutable fixture content",
    "content",
    options.collectionId === undefined ? collectionId : options.collectionId
  );
  const result = await adapter.objectCapabilities.putIfAbsent!(input);
  expect(result.status).toBe("ok");
  return { ...fake, adapter, input, row: fake.rows.get(input.key)! };
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

const unavailable = { status: "unavailable", state: "unconfigured" };

describe("explicit scoped Cloudflare R2 object adapter", () => {
  it("creates without a preflight read and preserves exact SHA, scope and upload metadata", async () => {
    const fake = transport();
    const adapter = fake.bind();
    const input = inputFor();
    const result = await adapter.objectCapabilities.putIfAbsent!(input);
    expect(fake.events).toEqual(["put"]);
    expect(fake.put).toHaveBeenCalledTimes(1);
    const options = fake.put.mock.calls[0]![2];
    expect(options.onlyIf.get("If-None-Match")).toBe("*");
    expect(options.sha256).toBe(input.checksum);
    expect(options.customMetadata).toEqual({
      vertexSchema: "1",
      vertexAccountAlias: scope.accountAlias,
      vertexEnvironment: scope.environment,
      vertexCollectionKind: "collection",
      vertexCollectionId: collectionId,
      vertexObjectKind: "content",
      vertexSha256: input.checksum,
      vertexByteLength: String(input.body.byteLength),
    });
    expect(result).toEqual({
      status: "ok",
      value: {
        key: input.key,
        size: input.body.byteLength,
        contentType: input.contentType,
        checksum: input.checksum,
        createdAt: "2026-09-22T10:00:00.123Z",
        updatedAt: "2026-09-22T10:00:00.123Z",
      },
    });
    return expect(fake.rows.get(input.key)!.object.etag).not.toBe(
      input.checksum
    );
  });

  it("concurrent identical creators converge without overwrite and generic put remains create-only", async () => {
    const fake = transport();
    const first = fake.bind();
    const second = fake.bind();
    const input = inputFor();
    const results = await Promise.all([
      first.objects.put(input),
      second.objectCapabilities.putIfAbsent!(input),
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(fake.uploads()).toBe(1);
    expect(fake.put).toHaveBeenCalledTimes(2);
    expect(fake.events[0]).toBe("put");
    expect(fake.get).toHaveBeenCalledTimes(1);
    return expect(fake.get.mock.calls[0]![1]).toEqual({
      onlyIf: { etagMatches: "opaque-etag-1" },
      range: { offset: 0, length: input.body.byteLength },
    });
  });

  it("snapshots caller bytes and binding scope before asynchronous hashing", async () => {
    const fake = transport();
    const mutableScope = { ...scope };
    const adapter = fake.bind({ scope: mutableScope });
    const input = inputFor();
    const original = new Uint8Array(input.body);
    const pending = adapter.objects.put(input);
    input.body.fill(0);
    mutableScope.accountAlias = "other-account";
    expect((await pending).status).toBe("ok");
    expect(fake.rows.get(input.key)!.bytes).toEqual(original);
    return expect(
      fake.rows.get(input.key)!.object.customMetadata!["vertexAccountAlias"]
    ).toBe(scope.accountAlias);
  });

  it("does not treat a same-key collision or forged checksum metadata as an existing success", async () => {
    const fake = await seeded();
    fake.row.bytes.fill(1);
    const before = new Uint8Array(fake.row.bytes);
    expect(await fake.adapter.objects.put(fake.input)).toEqual(unavailable);
    expect(fake.uploads()).toBe(1);
    return expect(fake.row.bytes).toEqual(before);
  });

  it("unknown acceptance stays neutral with no automatic read/retry; an explicit retry reconciles", async () => {
    const fake = transport();
    const nativePut = fake.put.getMockImplementation()!;
    fake.put.mockImplementationOnce(async (key, bytes, options) => {
      await nativePut(key, bytes, options);
      throw new Error("fixture provider diagnostics must not escape");
    });
    const adapter = fake.bind();
    const input = inputFor();
    expect(await adapter.objects.put(input)).toEqual(unavailable);
    expect(fake.events).toEqual(["put"]);
    expect(fake.uploads()).toBe(1);
    expect((await adapter.objects.put(input)).status).toBe("ok");
    expect(fake.uploads()).toBe(1);
    return expect(fake.put).toHaveBeenCalledTimes(2);
  });

  it("never converts a rejected conditional-write capability into unconditional put", async () => {
    const fake = transport();
    fake.put.mockRejectedValue(
      new Error("fixture unsupported checksum/condition")
    );
    expect(await fake.bind().objects.put(inputFor())).toEqual(unavailable);
    expect(fake.put).toHaveBeenCalledTimes(1);
    expect(fake.head).not.toHaveBeenCalled();
    return expect(fake.get).not.toHaveBeenCalled();
  });

  it("returns a neutral missing result and does not fetch or fabricate metadata", async () => {
    const fake = transport();
    const adapter = fake.bind();
    const key = inputFor().key;
    expect(await adapter.objects.get(key)).toEqual({ status: "not-found" });
    expect(await adapter.objectCapabilities.head!(key)).toEqual({
      status: "not-found",
    });
    expect(fake.get).not.toHaveBeenCalled();
    return expect(fake.put).not.toHaveBeenCalled();
  });

  it("accepts exact account scope only and never deletes shared immutable bytes", async () => {
    const fake = await seeded({ collectionId: null });
    expect((await fake.adapter.objects.get(fake.input.key)).status).toBe("ok");
    expect(await fake.adapter.objects.get(inputFor().key)).toEqual(unavailable);
    expect(await fake.adapter.objects.delete(fake.input.key)).toEqual({
      status: "unavailable",
      state: "disabled",
    });
    return expect(fake.rows.has(fake.input.key)).toBe(true);
  });

  it.each([
    (key: string) => key.replace("fixture%3Aaccount", "other-account"),
    (key: string) => key.replace("/research/", "/live/"),
    (key: string) => key.replace("fixture%3Acollection", "other-collection"),
    (key: string) => key.replace("collection/fixture%3Acollection", "account"),
    (key: string) => key.replaceAll("%3A", "%3a"),
    (key: string) => key.replaceAll("%3A", ":"),
    (key: string) => key.replace("/content/", "/../content/"),
    (key: string) => key.replace("/sha256/", "/sha256/%2F"),
    (key: string) => `${key}/`,
    (key: string) => `${key}?token=fixture`,
    (key: string) => `${key}\n`,
    (key: string) => `/${key}`,
    (_key: string) => "x".repeat(1025),
  ])(
    "rejects noncanonical or out-of-scope keys before any provider call",
    async (alter) => {
      const fake = transport();
      const adapter = fake.bind();
      const input = inputFor();
      const key = alter(input.key);
      expect(await adapter.objects.put({ ...input, key })).toEqual(unavailable);
      expect(await adapter.objects.get(key)).toEqual(unavailable);
      expect(await adapter.objectCapabilities.head!(key)).toEqual(unavailable);
      return expect(fake.events).toEqual([]);
    }
  );

  it("rejects missing, inconsistent or executable input metadata before dispatch", async () => {
    const fake = transport();
    const adapter = fake.bind();
    const input = inputFor();
    const getter = vi.fn(() => input.body);
    const inputs = [
      { ...input, checksum: undefined },
      { ...input, checksum: "0".repeat(64) },
      { ...input, contentType: "text/plain" },
      { ...input, body: new Uint8Array() },
      { ...input, body: new Uint8Array(input.body.byteLength).fill(1) },
      { ...input, extra: "unsupported" },
      Object.defineProperty({ ...input }, "body", { get: getter }),
    ];
    for (const invalid of inputs)
      expect(await adapter.objects.put(invalid as PutObjectInput)).toEqual(
        unavailable
      );
    expect(getter).not.toHaveBeenCalled();
    return expect(fake.events).toEqual([]);
  });

  it("rejects shared/subclass byte buffers without reading or copying them", async () => {
    const fake = transport();
    const adapter = fake.bind();
    const input = inputFor();
    class UnsafeBytes extends Uint8Array {}
    const values = [
      new UnsafeBytes(input.body),
      new Uint8Array(new SharedArrayBuffer(input.body.byteLength)),
    ];
    for (const body of values)
      expect(await adapter.objects.put({ ...input, body })).toEqual(
        unavailable
      );
    return expect(fake.events).toEqual([]);
  });

  it("bounds writer and reader budgets before object allocation/download", async () => {
    const fake = await seeded();
    const tight = fake.bind({ maximumBytes: 8 });
    expect(await tight.objects.put(fake.input)).toEqual(unavailable);
    expect(await tight.objects.get(fake.input.key)).toEqual(unavailable);
    expect(fake.get).not.toHaveBeenCalled();
    for (const bound of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_VERTEX_R2_BYTES + 1,
    ]) {
      expect(
        await fake.adapter.objectCapabilities.getBounded!(fake.input.key, bound)
      ).toEqual(unavailable);
    }
    expect(fake.get).not.toHaveBeenCalled();
    return expect(fake.put).toHaveBeenCalledTimes(1);
  });

  it("keeps the manifest limit fixed even when a larger raw content budget is configured", async () => {
    const fake = transport();
    const adapter = fake.bind({ maximumBytes: 2 * 1_048_576 });
    const input = inputFor("x".repeat(1_048_577), "manifest");
    expect(await adapter.objects.put(input)).toEqual(unavailable);
    return expect(fake.events).toEqual([]);
  });

  it("reads exact bounded bytes without aliasing and never uses ETag as SHA-256", async () => {
    const fake = await seeded();
    const result = await fake.adapter.objectCapabilities.getBounded!(
      fake.input.key,
      fake.input.body.byteLength
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("fixture expected object");
    expect(result.value.body).toEqual(fake.input.body);
    expect(result.value.metadata.checksum).toBe(fake.input.checksum);
    result.value.body.fill(0);
    expect(fake.row.bytes).toEqual(fake.input.body);
    return expect(fake.get.mock.calls[0]![1].range.length).toBe(
      fake.input.body.byteLength
    );
  });

  it("accepts the pinned transport's full HEAD range and absent native dictionary fields", async () => {
    const fake = await seeded();
    const native = {
      ...copyObject(fake.row.object),
      httpMetadata: {
        contentType: fake.input.contentType,
        contentLanguage: undefined,
        contentDisposition: undefined,
        contentEncoding: undefined,
        cacheControl: undefined,
        cacheExpiry: undefined,
      },
      range: {
        offset: 0,
        length: fake.input.body.byteLength,
        suffix: undefined,
      },
    };
    fake.head.mockResolvedValue(native);
    fake.get.mockResolvedValue({
      ...native,
      body: fake.stream([fake.input.body]),
    });
    expect(
      (await fake.adapter.objectCapabilities.head(fake.input.key)).status
    ).toBe("ok");
    return expect((await fake.adapter.objects.get(fake.input.key)).status).toBe(
      "ok"
    );
  });

  it("assembles several bounded chunks into the exact immutable bytes", async () => {
    const fake = await seeded();
    const body = fake.stream([
      fake.input.body.slice(0, 3),
      fake.input.body.slice(3, 11),
      fake.input.body.slice(11),
    ]);
    fake.get.mockResolvedValue({
      ...copyObject(fake.row.object),
      range: { offset: 0, length: fake.input.body.byteLength },
      body,
    });
    const result = await fake.adapter.objects.get(fake.input.key);
    expect(result.status).toBe("ok");
    if (result.status !== "ok")
      throw new Error("fixture expected chunked object");
    expect(result.value.body).toEqual(fake.input.body);
    expect(body.locked).toBe(false);
    return expect(fake.cancellations).not.toHaveBeenCalled();
  });

  it.each([65_536, 65_537])(
    "enforces the finite streaming work budget at %i chunks",
    async (count) => {
      const fake = transport();
      const adapter = fake.bind();
      const input = inputFor("x".repeat(count));
      expect((await adapter.objects.put(input)).status).toBe("ok");
      let emitted = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            if (emitted === count) {
              controller.close();
            } else {
              emitted += 1;
              controller.enqueue(new Uint8Array([120]));
            }
          },
          cancel: fake.cancellations,
        },
        { highWaterMark: 0 }
      );
      fake.get.mockResolvedValue({
        ...copyObject(fake.rows.get(input.key)!.object),
        range: { offset: 0, length: count },
        body,
      });
      const result = await adapter.objects.get(input.key);
      expect(result.status).toBe(count === 65_536 ? "ok" : "unavailable");
      expect(emitted).toBe(count);
      expect(body.locked).toBe(false);
      return expect(fake.cancellations).toHaveBeenCalledTimes(
        count === 65_536 ? 0 : 1
      );
    }
  );

  it.each(["truncated", "overrun", "hash", "empty-chunk"])(
    "rejects %s body streams and cancels unfinished reads",
    async (mode) => {
      const fake = await seeded();
      const bytes =
        mode === "truncated"
          ? fake.input.body.slice(1)
          : mode === "overrun"
            ? new Uint8Array(fake.input.body.byteLength + 1)
            : mode === "hash"
              ? new Uint8Array(fake.input.body.byteLength).fill(1)
              : new Uint8Array();
      const body = fake.stream([bytes]);
      fake.get.mockResolvedValue({
        ...copyObject(fake.row.object),
        range: { offset: 0, length: fake.input.body.byteLength },
        body,
      });
      expect(await fake.adapter.objects.get(fake.input.key)).toEqual(
        unavailable
      );
      expect(body.locked).toBe(false);
      if (mode === "overrun" || mode === "empty-chunk")
        return expect(fake.cancellations).toHaveBeenCalledTimes(1);
      return;
    }
  );

  it("body failure is neutral and releases the reader without exposing diagnostics", async () => {
    const fake = await seeded();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) =>
          controller.error(new Error("fixture private provider failure")),
      },
      { highWaterMark: 0 }
    );
    fake.get.mockResolvedValue({
      ...copyObject(fake.row.object),
      range: { offset: 0, length: fake.input.body.byteLength },
      body,
    });
    expect(await fake.adapter.objects.get(fake.input.key)).toEqual(unavailable);
    return expect(body.locked).toBe(false);
  });

  it.each([
    "checksum-missing",
    "checksum-wrong",
    "scope",
    "metadata-extra",
    "metadata-large",
    "http",
    "encoding",
    "partial-range",
    "time",
    "size",
  ])("rejects malformed %s metadata before GET", async (mode) => {
    const fake = await seeded();
    const source = copyObject(fake.row.object);
    const invalid =
      mode === "checksum-missing"
        ? { ...source, checksums: {} }
        : mode === "checksum-wrong"
          ? { ...source, checksums: { sha256: new ArrayBuffer(32) } }
          : mode === "scope"
            ? {
                ...source,
                customMetadata: {
                  ...source.customMetadata,
                  vertexAccountAlias: "other-account",
                },
              }
            : mode === "metadata-extra"
              ? {
                  ...source,
                  customMetadata: {
                    ...source.customMetadata,
                    rightsGranted: "true",
                  },
                }
              : mode === "metadata-large"
                ? {
                    ...source,
                    customMetadata: {
                      ...source.customMetadata,
                      vertexCollectionId: "x".repeat(2049),
                    },
                  }
                : mode === "http"
                  ? { ...source, httpMetadata: { contentType: "text/plain" } }
                  : mode === "encoding"
                    ? {
                        ...source,
                        httpMetadata: {
                          ...source.httpMetadata,
                          contentEncoding: "gzip",
                        },
                      }
                    : mode === "partial-range"
                      ? { ...source, range: { offset: 1, length: source.size } }
                      : mode === "time"
                        ? { ...source, uploaded: new Date(Number.NaN) }
                        : { ...source, size: 0 };
    fake.head.mockResolvedValue(invalid);
    expect(await fake.adapter.objects.get(fake.input.key)).toEqual(unavailable);
    return expect(fake.get).not.toHaveBeenCalled();
  });

  it.each(["version", "etag", "range", "body-missing", "deleted"])(
    "fails closed on %s races/unsupported read semantics",
    async (mode) => {
      const fake = await seeded();
      const body = fake.stream([fake.input.body]);
      const response = {
        ...copyObject(fake.row.object),
        body,
        range: { offset: 0, length: fake.input.body.byteLength },
      };
      const invalid =
        mode === "version"
          ? { ...response, version: "different-upload" }
          : mode === "etag"
            ? { ...response, etag: "different-etag" }
            : mode === "range"
              ? {
                  ...response,
                  range: { offset: 1, length: fake.input.body.byteLength },
                }
              : mode === "body-missing"
                ? copyObject(fake.row.object)
                : null;
      fake.get.mockResolvedValue(invalid);
      expect(await fake.adapter.objects.get(fake.input.key)).toEqual(
        unavailable
      );
      if (mode === "version" || mode === "etag" || mode === "range")
        return expect(fake.cancellations).toHaveBeenCalledTimes(1);
      return;
    }
  );

  it("rejects already-aborted requests without dispatch", async () => {
    const fake = transport();
    const controller = new AbortController();
    controller.abort();
    const adapter = fake.bind({ signal: controller.signal });
    expect(await adapter.objects.put(inputFor())).toEqual(unavailable);
    expect(await adapter.objects.get(inputFor().key)).toEqual(unavailable);
    return expect(fake.events).toEqual([]);
  });

  it("aborted writes remain unknown even when the fake accepted them; retry requires a new request", async () => {
    const fake = transport();
    const controller = new AbortController();
    const nativePut = fake.put.getMockImplementation()!;
    fake.put.mockImplementationOnce(async (key, bytes, options) => {
      const value = await nativePut(key, bytes, options);
      controller.abort();
      return value;
    });
    const input = inputFor();
    expect(
      await fake.bind({ signal: controller.signal }).objects.put(input)
    ).toEqual(unavailable);
    expect(fake.events).toEqual(["put"]);
    expect(fake.uploads()).toBe(1);
    expect((await fake.bind().objects.put(input)).status).toBe("ok");
    return expect(fake.uploads()).toBe(1);
  });

  it("aborting during hashing prevents PUT dispatch and ignores the late digest", async () => {
    const fake = transport();
    const controller = new AbortController();
    const hashing = deferred<ArrayBuffer>();
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(() => hashing.promise);
    try {
      const pending = fake
        .bind({ signal: controller.signal })
        .objects.put(inputFor());
      controller.abort();
      expect(await pending).toEqual(unavailable);
      hashing.resolve(new ArrayBuffer(32));
      await hashing.promise;
      return expect(fake.events).toEqual([]);
    } finally {
      digest.mockRestore();
    }
  });

  it.each(["head", "put"])(
    "deadline-bounds stalled %s and consumes late provider rejection",
    async (method) => {
      vi.useFakeTimers();
      try {
        const fake = transport();
        const started = deferred<void>();
        const delayed = deferred<VertexR2Object | null>();
        const implementation = () => {
          started.resolve();
          return delayed.promise;
        };
        if (method === "head") {
          fake.head.mockImplementationOnce(implementation);
        } else fake.put.mockImplementationOnce(implementation);
        const adapter = fake.bind({ operationTimeoutMs: 10 });
        const pending =
          method === "head"
            ? adapter.objects.get(inputFor().key)
            : adapter.objects.put(inputFor());
        await started.promise;
        await vi.advanceTimersByTimeAsync(11);
        expect(await pending).toEqual(unavailable);
        delayed.reject(new Error("fixture late provider failure"));
        await Promise.resolve();
        expect(fake.head).toHaveBeenCalledTimes(method === "head" ? 1 : 0);
        expect(fake.put).toHaveBeenCalledTimes(method === "put" ? 1 : 0);
        return expect(fake.get).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("cancels a stalled body when the caller aborts", async () => {
    const fake = await seeded();
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          controller.abort();
          return new Promise<void>(() => undefined);
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    fake.get.mockResolvedValue({
      ...copyObject(fake.row.object),
      range: { offset: 0, length: fake.input.body.byteLength },
      body,
    });
    expect(
      await fake.bind({ signal: controller.signal }).objects.get(fake.input.key)
    ).toEqual(unavailable);
    expect(cancel).toHaveBeenCalledTimes(1);
    return expect(body.locked).toBe(false);
  });

  it("cancels a late GET response after abort without returning its bytes", async () => {
    const fake = await seeded();
    const pending = deferred<VertexR2Object | null>();
    const started = deferred<void>();
    const controller = new AbortController();
    const body = fake.stream([fake.input.body]);
    fake.get.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const result = fake
      .bind({ signal: controller.signal })
      .objects.get(fake.input.key);
    await started.promise;
    controller.abort();
    expect(await result).toEqual(unavailable);
    pending.resolve({
      ...copyObject(fake.row.object),
      range: { offset: 0, length: fake.input.body.byteLength },
      body,
    });
    await pending.promise;
    await Promise.resolve();
    return expect(fake.cancellations).toHaveBeenCalledTimes(1);
  });

  it("deadline-bounds stalled reads even when cancel itself never settles", async () => {
    vi.useFakeTimers();
    try {
      const fake = await seeded();
      const started = deferred<void>();
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>(
        {
          pull: () => {
            started.resolve();
            return new Promise<void>(() => undefined);
          },
          cancel,
        },
        { highWaterMark: 0 }
      );
      fake.get.mockResolvedValue({
        ...copyObject(fake.row.object),
        range: { offset: 0, length: fake.input.body.byteLength },
        body,
      });
      const pending = fake
        .bind({ operationTimeoutMs: 10 })
        .objects.get(fake.input.key);
      await started.promise;
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toEqual(unavailable);
      expect(cancel).toHaveBeenCalledTimes(1);
      return expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows an unknown trusted binding without calling bucket methods and catches hostile accessors", () => {
    const fake = transport();
    const binding: unknown = fake.bucket;
    expect(isVertexR2Bucket(binding)).toBe(true);
    if (!isVertexR2Bucket(binding)) throw new Error("fixture expected binding");
    expect(() =>
      createVertexR2ObjectStore({ bucket: binding, scope, collectionId })
    ).not.toThrow();
    const accessor = Object.defineProperty({}, "head", {
      get: () => {
        throw new Error("fixture accessor failure");
      },
    });
    for (const value of [
      undefined,
      null,
      1,
      "bucket-name",
      {},
      { head: 1, get: fake.get, put: fake.put },
      accessor,
    ]) {
      expect(isVertexR2Bucket(value)).toBe(false);
    }
    return expect(fake.events).toEqual([]);
  });

  it("refuses a browser-like runtime and the browser export sentinel", async () => {
    const fake = transport();
    vi.stubGlobal("window", {});
    try {
      expect(() => fake.bind()).toThrow("Vertex R2 configuration unavailable");
      expect(fake.events).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    return await expect(import("./r2/unsupported.ts")).rejects.toThrow(
      "Vertex R2 storage requires a trusted server-side bucket binding"
    );
  });

  return it("rejects missing capabilities and invalid hard budgets instead of choosing a fallback", () => {
    const fake = transport();
    for (const maximumBytes of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_VERTEX_R2_BYTES + 1,
    ]) {
      expect(() => fake.bind({ maximumBytes })).toThrow(
        "Vertex R2 configuration unavailable"
      );
    }
    for (const operationTimeoutMs of [0, -1, 1.5, 120_001]) {
      expect(() => fake.bind({ operationTimeoutMs })).toThrow(
        "Vertex R2 configuration unavailable"
      );
    }
    expect(() =>
      createVertexR2ObjectStore({
        bucket: {} as VertexR2Bucket,
        scope,
        collectionId,
      })
    ).toThrow("Vertex R2 configuration unavailable");
    expect(() => fake.bind({ collectionId: "../unsafe" })).toThrow(
      "Vertex R2 configuration unavailable"
    );
    return expect(fake.events).toEqual([]);
  });
});
