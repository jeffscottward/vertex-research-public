import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAppUserModelId: vi.fn(),
    setName: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  },
  createElectronPorts: vi.fn(() => ({ ports: true })),
  startDesktop: vi.fn(),
}));

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("./app.ts", () => ({ startDesktop: mocks.startDesktop }));
vi.mock("./electron-ports.ts", () => ({
  createElectronPorts: mocks.createElectronPorts,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("main", () => {
  it("starts the shell once the app is ready", async () => {
    await import("./main.ts");
    await vi.waitFor(() => expect(mocks.startDesktop).toHaveBeenCalled());
    expect(mocks.app.setName).toHaveBeenCalledWith("Vertex");
    expect(mocks.startDesktop).toHaveBeenCalledWith({ ports: true });
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it("quits when another instance holds the lock", async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    await import("./main.ts");
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.app.whenReady).not.toHaveBeenCalled();
  });
});
