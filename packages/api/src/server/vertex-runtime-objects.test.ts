import { describe, expect, it, vi } from "vitest";
import { vertexQualifiedObjectKey } from "@darkfactory/storage/vertex";
import {
  createVertexRuntimeObjectCapabilities,
  vertexRuntimeObjectCollection,
} from "./vertex-runtime-objects.ts";

const scope = { accountAlias: "account", environment: "research" as const };
const sha = "a".repeat(64);
const unavailable = async () => ({
  status: "unavailable" as const,
  state: "unconfigured" as const,
});
describe("Vertex production runtime object capabilities", () => {
  it("constructs without resolving a binding or invoking storage", async () => {
    const resolve = vi.fn();
    createVertexRuntimeObjectCapabilities({ objectsForScope: resolve })(scope);
    return expect(resolve).not.toHaveBeenCalled();
  });
  it("resolves collection keys to their exact scoped backend, not the account backend", async () => {
    const get = vi.fn(unavailable);
    const resolve = vi.fn(async () => ({
      objects: { put: unavailable, get: unavailable, delete: unavailable },
      objectCapabilities: { getBounded: get },
    }));
    const capabilities = createVertexRuntimeObjectCapabilities({
      objectsForScope: resolve,
    })(scope);
    const key = vertexQualifiedObjectKey(scope, "corpus", "content", sha);
    await capabilities.getBounded!(key, 1_048_576);
    expect(resolve).toHaveBeenCalledWith(scope, "corpus", undefined);
    expect(get).toHaveBeenCalledWith(key, 1_048_576);
    await capabilities.getBounded!(key, 64);
    return expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-scope keys and noncanonical path spellings before binding", async () => {
    const resolve = vi.fn();
    const capabilities = createVertexRuntimeObjectCapabilities({
      objectsForScope: resolve,
    })(scope);
    const foreign = vertexQualifiedObjectKey(
      { accountAlias: "other", environment: "research" },
      null,
      "content",
      sha
    );
    await expect(capabilities.getBounded!(foreign, 1024)).rejects.toMatchObject(
      { code: "invalid" }
    );
    const key = vertexQualifiedObjectKey(scope, "corpus", "content", sha);
    await expect(
      capabilities.getBounded!(key.replace("corpus", "%63orpus"), 1024)
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      capabilities.getBounded!(`${key}/suffix`, 1024)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(resolve).not.toHaveBeenCalled();
  });
  it("enforces one MiB before a backend can allocate", async () => {
    const resolve = vi.fn();
    const capabilities = createVertexRuntimeObjectCapabilities({
      objectsForScope: resolve,
    })(scope);
    const key = vertexQualifiedObjectKey(scope, null, "content", sha);
    for (const maximum of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_048_577,
    ]) {
      await expect(
        capabilities.getBounded!(key, maximum)
      ).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      capabilities.putIfAbsent!({ key, body: new Uint8Array(1_048_577) })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(resolve).not.toHaveBeenCalled();
  });
  it("does not resolve objects after request cancellation", async () => {
    const controller = new AbortController();
    const resolve = vi.fn();
    const capabilities = createVertexRuntimeObjectCapabilities({
      objectsForScope: resolve,
      signal: controller.signal,
    })(scope);
    controller.abort();
    await expect(
      capabilities.head!(vertexQualifiedObjectKey(scope, null, "manifest", sha))
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(resolve).not.toHaveBeenCalled();
  });
  return it("retains exact null account collection identity", () => {
    expect(
      vertexRuntimeObjectCollection(
        scope,
        vertexQualifiedObjectKey(scope, null, "manifest", sha)
      )
    ).toBeNull();
    return expect(
      vertexRuntimeObjectCollection(
        scope,
        vertexQualifiedObjectKey(scope, "account", "manifest", sha)
      )
    ).toBe("account");
  });
});
