import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VertexR2Bucket,
  VertexR2ObjectStore,
  VertexR2ObjectStoreOptions,
} from "@darkfactory/storage/r2";

// Source-only regressions: the entire adapter entry point is mocked. Neither
// the helper nor these tests contact R2, discover configuration, or grant access.
const mocks = vi.hoisted(() => ({
  isVertexR2Bucket: vi.fn<(binding: unknown) => boolean>(),
  createVertexR2ObjectStore:
    vi.fn<(options: VertexR2ObjectStoreOptions) => VertexR2ObjectStore>(),
}));
vi.mock("@darkfactory/storage/r2", () => ({
  isVertexR2Bucket: mocks.isVertexR2Bucket,
  createVertexR2ObjectStore: mocks.createVertexR2ObjectStore,
}));

import { createVertexObjectsForScope } from "./server-vertex-objects.ts";

const scope = Object.freeze({
  accountAlias: "fixture-account",
  environment: "research" as const,
});
const collectionId = "fixture-collection";
const fakeBinding = (): VertexR2Bucket => ({
  head: vi.fn(async () => {
    throw new Error("fixture binding must not be called");
  }),
  get: vi.fn(async () => {
    throw new Error("fixture binding must not be called");
  }),
  put: vi.fn(async () => {
    throw new Error("fixture binding must not be called");
  }),
});
const fakePorts = (): VertexR2ObjectStore => {
  const disabled = Object.freeze({
    status: "unavailable" as const,
    state: "disabled" as const,
  });
  return Object.freeze({
    objects: Object.freeze({
      put: vi.fn(async () => disabled),
      get: vi.fn(async () => disabled),
      delete: vi.fn(async () => disabled),
    }),
    objectCapabilities: Object.freeze({
      putIfAbsent: vi.fn(async () => disabled),
      head: vi.fn(async () => disabled),
      getBounded: vi.fn(async () => disabled),
    }),
  });
};
const expectNoObjectCalls = (
  binding: VertexR2Bucket,
  ports?: VertexR2ObjectStore
): void => {
  expect(binding.head).not.toHaveBeenCalled();
  expect(binding.get).not.toHaveBeenCalled();
  expect(binding.put).not.toHaveBeenCalled();
  if (ports) {
    for (const method of Object.values(ports.objects))
      expect(method).not.toHaveBeenCalled();
    for (const method of Object.values(ports.objectCapabilities))
      expect(method).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  mocks.isVertexR2Bucket.mockReset();
  mocks.createVertexR2ObjectStore.mockReset();
  return mocks.isVertexR2Bucket.mockReturnValue(true);
});

describe("trusted request-scoped Worker object factory", () => {
  it.each([
    undefined,
    null,
    "bucket-name-not-a-binding",
    {},
    { head: true },
    { head: () => undefined, get: null, put: null },
  ])(
    "returns unavailable when the adapter guard rejects an unknown binding",
    (binding) => {
      mocks.isVertexR2Bucket.mockReturnValue(false);
      expect(createVertexObjectsForScope(binding)).toBeUndefined();
      expect(mocks.isVertexR2Bucket).toHaveBeenCalledExactlyOnceWith(binding);
      return expect(mocks.createVertexR2ObjectStore).not.toHaveBeenCalled();
    }
  );

  it("validates only the supplied binding and does not eagerly construct an adapter", () => {
    const binding: unknown = fakeBinding();
    const factory = createVertexObjectsForScope(binding);
    expect(typeof factory).toBe("function");
    expect(mocks.isVertexR2Bucket).toHaveBeenCalledExactlyOnceWith(binding);
    return expect(mocks.createVertexR2ObjectStore).not.toHaveBeenCalled();
  });

  it("keeps valid binding discovery lazy and does not call even its metadata methods", () => {
    const binding = fakeBinding();
    const ports = fakePorts();
    mocks.createVertexR2ObjectStore.mockReturnValue(ports);
    expect(createVertexObjectsForScope(binding)).toBeTypeOf("function");
    expect(mocks.createVertexR2ObjectStore).not.toHaveBeenCalled();
    return expectNoObjectCalls(binding, ports);
  });

  it("passes the authorized scope and exact collection to the adapter without alteration", () => {
    const binding = fakeBinding();
    const ports = fakePorts();
    mocks.createVertexR2ObjectStore.mockReturnValue(ports);
    const factory = createVertexObjectsForScope(binding);
    if (!factory) throw new Error("fixture expected factory");
    expect(factory(scope, collectionId, undefined)).toBe(ports);
    expect(mocks.createVertexR2ObjectStore).toHaveBeenCalledExactlyOnceWith({
      bucket: binding,
      scope,
      collectionId,
    });
    const options = mocks.createVertexR2ObjectStore.mock.calls[0]![0];
    expect(options.bucket).toBe(binding);
    expect(options.scope).toBe(scope);
    expect(Object.hasOwn(options, "signal")).toBe(false);
    return expectNoObjectCalls(binding, ports);
  });

  it("forwards null as exact account scope, never as a wildcard collection", () => {
    const binding = fakeBinding();
    const ports = fakePorts();
    mocks.createVertexR2ObjectStore.mockReturnValue(ports);
    const factory = createVertexObjectsForScope(binding);
    if (!factory) throw new Error("fixture expected factory");
    expect(factory(scope, null, undefined)).toBe(ports);
    expect(mocks.createVertexR2ObjectStore).toHaveBeenCalledExactlyOnceWith({
      bucket: binding,
      scope,
      collectionId: null,
    });
    return expectNoObjectCalls(binding, ports);
  });

  it.each([false, true])(
    "forwards the same request AbortSignal including pre-aborted=%s",
    (alreadyAborted) => {
      const binding = fakeBinding();
      const ports = fakePorts();
      const controller = new AbortController();
      if (alreadyAborted) controller.abort();
      mocks.createVertexR2ObjectStore.mockReturnValue(ports);
      const factory = createVertexObjectsForScope(binding);
      if (!factory) throw new Error("fixture expected factory");
      expect(factory(scope, collectionId, controller.signal)).toBe(ports);
      const options = mocks.createVertexR2ObjectStore.mock.calls[0]![0];
      expect(options.signal).toBe(controller.signal);
      expect(options.signal?.aborted).toBe(alreadyAborted);
      expect(Object.keys(options).sort()).toEqual([
        "bucket",
        "collectionId",
        "scope",
        "signal",
      ]);
      return expectNoObjectCalls(binding, ports);
    }
  );

  it("creates separately for every invocation rather than caching one scope or cancellation signal", () => {
    const binding = fakeBinding();
    const firstPorts = fakePorts();
    const secondPorts = fakePorts();
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;
    const otherScope = Object.freeze({
      accountAlias: "other-fixture-account",
      environment: "paper" as const,
    });
    mocks.createVertexR2ObjectStore
      .mockReturnValueOnce(firstPorts)
      .mockReturnValueOnce(secondPorts);
    const factory = createVertexObjectsForScope(binding);
    if (!factory) throw new Error("fixture expected factory");
    expect(factory(scope, collectionId, firstSignal)).toBe(firstPorts);
    expect(factory(otherScope, null, secondSignal)).toBe(secondPorts);
    expect(mocks.isVertexR2Bucket).toHaveBeenCalledTimes(1);
    expect(mocks.createVertexR2ObjectStore).toHaveBeenNthCalledWith(1, {
      bucket: binding,
      scope,
      collectionId,
      signal: firstSignal,
    });
    expect(mocks.createVertexR2ObjectStore).toHaveBeenNthCalledWith(2, {
      bucket: binding,
      scope: otherScope,
      collectionId: null,
      signal: secondSignal,
    });
    expectNoObjectCalls(binding, firstPorts);
    return expectNoObjectCalls(binding, secondPorts);
  });

  it("keeps explicitly supplied binding identities isolated across helper instances", () => {
    const firstBinding = fakeBinding();
    const secondBinding = fakeBinding();
    const ports = fakePorts();
    mocks.createVertexR2ObjectStore.mockReturnValue(ports);
    const first = createVertexObjectsForScope(firstBinding);
    const second = createVertexObjectsForScope(secondBinding);
    if (!(first && second)) throw new Error("fixture expected factories");
    first(scope, collectionId, undefined);
    second(scope, collectionId, undefined);
    expect(mocks.createVertexR2ObjectStore).toHaveBeenNthCalledWith(1, {
      bucket: firstBinding,
      scope,
      collectionId,
    });
    expect(mocks.createVertexR2ObjectStore).toHaveBeenNthCalledWith(2, {
      bucket: secondBinding,
      scope,
      collectionId,
    });
    expectNoObjectCalls(firstBinding, ports);
    return expectNoObjectCalls(secondBinding, ports);
  });

  return it("propagates a neutral adapter construction failure without creating a fallback", () => {
    const binding = fakeBinding();
    const error = new Error("Vertex R2 configuration unavailable");
    mocks.createVertexR2ObjectStore.mockImplementation(() => {
      throw error;
    });
    const factory = createVertexObjectsForScope(binding);
    if (!factory) throw new Error("fixture expected factory");
    expect(() => factory(scope, collectionId, undefined)).toThrow(error);
    expect(mocks.createVertexR2ObjectStore).toHaveBeenCalledTimes(1);
    return expectNoObjectCalls(binding);
  });
});
