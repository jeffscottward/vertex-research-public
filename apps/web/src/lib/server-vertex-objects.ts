import type { VertexRequestOptions } from "@darkfactory/api/server";
import {
  createVertexR2ObjectStore,
  isVertexR2Bucket,
} from "@darkfactory/storage/r2";

type ScopedObjectsFactory = NonNullable<
  VertexRequestOptions["objectsForScope"]
>;

// The caller supplies the Worker binding, never an endpoint or credentials.
// A missing/malformed binding is unavailable, not an in-memory substitute.
export const createVertexObjectsForScope = (
  binding: unknown
): ScopedObjectsFactory | undefined => {
  if (!isVertexR2Bucket(binding)) return undefined;
  return (scope, collectionId, signal) =>
    createVertexR2ObjectStore({
      bucket: binding,
      scope,
      collectionId,
      ...(signal === undefined ? {} : { signal }),
    });
};
