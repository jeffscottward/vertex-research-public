import type {
  DeletedObject,
  ObjectMetadata,
  PutObjectInput,
  StoragePort,
  StorageResult,
  StoredObject,
} from "./index.ts";
import {
  MAX_VERTEX_STORAGE_BYTES,
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
  type VertexStorageScope,
} from "./vertex.ts";
import type { VertexChatCopyCapabilities } from "./chat-copies.ts";
import { createVertexR2ChatCopyCapabilities } from "./r2-chat-copies.ts";
// biome-ignore lint/performance/noBarrelFile: package export ./r2 also exposes the R2 chat-copy capabilities.
export {
  createVertexR2ChatCopyCapabilities,
  type VertexR2ChatCopyOptions,
} from "./r2-chat-copies.ts";

// Structural subset of @cloudflare/workers-types 5.20260722.1 (the optional
// peer of pinned wrangler 4.114.0 / workerd 1.20260722.1). No ambient env import.
// Sources: https://unpkg.com/@cloudflare/workers-types@5.20260722.1/index.d.ts
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
// Conditional PUT returns null; conditional GET may return metadata without a
// body. ETag is an opaque upload validator, NEVER a SHA-256 content identity.
// Pinned Miniflare 4.20260722.0 dist/src/workers/r2/bucket.worker.js
// #head/#get also return a full {offset:0,length:size} range on metadata.
export type VertexR2Range =
  | Readonly<{ offset: number; length?: number | undefined }>
  | Readonly<{ offset?: number | undefined; length: number }>
  | Readonly<{ suffix: number }>;
export type VertexR2Object = Readonly<{
  key: string;
  version: string;
  size: number;
  etag: string;
  uploaded: Date;
  checksums: Readonly<{ sha256?: ArrayBuffer | undefined }>;
  httpMetadata?:
    | Readonly<{
        contentType?: string | undefined;
        cacheControl?: string | undefined;
      }>
    | undefined;
  customMetadata?: Record<string, string> | undefined;
  range?: VertexR2Range | undefined;
  body?: ReadableStream<Uint8Array> | undefined;
}>;
export type VertexR2GetOptions = Readonly<{
  onlyIf: Readonly<{ etagMatches: string }>;
  range: Readonly<{ offset: number; length: number }>;
}>;
export type VertexR2PutOptions = Readonly<{
  onlyIf: Headers;
  sha256: string;
  httpMetadata: Readonly<{
    contentType: string;
    cacheControl?: string | undefined;
  }>;
  customMetadata: Record<string, string>;
}>;
export interface VertexR2Bucket {
  head: (key: string) => Promise<VertexR2Object | null>;
  get: (
    key: string,
    options: VertexR2GetOptions
  ) => Promise<VertexR2Object | null>;
  put: (
    key: string,
    value: Uint8Array,
    options: VertexR2PutOptions
  ) => Promise<VertexR2Object | null>;
}

// Narrow an unknown trusted Worker binding without invoking any bucket method.
// Surface validation cannot establish provider provenance or grant authority:
// callers must only use their explicitly configured R2 binding, never a client
// supplied object. Actual method results are validated on every operation.
export const isVertexR2Bucket = (value: unknown): value is VertexR2Bucket => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      "head" in value &&
      typeof value.head === "function" &&
      "get" in value &&
      typeof value.get === "function" &&
      "put" in value &&
      typeof value.put === "function"
    );
  } catch {
    return false;
  }
};

export type VertexR2ObjectStoreOptions = Readonly<{
  bucket: VertexR2Bucket;
  scope: VertexStorageScope;
  // null is exactly account scope, not permission to traverse collections.
  collectionId: string | null;
  maximumBytes?: number | undefined;
  operationTimeoutMs?: number | undefined;
  // Construct per request to propagate request cancellation. R2 binding calls
  // do NOT accept AbortSignal: aborting a dispatched PUT has unknown acceptance.
  signal?: AbortSignal | undefined;
  // Explicit optional private-copy profile; research ACCOUNT scope only.
  // Presence is not inventory, consent, retention or backend qualification.
  chatCopyProfileSha256?: string | undefined;
}>;
export type VertexR2ObjectStore = Readonly<{
  objects: StoragePort;
  objectCapabilities: Readonly<{
    putIfAbsent: NonNullable<VertexObjectCapabilities["putIfAbsent"]>;
    head: NonNullable<VertexObjectCapabilities["head"]>;
    getBounded: NonNullable<VertexObjectCapabilities["getBounded"]>;
  }>;
  chatCopyCapabilities?: VertexChatCopyCapabilities | undefined;
}>;

export const MAX_VERTEX_R2_BYTES = 16 * 1_048_576;
const MAX_METADATA_BYTES = 2048;
const MAX_STREAM_CHUNKS = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const failure = (): Error => new Error("Vertex R2 operation unavailable");
const unavailable = (): StorageResult<never> =>
  Object.freeze({ status: "unavailable", state: "unconfigured" });
const missing = (): StorageResult<never> =>
  Object.freeze({ status: "not-found" });
const success = <T>(value: T): StorageResult<T> =>
  Object.freeze({ status: "ok", value });
const integer = (value: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= maximum;
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const plainData = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw failure();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16 || keys.some((key) => typeof key !== "string"))
    throw failure();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!(field && Object.hasOwn(field, "value") && field.enumerable))
      throw failure();
    Object.defineProperty(result, key, {
      value: field.value,
      enumerable: true,
    });
  }
  return result;
};

const byteSnapshot = (value: Uint8Array, maximum: number): Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    Object.hasOwn(value, "buffer") ||
    Object.hasOwn(value, "byteLength") ||
    Object.hasOwn(value, "byteOffset") ||
    !(value.buffer instanceof ArrayBuffer) ||
    !integer(value.byteLength, maximum)
  )
    throw failure();
  return new Uint8Array(value);
};

const discardBody = (object: VertexR2Object | null): void => {
  // Cleanup is deliberately not awaited: a broken provider cancel() must not
  // prevent a deadline/abort from settling. Rejections are always consumed.
  try {
    const body = object?.body;
    if (body) void body.cancel().catch(() => undefined);
  } catch {
    // A locked/malformed stream is already unusable; never expose its error.
    return;
  }
};

type Operation = Readonly<{
  signal: AbortSignal;
  wait: <T>(work: () => Promise<T>, discard?: (value: T) => void) => Promise<T>;
}>;

const operation = async <T>(
  signal: AbortSignal | undefined,
  timeout: number,
  work: (op: Operation) => Promise<StorageResult<T>>
): Promise<StorageResult<T>> => {
  if (signal?.aborted) return unavailable();
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const timer = setTimeout(abort, timeout);
  signal?.addEventListener("abort", abort, { once: true });
  const wait = <V>(
    start: () => Promise<V>,
    discard?: (value: V) => void
  ): Promise<V> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const stop = (): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", stop);
        reject(failure());
      };
      if (controller.signal.aborted) {
        stop();
        return;
      }
      controller.signal.addEventListener("abort", stop, { once: true });
      // Dispatch synchronously after the abort check. A failed/aborted PUT is not
      // followed by a probe or replay: only the caller can choose to retry it.
      let pending: Promise<V>;
      try {
        pending = start();
      } catch {
        stop();
        return;
      }
      const settle = (value: V): void => {
        if (settled) {
          try {
            discard?.(value);
          } catch {
            return;
          }
          return;
        }
        settled = true;
        controller.signal.removeEventListener("abort", stop);
        resolve(value);
      };
      return void pending.then(settle, () => stop());
    });
  try {
    if (signal?.aborted) controller.abort();
    const result = await work({ signal: controller.signal, wait });
    return controller.signal.aborted ? unavailable() : result;
  } catch {
    // Existing StorageResult has no collision/uncertain-acceptance variant.
    // Preserve its neutral union instead of leaking keys/provider diagnostics.
    return unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

type KeyIdentity = Readonly<{
  key: string;
  kind: "manifest" | "content";
  sha256: string;
  limit: number;
  contentType: string;
}>;
type ObjectIdentity = Readonly<{
  metadata: ObjectMetadata;
  version: string;
  etag: string;
}>;

// No credentials, bucket/account discovery, list, delete, presigning or memory
// fallback. Raw object presence is NOT authorization. The existing service/DB
// must still enforce current rights, scoped catalog visibility and review links.
export const createVertexR2ObjectStore = (
  suppliedOptions: VertexR2ObjectStoreOptions
): VertexR2ObjectStore => {
  let options = suppliedOptions;
  let bucket: VertexR2Bucket;
  let scope: VertexStorageScope;
  let collectionId: string | null;
  let maximumBytes: number;
  let timeout: number;
  let signal: AbortSignal | undefined;
  let chatCopyCapabilities: VertexChatCopyCapabilities | undefined;
  try {
    // This entry point is server-only; package/browser wiring remains explicit.
    if ("window" in globalThis) throw failure();
    const copyProfile = Object.getOwnPropertyDescriptor(
      options,
      "chatCopyProfileSha256"
    );
    if (
      "chatCopyProfileSha256" in options &&
      !(
        copyProfile &&
        Object.hasOwn(copyProfile, "value") &&
        copyProfile.enumerable
      )
    )
      throw failure();
    if (copyProfile?.value !== undefined) {
      const captured = plainData(options);
      if (
        Object.keys(captured).some(
          (name) =>
            ![
              "bucket",
              "scope",
              "collectionId",
              "maximumBytes",
              "operationTimeoutMs",
              "signal",
              "chatCopyProfileSha256",
            ].includes(name)
        )
      )
        throw failure();
      options = captured as unknown as VertexR2ObjectStoreOptions;
    }
    bucket = options.bucket;
    if (!isVertexR2Bucket(bucket)) throw failure();
    const suppliedScope = plainData(options.scope);
    if (
      Object.keys(suppliedScope).sort().join(",") !== "accountAlias,environment"
    )
      throw failure();
    scope = Object.freeze({
      accountAlias: suppliedScope["accountAlias"] as string,
      environment: suppliedScope[
        "environment"
      ] as VertexStorageScope["environment"],
    });
    collectionId = options.collectionId;
    vertexQualifiedObjectKey(scope, collectionId, "content", "0".repeat(64));
    maximumBytes =
      options.maximumBytes === undefined
        ? MAX_VERTEX_STORAGE_BYTES
        : options.maximumBytes;
    timeout =
      options.operationTimeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : options.operationTimeoutMs;
    if (
      !(integer(maximumBytes, MAX_VERTEX_R2_BYTES) && integer(timeout, 120_000))
    )
      throw failure();
    signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw failure();
    if (options.chatCopyProfileSha256 !== undefined) {
      if (collectionId !== null || scope.environment !== "research")
        throw failure();
      chatCopyCapabilities = createVertexR2ChatCopyCapabilities({
        bucket,
        scope: { accountAlias: scope.accountAlias, environment: "research" },
        storageProfileSha256: options.chatCopyProfileSha256,
        maximumBytes,
        operationTimeoutMs: timeout,
        signal,
      });
    }
  } catch {
    throw new Error("Vertex R2 configuration unavailable");
  }

  const identify = (key: string, bound = maximumBytes): KeyIdentity => {
    if (
      typeof key !== "string" ||
      key.length > 1024 ||
      !integer(bound, maximumBytes)
    )
      throw failure();
    const match = /\/(manifest|content)\/sha256\/([0-9a-f]{64})$/.exec(key);
    if (!match) throw failure();
    const [, kindText, sha256] = match;
    if (
      (kindText !== "manifest" && kindText !== "content") ||
      sha256 === undefined
    )
      throw failure();
    const kind = kindText;
    if (key !== vertexQualifiedObjectKey(scope, collectionId, kind, sha256))
      throw failure();
    return Object.freeze({
      key,
      kind,
      sha256,
      limit: Math.min(
        bound,
        kind === "manifest" ? MAX_VERTEX_STORAGE_BYTES : maximumBytes
      ),
      contentType:
        kind === "manifest" ? "application/json" : "application/octet-stream",
    });
  };

  const customMetadata = (
    key: KeyIdentity,
    size: number
  ): Record<string, string> => ({
    vertexSchema: "1",
    vertexAccountAlias: scope.accountAlias,
    vertexEnvironment: scope.environment,
    vertexCollectionKind: collectionId === null ? "account" : "collection",
    vertexCollectionId: collectionId ?? "",
    vertexObjectKind: key.kind,
    vertexSha256: key.sha256,
    vertexByteLength: String(size),
  });

  const inspect = (
    source: VertexR2Object,
    key: KeyIdentity,
    ranged: boolean
  ): ObjectIdentity => {
    if (!ranged && source.body !== undefined) {
      discardBody(source);
      throw failure();
    }
    const size = source.size;
    if (source.key !== key.key || !integer(size, key.limit)) throw failure();
    const http = plainData(source.httpMetadata);
    const optionalHttp = [
      "contentLanguage",
      "contentDisposition",
      "contentEncoding",
      "cacheControl",
      "cacheExpiry",
    ];
    if (
      http["contentType"] !== key.contentType ||
      Object.keys(http).some((name) => {
        return (
          name !== "contentType" &&
          (!optionalHttp.includes(name) || http[name] !== undefined)
        );
      })
    )
      throw failure();
    const custom = plainData(source.customMetadata);
    const expected = customMetadata(key, size);
    if (
      Object.keys(custom).sort().join(",") !==
      Object.keys(expected).sort().join(",")
    )
      throw failure();
    let metadataBytes = 0;
    for (const [name, value] of Object.entries(custom)) {
      if (
        typeof value !== "string" ||
        value.length > 1024 ||
        value !== expected[name]
      )
        throw failure();
      metadataBytes +=
        new TextEncoder().encode(name).byteLength +
        new TextEncoder().encode(value).byteLength;
    }
    if (metadataBytes > MAX_METADATA_BYTES) throw failure();
    const checksum = source.checksums?.sha256;
    if (
      !(checksum instanceof ArrayBuffer) ||
      checksum.byteLength !== 32 ||
      hex(new Uint8Array(checksum)) !== key.sha256
    )
      throw failure();
    const version = source.version;
    const etag = source.etag;
    if (
      typeof version !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(version) ||
      typeof etag !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(etag)
    )
      throw failure();
    const milliseconds = Date.prototype.getTime.call(source.uploaded);
    if (!Number.isFinite(milliseconds)) throw failure();
    const uploaded = new Date(milliseconds).toISOString();
    // HEAD may also report the default full-object range. Optional undefined
    // fields in native dictionaries mean absent, not an unsupported transform.
    if (ranged || source.range !== undefined) {
      const range = plainData(source.range);
      if (
        range["offset"] !== 0 ||
        range["length"] !== size ||
        range["suffix"] !== undefined ||
        Object.keys(range).some(
          (name) => !["offset", "length", "suffix"].includes(name)
        )
      )
        throw failure();
    }
    return Object.freeze({
      metadata: Object.freeze({
        key: key.key,
        size,
        contentType: key.contentType,
        checksum: key.sha256,
        createdAt: uploaded,
        updatedAt: uploaded,
      }),
      version,
      etag,
    });
  };

  const digestMatches = async (
    op: Operation,
    body: Uint8Array,
    expected: string
  ): Promise<void> => {
    const digest = await op.wait(() =>
      crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>)
    );
    if (hex(new Uint8Array(digest)) !== expected) throw failure();
  };

  const load = async (
    op: Operation,
    key: KeyIdentity
  ): Promise<StorageResult<StoredObject>> => {
    const found = await op.wait(() => bucket.head(key.key), discardBody);
    if (found === null) return missing();
    const before = inspect(found, key, false);
    // First reject excessive size without downloading it, then request only a
    // bounded whole-object range under an opaque ETag condition. Version and
    // full metadata are checked again to catch equal-ETag replacement races.
    const response = await op.wait(
      () =>
        bucket.get(key.key, {
          onlyIf: { etagMatches: before.etag },
          range: { offset: 0, length: before.metadata.size },
        }),
      discardBody
    );
    if (response === null) return unavailable();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    try {
      const after = inspect(response, key, true);
      if (
        after.version !== before.version ||
        after.etag !== before.etag ||
        after.metadata.size !== before.metadata.size ||
        after.metadata.createdAt !== before.metadata.createdAt
      )
        throw failure();
      const body = response.body;
      if (!body || typeof body.getReader !== "function") throw failure();
      reader = body.getReader();
      const activeReader = reader;
      // Single bounded allocation, no arrayBuffer(), concatenation, growing
      // chunks array, or copy of a provider chunk before its length is checked.
      const output = new Uint8Array(before.metadata.size);
      let used = 0;
      let chunks = 0;
      while (true) {
        const chunk = await op.wait(() => activeReader.read());
        if (chunk.done) {
          if (chunk.value !== undefined || used !== output.byteLength)
            throw failure();
          completed = true;
          break;
        }
        chunks += 1;
        const bytes = chunk.value;
        if (
          chunks > MAX_STREAM_CHUNKS ||
          !(bytes instanceof Uint8Array) ||
          Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
          Object.hasOwn(bytes, "byteLength") ||
          Object.hasOwn(bytes, "buffer") ||
          Object.hasOwn(bytes, "byteOffset") ||
          !(bytes.buffer instanceof ArrayBuffer) ||
          bytes.byteLength === 0 ||
          bytes.byteLength > output.byteLength - used
        )
          throw failure();
        output.set(bytes, used);
        used += bytes.byteLength;
      }
      await digestMatches(op, output, key.sha256);
      return success(Object.freeze({ metadata: after.metadata, body: output }));
    } finally {
      if (reader) {
        if (!completed) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            // Cancellation failure cannot turn an invalid read into success.
            completed = false;
          }
        }
        try {
          reader.releaseLock();
        } catch {
          // A pending read may outlive abort; its promise is already observed.
          completed = false;
        }
      } else {
        discardBody(response);
      }
    }
  };

  const head = (key: string): Promise<StorageResult<ObjectMetadata>> =>
    operation(signal, timeout, async (op) => {
      const identity = identify(key);
      const object = await op.wait(
        () => bucket.head(identity.key),
        discardBody
      );
      if (object === null) return missing();
      return success(inspect(object, identity, false).metadata);
    });
  const getBounded = (
    key: string,
    bound: number
  ): Promise<StorageResult<StoredObject>> =>
    operation(signal, timeout, (op) => {
      if (!integer(bound, maximumBytes)) throw failure();
      return load(op, identify(key, bound));
    });
  const putIfAbsent = (
    input: PutObjectInput
  ): Promise<StorageResult<ObjectMetadata>> =>
    operation(signal, timeout, async (op) => {
      const supplied = plainData(input);
      if (
        Object.keys(supplied).sort().join(",") !==
        "body,checksum,contentType,key"
      )
        throw failure();
      const key = identify(supplied["key"] as string);
      if (
        supplied["checksum"] !== key.sha256 ||
        supplied["contentType"] !== key.contentType
      )
        throw failure();
      const bytes = byteSnapshot(supplied["body"] as Uint8Array, key.limit);
      await digestMatches(op, bytes, key.sha256);
      // Atomic server-side create. Never emulate with HEAD/GET followed by PUT.
      // SHA-256 is validated by R2 independently of ETag, not inferred from it.
      const created = await op.wait(
        () =>
          bucket.put(key.key, bytes, {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            sha256: key.sha256,
            httpMetadata: { contentType: key.contentType },
            customMetadata: customMetadata(key, bytes.byteLength),
          }),
        discardBody
      );
      if (created !== null) {
        const metadata = inspect(created, key, false).metadata;
        if (metadata.size !== bytes.byteLength) throw failure();
        return success(metadata);
      }
      // A known precondition miss is an idempotent success ONLY after a complete,
      // bounded read proves identical bytes and provenance. Unknown acceptance,
      // malformed metadata and collisions remain unavailable, never overwritten.
      const existing = await load(op, identify(key.key, bytes.byteLength));
      if (
        existing.status !== "ok" ||
        existing.value.body.byteLength !== bytes.byteLength ||
        !bytes.every((byte, index) => byte === existing.value.body[index])
      )
        return unavailable();
      return success(existing.value.metadata);
    });
  return Object.freeze({
    objects: Object.freeze({
      put: putIfAbsent,
      get: (key: string) => getBounded(key, maximumBytes),
      delete: async (_key: string): Promise<StorageResult<DeletedObject>> =>
        Object.freeze({ status: "unavailable", state: "disabled" }),
    }),
    objectCapabilities: Object.freeze({ putIfAbsent, head, getBounded }),
    ...(chatCopyCapabilities === undefined ? {} : { chatCopyCapabilities }),
  });
};
