import { createHash } from "node:crypto";
import type * as SharedVertex from "@darkfactory/shared/vertex";

type SharedVertexModule = typeof SharedVertex;

// Same check as the shared encoder's lone-surrogate rejection: Python's UTF-8
// encoder rejects them, so hashing never silently replaces one.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

// Output-identical stand-in for hashArtifact: the same canonical JSON, the same
// lone-surrogate rejection and the same lowercase SHA-256 hex, computed with
// synchronous node:crypto instead of one WebCrypto thread-pool job per call.
// The slow debate acceptance tests make millions of these calls; the
// thread-pool round trips dominated their wall time, worse under CI load.
// They also hash the same rows again and again, so digests of valid texts are
// kept by text. The digest is a pure function of the text, so a kept digest
// equals a new one. When the next text would take the kept texts past
// `memoChars` characters, all kept digests are dropped first, so the kept texts
// total at most `memoChars` characters plus that one text.
// vertex-sync-hash.test.ts proves equality with the real implementation.
export const syncHashArtifact = (
  canonicalArtifactJson: SharedVertexModule["canonicalArtifactJson"],
  memoChars = 32 * 1024 * 1024
) => {
  const memo = new Map<string, string>();
  let kept = 0;
  return async (value: unknown): Promise<string> => {
    if (value instanceof Uint8Array)
      return createHash("sha256").update(value).digest("hex");
    const text =
      typeof value === "string" ? value : canonicalArtifactJson(value);
    const known = memo.get(text);
    if (known !== undefined) return known;
    if (LONE_SURROGATE.test(text))
      throw new TypeError("Invalid Unicode scalar");
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    if (kept + text.length > memoChars) {
      memo.clear();
      kept = 0;
    }
    memo.set(text, digest);
    kept += text.length;
    return digest;
  };
};

// vi.mock factory body: every export stays the real one except hashArtifact.
export const withSyncHashArtifact = (
  real: SharedVertexModule
): SharedVertexModule => ({
  ...real,
  hashArtifact: syncHashArtifact(real.canonicalArtifactJson),
});
