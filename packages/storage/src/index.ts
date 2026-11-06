import type {
  StoragePort,
  StorageResult,
  StorageUnavailableReason,
} from "./ports.ts";

const unavailableResult = (
  reason: StorageUnavailableReason
): StorageResult<never> =>
  Object.freeze({
    status: "unavailable",
    state: reason === "capability-disabled" ? "disabled" : "unconfigured",
  });

export const createDisabledStoragePort = (
  reason: StorageUnavailableReason = "capability-disabled"
): StoragePort => {
  const result = unavailableResult(reason);

  return Object.freeze({
    put: async () => result,
    get: async () => result,
    delete: async () => result,
  });
};

export type {
  StorageUnavailableReason,
  StorageUnavailableState,
  ObjectMetadata,
  StoredObject,
  PutObjectInput,
  DeletedObject,
  StorageResult,
  StoragePort,
  ObjectMetadataRepository,
} from "./ports.ts";
// biome-ignore lint/performance/noBarrelFile: the package root keeps exposing the Vertex artifact storage API.
export * from "./vertex.ts";
