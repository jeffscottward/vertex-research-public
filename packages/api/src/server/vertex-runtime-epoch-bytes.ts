import {
  canonicalArtifactJson,
  hashArtifact as sharedHashArtifact,
  timestampToEpochNanoseconds as sharedTimestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { VertexStoreError } from "@darkfactory/db/server/vertex";

// Native evidence is private, bounded, original canonical bytes, not a public DTO.
// biome-ignore lint/suspicious/noExplicitAny: every field is re-validated by the epoch accessors (text/ns/sha/id/list) before use; typing it unknown would cascade ~100 casts through epoch modules
type EpochValue = any;
export type NativeRecord = Record<string, EpochValue>;
export const epochFail = (
  code:
    | "invalid"
    | "integrity"
    | "unavailable"
    | "denied"
    | "stale"
    | "conflict" = "integrity"
): never => {
  throw new VertexStoreError(code);
};
export const requireEpoch = (
  condition: unknown,
  code:
    | "invalid"
    | "integrity"
    | "unavailable"
    | "denied"
    | "stale"
    | "conflict" = "integrity"
): void => {
  if (!condition) epochFail(code);
};
export const record = (value: unknown): NativeRecord => {
  requireEpoch(
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  return value as NativeRecord;
};
export const exact = (
  value: unknown,
  fields: readonly string[]
): NativeRecord => {
  const result = record(value);
  requireEpoch(
    Object.keys(result).length === fields.length &&
      fields.every((key) => Object.hasOwn(result, key))
  );
  return result;
};
export const text = (value: unknown): string => {
  requireEpoch(typeof value === "string");
  return value as string;
};
export const ns = (value: unknown): bigint => {
  requireEpoch(
    typeof value === "string" && /^(0|[1-9][0-9]{0,38})$/.test(value)
  );
  const result = BigInt(value as string);
  requireEpoch(result < 2n ** 127n);
  return result;
};
export const sha = (value: unknown): string => {
  requireEpoch(typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
  return value as string;
};
export const id = (value: unknown): string => {
  requireEpoch(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  );
  return value as string;
};
export const list = (value: unknown, limit = 4096): EpochValue[] => {
  requireEpoch(Array.isArray(value) && value.length <= limit);
  return value as EpochValue[];
};
export const canonical = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalArtifactJson(value));
export const same = (left: unknown, right: unknown): boolean =>
  canonicalArtifactJson(left) === canonicalArtifactJson(right);
export const decodeBase64 = (value: unknown, limit = 1_048_576): Uint8Array => {
  const encoded = text(value);
  requireEpoch(
    encoded.length > 0 &&
      encoded.length <= Math.ceil(limit / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded
      )
  );
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return epochFail();
  }
  requireEpoch(binary.length <= limit && btoa(binary) === encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
const safeNativeTree = (value: unknown, depth = 0): void => {
  requireEpoch(depth <= 128);
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    // Private evidence maps become mutable reducer dictionaries. Refuse keys
    // that can alias Object prototypes rather than assign through them.
    requireEpoch(!["__proto__", "prototype", "constructor"].includes(key));
    safeNativeTree(child, depth + 1);
  }
};
export const canonicalRecord = (
  bytes: Uint8Array,
  limit = 1_048_576
): NativeRecord => {
  requireEpoch(
    bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= limit
  );
  try {
    const value = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
    safeNativeTree(value);
    const normalized = canonical(value);
    // Equality rejects duplicate keys, alternate escapes, BOM, whitespace,
    // unsafe numbers and every noncanonical representation before trust.
    requireEpoch(
      normalized.length === bytes.length &&
        normalized.every((byte, index) => byte === bytes[index])
    );
    return value;
  } catch {
    return epochFail();
  }
};
export const rawSha = async (bytes: Uint8Array): Promise<string> => {
  requireEpoch(globalThis.crypto?.subtle, "unavailable");
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};
export const hashArtifact = sharedHashArtifact;
export const timestampToEpochNanoseconds = sharedTimestampToEpochNanoseconds;
