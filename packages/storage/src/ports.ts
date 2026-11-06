// What: storage port types shared by the disabled port, Vertex artifact storage and the R2 adapter.
// Used by: index.ts (re-export), vertex.ts, r2.ts.
export type StorageUnavailableReason =
  | "capability-disabled"
  | "provider-unconfigured";

export type StorageUnavailableState = "disabled" | "unconfigured";

export type ObjectMetadata = Readonly<{
  key: string;
  size: number;
  contentType?: string | undefined;
  checksum?: string | undefined;
  createdAt: string;
  updatedAt: string;
}>;

export type StoredObject = Readonly<{
  metadata: ObjectMetadata;
  body: Uint8Array;
}>;

export type PutObjectInput = Readonly<{
  key: string;
  body: Uint8Array;
  contentType?: string | undefined;
  checksum?: string | undefined;
}>;

export type DeletedObject = Readonly<{ deleted: true }>;

export type StorageResult<Value> =
  | Readonly<{ status: "ok"; value: Value }>
  | Readonly<{ status: "not-found" }>
  | Readonly<{
      status: "unavailable";
      state: StorageUnavailableState;
    }>;

export interface StoragePort {
  put: (input: PutObjectInput) => Promise<StorageResult<ObjectMetadata>>;
  get: (key: string) => Promise<StorageResult<StoredObject>>;
  delete: (key: string) => Promise<StorageResult<DeletedObject>>;
}

export interface ObjectMetadataRepository {
  upsert: (metadata: ObjectMetadata) => Promise<void>;
  findByKey: (key: string) => Promise<ObjectMetadata | null>;
  deleteByKey: (key: string) => Promise<boolean>;
}
