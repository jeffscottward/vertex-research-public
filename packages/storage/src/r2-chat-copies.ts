import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  MAX_VERTEX_CHAT_COPY_BYTES,
  MAX_VERTEX_CHAT_COPY_MARKER_BYTES,
  VERTEX_CHAT_COPY_PROFILE,
  VERTEX_CHAT_COPY_FENCE_PROFILE,
  snapshotVertexChatCopyBinding,
  vertexChatCopyKey,
  type VertexChatCopyBinding,
  type VertexChatCopyCapabilities,
  type VertexChatCopyCreation,
  type VertexChatCopyFailure,
  type VertexChatCopyFence,
  type VertexChatCopyInspection,
  type VertexChatCopyProof,
  type VertexChatCopyRead,
  type VertexChatCopyScope,
} from "./chat-copies.ts";
import type {
  VertexR2Bucket,
  VertexR2Object,
  VertexR2PutOptions,
} from "./r2.ts";

export type VertexR2ChatCopyOptions = Readonly<{
  bucket: VertexR2Bucket;
  scope: VertexChatCopyScope;
  storageProfileSha256: string;
  maximumBytes: number;
  operationTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}>;
const MAX_METADATA_BYTES = 2048;
const MAX_STREAM_CHUNKS = 65_536;
const MAX_CONDITIONAL_REPLACEMENTS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
class CopyFailure extends Error {
  readonly code: "invalid" | "conflict" | "backend";
  constructor(code: "invalid" | "conflict" | "backend") {
    super("Vertex chat copy operation unavailable");
    this.code = code;
  }
}
const fail = (code: CopyFailure["code"]): never => {
  throw new CopyFailure(code);
};
const positive = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= maximum;
const exact = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const record = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16 || keys.some((key) => typeof key !== "string"))
    return fail("invalid");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !(
        descriptor &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable
      )
    )
      return fail("invalid");
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return result;
};
const fields = (
  data: Record<string, unknown>,
  names: readonly string[]
): boolean =>
  Object.keys(data).length === names.length &&
  names.every((name) => Object.hasOwn(data, name));
// Captured once at module load; a missing intrinsic accessor is a broken runtime.
const intrinsicGetter = (
  target: object,
  name: string
): ((this: unknown) => unknown) => {
  const getter = Object.getOwnPropertyDescriptor(target, name)?.get;
  if (getter === undefined) throw new Error(`Missing intrinsic ${name}`);
  return getter;
};
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = intrinsicGetter(typedArrayPrototype, "byteLength");
const byteOffsetOf = intrinsicGetter(typedArrayPrototype, "byteOffset");
const bufferOf = intrinsicGetter(typedArrayPrototype, "buffer");
const arrayBufferLength = intrinsicGetter(ArrayBuffer.prototype, "byteLength");
const abortedOf = intrinsicGetter(AbortSignal.prototype, "aborted");
const requiredMetadata = (value: string | undefined): string =>
  value === undefined ? fail("conflict") : value;

// Native internal-slot access also rejects proxied views. Do not consult caller
// getters/iterators or copy a provider chunk before checking its native length.
const byteSnapshot = (value: unknown, maximum: number): Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    ["buffer", "byteLength", "byteOffset", "length", Symbol.iterator].some(
      (key) => Object.hasOwn(value, key)
    )
  )
    return fail("invalid");
  const buffer = bufferOf.call(value) as ArrayBuffer;
  const length = byteLengthOf.call(value) as number;
  const offset = byteOffsetOf.call(value) as number;
  if (
    !(buffer instanceof ArrayBuffer) ||
    Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
    !positive(length, maximum)
  )
    return fail("invalid");
  arrayBufferLength.call(buffer);
  const bytes = new Uint8Array(length);
  bytes.set(new Uint8Array(buffer, offset, length));
  return bytes;
};
const discardBody = (source: VertexR2Object | null): void => {
  try {
    const body = source?.body;
    if (body) void body.cancel().catch(() => undefined);
  } catch {
    // Broken/locked late streams cannot prevent the deadline from settling.
    return;
  }
};

interface Operation {
  pendingMutation: boolean;
  reason: "cancelled" | "timeout" | "backend";
  check: () => void;
  wait: <T>(
    start: () => Promise<T>,
    discard?: (value: T) => void
  ) => Promise<T>;
}
type Identity = Readonly<{
  binding: VertexChatCopyBinding;
  key: string;
  bindingSha256: string;
  marker: Readonly<{ bytes: Uint8Array; sha256: string }>;
}>;
const failureResult = (
  op: Operation,
  error: unknown
): VertexChatCopyFailure => {
  if (op.reason !== "backend")
    return Object.freeze({ status: "unavailable", reason: op.reason });
  if (error instanceof CopyFailure && error.code !== "backend")
    return Object.freeze({ status: error.code });
  return Object.freeze({ status: "unavailable", reason: "backend" });
};
const mutationFailure = (
  op: Operation,
  error: unknown
): VertexChatCopyFailure | Readonly<{ status: "unknown" }> => {
  return op.pendingMutation
    ? Object.freeze({ status: "unknown" })
    : failureResult(op, error);
};

// R2 Workers documents PUT onlyIf Headers, null on a failed condition, HEAD and
// conditional ranged GET. ETag is opaque; upload version is not version-history
// access. Direct same-key writes require qualified exclusive writers, no marker
// deletion/overwrite/lifecycle expiry, and no cached/public read path. See:
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
// https://developers.cloudflare.com/r2/reference/consistency/
// https://developers.cloudflare.com/r2/platform/limits/
// This primitive proves neither durable inventory/current authority nor deployed
// cleanup readiness. No provider-media, backup, export, RAM or model erasure claim.
export const createVertexR2ChatCopyCapabilities = (
  options: VertexR2ChatCopyOptions
): VertexChatCopyCapabilities => {
  let bucket: VertexR2Bucket;
  let scope: VertexChatCopyScope;
  let storageProfileSha256: string;
  let maximumBytes: number;
  let timeout: number;
  let signal: AbortSignal | undefined;
  try {
    if ("window" in globalThis) return fail("invalid");
    const supplied = record(options);
    const names = [
      "bucket",
      "scope",
      "storageProfileSha256",
      "maximumBytes",
      "operationTimeoutMs",
      "signal",
    ];
    if (Object.keys(supplied).some((name) => !names.includes(name)))
      return fail("invalid");
    const suppliedScope = record(supplied["scope"]);
    if (
      !fields(suppliedScope, ["accountAlias", "environment"]) ||
      suppliedScope["environment"] !== "research" ||
      !exact(
        suppliedScope["accountAlias"],
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
      ) ||
      !exact(supplied["storageProfileSha256"], /^[0-9a-f]{64}$/) ||
      !positive(supplied["maximumBytes"], MAX_VERTEX_CHAT_COPY_BYTES)
    )
      return fail("invalid");
    scope = Object.freeze({
      accountAlias: suppliedScope["accountAlias"],
      environment: "research",
    });
    storageProfileSha256 = supplied["storageProfileSha256"];
    maximumBytes = supplied["maximumBytes"];
    const configuredTimeout =
      supplied["operationTimeoutMs"] === undefined
        ? DEFAULT_TIMEOUT_MS
        : supplied["operationTimeoutMs"];
    if (!positive(configuredTimeout, 120_000)) return fail("invalid");
    timeout = configuredTimeout;
    signal = supplied["signal"] as AbortSignal | undefined;
    if (signal !== undefined) {
      if (!(signal instanceof AbortSignal)) return fail("invalid");
      abortedOf.call(signal);
    }
    const native = supplied["bucket"] as VertexR2Bucket;
    if (
      !native ||
      typeof native.head !== "function" ||
      typeof native.get !== "function" ||
      typeof native.put !== "function"
    )
      return fail("invalid");
    // Capture the trusted configured binding methods; caller mutation of its
    // method properties after construction cannot redirect an in-flight call.
    bucket = Object.freeze({
      head: native.head.bind(native),
      get: native.get.bind(native),
      put: native.put.bind(native),
    });
  } catch {
    throw new Error("Vertex R2 chat copy configuration unavailable");
  }

  const run = async <R>(
    work: (op: Operation) => Promise<R>,
    failed: (op: Operation, error: unknown) => R
  ): Promise<R> => {
    const controller = new AbortController();
    const op: Operation = {
      pendingMutation: false,
      reason: "backend",
      check: (): void => {
        if (controller.signal.aborted) fail("backend");
      },
      wait: <T>(
        start: () => Promise<T>,
        discard?: (value: T) => void
      ): Promise<T> =>
        new Promise((resolve, reject) => {
          let settled = false;
          const stop = (): void => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", stop);
            reject(new CopyFailure("backend"));
          };
          if (controller.signal.aborted) {
            stop();
            return;
          }
          controller.signal.addEventListener("abort", stop, { once: true });
          const settle = (value: T): void => {
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
          try {
            // Promise.resolve also consumes non-native thenables and late errors.
            return void Promise.resolve(start()).then(settle, stop);
          } catch {
            return stop();
          }
        }),
    };
    const cancel = (): void => {
      if (!controller.signal.aborted) op.reason = "cancelled";
      controller.abort();
    };
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) op.reason = "timeout";
      return controller.abort();
    }, timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      op.check();
      return await work(op);
    } catch (error) {
      return failed(op, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  };

  const capture = (value: VertexChatCopyBinding): VertexChatCopyBinding => {
    try {
      const binding = snapshotVertexChatCopyBinding(value);
      if (
        binding.scope.accountAlias !== scope.accountAlias ||
        binding.storageProfileSha256 !== storageProfileSha256 ||
        binding.maximumBytes > maximumBytes
      )
        return fail("invalid");
      return binding;
    } catch {
      return fail("invalid");
    }
  };

  const identify = async (
    op: Operation,
    binding: VertexChatCopyBinding
  ): Promise<Identity> => {
    const { content: _content, ...base } = binding;
    const bindingSha256 = await op.wait(() => hashArtifact(base));
    const bytes = new TextEncoder().encode(
      canonicalArtifactJson({
        profile: VERTEX_CHAT_COPY_FENCE_PROFILE,
        bindingSha256,
      })
    );
    if (!positive(bytes.byteLength, MAX_VERTEX_CHAT_COPY_MARKER_BYTES))
      return fail("invalid");
    const sha256 = await op.wait(() => hashArtifact(bytes));
    return Object.freeze({
      binding,
      key: vertexChatCopyKey(binding),
      bindingSha256,
      marker: Object.freeze({ bytes, sha256 }),
    });
  };

  const metadata = (
    identity: Identity,
    state: "live" | "fenced"
  ): Record<string, string> => {
    const content =
      state === "fenced"
        ? {
            sha256: identity.marker.sha256,
            byteLength: identity.marker.bytes.byteLength,
          }
        : identity.binding.content;
    if (!content) return fail("conflict");
    return {
      vertexChatCopyProfile: VERTEX_CHAT_COPY_PROFILE,
      vertexChatCopyState: state,
      vertexBindingSha256: identity.bindingSha256,
      vertexReservationSha256: identity.binding.reservationSha256,
      vertexStorageProfileSha256: identity.binding.storageProfileSha256,
      vertexSha256: content.sha256,
      vertexByteLength: String(content.byteLength),
    };
  };

  const inspect = (
    source: VertexR2Object,
    identity: Identity,
    ranged: boolean
  ): VertexChatCopyProof => {
    try {
      if (
        !source ||
        typeof source !== "object" ||
        (!ranged && source.body !== undefined)
      )
        return fail("conflict");
      const custom = record(source.customMetadata);
      const state = custom["vertexChatCopyState"];
      if (state !== "live" && state !== "fenced") return fail("conflict");
      const expected = metadata(identity, state);
      if (!fields(custom, Object.keys(expected))) return fail("conflict");
      let metadataBytes = 0;
      for (const [name, value] of Object.entries(custom)) {
        if (
          typeof value !== "string" ||
          value.length > 1024 ||
          value !== expected[name]
        )
          return fail("conflict");
        metadataBytes +=
          new TextEncoder().encode(name).byteLength +
          new TextEncoder().encode(value).byteLength;
      }
      if (metadataBytes > MAX_METADATA_BYTES) return fail("conflict");
      const size = source.size;
      const bound =
        state === "fenced"
          ? MAX_VERTEX_CHAT_COPY_MARKER_BYTES
          : identity.binding.maximumBytes;
      if (
        source.key !== identity.key ||
        !positive(size, bound) ||
        String(size) !== expected["vertexByteLength"]
      )
        return fail("conflict");
      const http = record(source.httpMetadata);
      const optionalHttp = [
        "contentLanguage",
        "contentDisposition",
        "contentEncoding",
        "cacheExpiry",
      ];
      if (
        http["contentType"] !==
          (state === "fenced"
            ? "application/json"
            : "application/octet-stream") ||
        http["cacheControl"] !== "no-store" ||
        Object.keys(http).some(
          (name) =>
            !["contentType", "cacheControl"].includes(name) &&
            (!optionalHttp.includes(name) || http[name] !== undefined)
        )
      )
        return fail("conflict");
      const checksum = source.checksums?.sha256;
      if (
        !(checksum instanceof ArrayBuffer) ||
        Object.getPrototypeOf(checksum) !== ArrayBuffer.prototype ||
        arrayBufferLength.call(checksum) !== 32 ||
        hex(new Uint8Array(checksum)) !== expected["vertexSha256"]
      )
        return fail("conflict");
      const etag = source.etag;
      const version = source.version;
      // Raw validators must not become wildcard, list, weak or quoted header
      // syntax. The supported R2 opaque token alphabet is deliberately narrow.
      if (
        !(
          exact(etag, /^[A-Za-z0-9_.:-]{1,256}$/) &&
          exact(version, /^[\x21-\x7e]{1,256}$/)
        )
      )
        return fail("conflict");
      const time = Date.prototype.getTime.call(source.uploaded);
      if (!Number.isFinite(time)) return fail("conflict");
      const uploadedAt = new Date(time).toISOString();
      if (ranged || source.range !== undefined) {
        const range = record(source.range);
        if (
          range["offset"] !== 0 ||
          range["length"] !== size ||
          range["suffix"] !== undefined ||
          Object.keys(range).some(
            (name) => !["offset", "length", "suffix"].includes(name)
          )
        )
          return fail("conflict");
      }
      return Object.freeze({
        key: identity.key,
        state,
        bindingSha256: identity.bindingSha256,
        reservationSha256: identity.binding.reservationSha256,
        storageProfileSha256,
        sha256: requiredMetadata(expected["vertexSha256"]),
        byteLength: size,
        etag,
        version,
        uploadedAt,
      });
    } catch {
      return fail("conflict");
    }
  };

  const observe = async (
    op: Operation,
    identity: Identity
  ): Promise<VertexChatCopyProof | null> => {
    const source = await op.wait(() => bucket.head(identity.key), discardBody);
    if (source === null) return null;
    try {
      return inspect(source, identity, false);
    } finally {
      discardBody(source);
    }
  };

  const load = async (
    op: Operation,
    identity: Identity,
    before: VertexChatCopyProof
  ): Promise<Uint8Array> => {
    const source = await op.wait(
      () =>
        bucket.get(identity.key, {
          onlyIf: { etagMatches: before.etag },
          range: { offset: 0, length: before.byteLength },
        }),
      discardBody
    );
    if (source === null) return fail("backend");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    try {
      const after = inspect(source, identity, true);
      if (
        after.state !== "live" ||
        after.etag !== before.etag ||
        after.version !== before.version ||
        after.uploadedAt !== before.uploadedAt ||
        after.sha256 !== before.sha256 ||
        after.byteLength !== before.byteLength
      )
        return fail("conflict");
      if (!source.body || typeof source.body.getReader !== "function")
        return fail("backend");
      reader = source.body.getReader();
      const active = reader;
      const output = new Uint8Array(before.byteLength);
      let used = 0;
      let chunks = 0;
      while (true) {
        const chunk = await op.wait(() => active.read());
        if (chunk.done) {
          if (chunk.value !== undefined || used !== output.byteLength)
            return fail("conflict");
          completed = true;
          break;
        }
        chunks += 1;
        if (chunks > MAX_STREAM_CHUNKS) return fail("conflict");
        let bytes: Uint8Array;
        try {
          bytes = byteSnapshot(chunk.value, output.byteLength - used);
        } catch {
          return fail("conflict");
        }
        output.set(bytes, used);
        used += bytes.byteLength;
      }
      if ((await op.wait(() => hashArtifact(output))) !== before.sha256)
        return fail("conflict");
      op.check();
      return output;
    } finally {
      if (reader) {
        if (!completed) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            // Cancellation is not backend rollback or proof of non-disclosure.
            completed = false;
          }
        }
        try {
          reader.releaseLock();
        } catch {
          // The pending read's rejection remains consumed by op.wait.
          completed = false;
        }
      } else {
        discardBody(source);
      }
    }
  };

  const put = async (
    op: Operation,
    identity: Identity,
    state: "live" | "fenced",
    bytes: Uint8Array,
    etag?: string
  ): Promise<VertexChatCopyProof | null> => {
    const customMetadata = metadata(identity, state);
    const putOptions: VertexR2PutOptions = {
      onlyIf: new Headers(
        etag === undefined
          ? { "If-None-Match": "*" }
          : { "If-Match": `"${etag}"` }
      ),
      sha256: requiredMetadata(customMetadata["vertexSha256"]),
      httpMetadata: {
        contentType:
          state === "fenced" ? "application/json" : "application/octet-stream",
        cacheControl: "no-store",
      },
      customMetadata,
    };
    const source = await op.wait(() => {
      // Set immediately BEFORE calling the provider: sync throw, timeout, lost
      // acknowledgement, 429 or malformed returned metadata are all unknown.
      op.pendingMutation = true;
      return bucket.put(identity.key, bytes, putOptions);
    }, discardBody);
    if (source === null) {
      op.pendingMutation = false;
      return null;
    }
    try {
      const proof = inspect(source, identity, false);
      if (proof.state !== state) return fail("conflict");
      op.pendingMutation = false;
      return proof;
    } finally {
      discardBody(source);
    }
  };

  const inspectCopy = (
    value: VertexChatCopyBinding
  ): Promise<VertexChatCopyInspection> =>
    run<VertexChatCopyInspection>(async (op) => {
      const binding = capture(value);
      const identity = await identify(op, binding);
      const proof = await observe(op, identity);
      if (!proof) return Object.freeze({ status: "missing" });
      return Object.freeze({ status: proof.state, proof });
    }, failureResult);

  const readCopy = (
    value: VertexChatCopyBinding
  ): Promise<VertexChatCopyRead> =>
    run<VertexChatCopyRead>(async (op) => {
      const binding = capture(value);
      const identity = await identify(op, binding);
      const proof = await observe(op, identity);
      if (!proof) return Object.freeze({ status: "missing" });
      if (proof.state === "fenced")
        return Object.freeze({ status: "fenced", proof });
      const bytes = await load(op, identity, proof);
      // The durable owner MUST still recheck current access/family state after
      // I/O and before disclosure. This is not a transferable access grant.
      return Object.freeze({ status: "live", proof, bytes });
    }, failureResult);

  const createCopy = (
    value: VertexChatCopyBinding,
    suppliedBytes: Uint8Array
  ): Promise<VertexChatCopyCreation> =>
    run<VertexChatCopyCreation>(async (op) => {
      const binding = capture(value);
      const { content } = binding;
      let bytes: Uint8Array;
      try {
        if (!content) return fail("invalid");
        bytes = byteSnapshot(suppliedBytes, binding.maximumBytes);
        if (bytes.byteLength !== content.byteLength) return fail("invalid");
      } catch {
        return fail("invalid");
      }
      // Binding, nested content and bytes are captured before ANY await.
      if ((await op.wait(() => hashArtifact(bytes))) !== content.sha256)
        return fail("invalid");
      const identity = await identify(op, binding);
      const created = await put(op, identity, "live", bytes);
      if (created) return Object.freeze({ status: "live", proof: created });
      const existing = await observe(op, identity);
      if (!existing) return fail("conflict");
      if (existing.state === "fenced")
        return Object.freeze({ status: "fenced", proof: existing });
      const stored = await load(op, identity, existing);
      if (
        stored.byteLength !== bytes.byteLength ||
        !stored.every((byte, index) => byte === bytes[index])
      )
        return fail("conflict");
      return Object.freeze({ status: "live", proof: existing });
    }, mutationFailure);

  const fenceCopy = (
    value: VertexChatCopyBinding
  ): Promise<VertexChatCopyFence> =>
    run<VertexChatCopyFence>(async (op) => {
      const binding = capture(value);
      const identity = await identify(op, binding);
      const created = await put(op, identity, "fenced", identity.marker.bytes);
      if (created) return Object.freeze({ status: "fenced", proof: created });
      // Known precondition misses alone permit bounded reobservation, not retries
      // after unknown acceptance. Subsequent absence violates the no-delete fence.
      for (
        let attempt = 0;
        attempt <= MAX_CONDITIONAL_REPLACEMENTS;
        attempt += 1
      ) {
        const observed = await observe(op, identity);
        if (!observed) return fail("conflict");
        if (observed.state === "fenced")
          return Object.freeze({ status: "fenced", proof: observed });
        if (!binding.content || attempt === MAX_CONDITIONAL_REPLACEMENTS)
          return fail("conflict");
        const replaced = await put(
          op,
          identity,
          "fenced",
          identity.marker.bytes,
          observed.etag
        );
        if (replaced)
          return Object.freeze({ status: "fenced", proof: replaced });
      }
      return fail("conflict");
    }, mutationFailure);

  // No delete, expiry, reuse, unconditional overwrite, list, copy/move, fallback
  // store, arbitrary marker body or caller-provided physical key exists here.
  return Object.freeze({ createCopy, inspectCopy, readCopy, fenceCopy });
};
