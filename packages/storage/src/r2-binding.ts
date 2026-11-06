// What: structural R2 binding types shared by the R2 object store (r2.ts) and R2 chat copies.
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
