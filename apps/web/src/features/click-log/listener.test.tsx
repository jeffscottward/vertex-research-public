// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const installClickLog = vi.hoisted(() => vi.fn());
vi.mock("./install.ts", () => ({ installClickLog }));

import { ClickLogListener } from "./listener.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ClickLogListener", () => {
  it("installs the click log once in the window, renders nothing and stops on unmount", async () => {
    const stop = vi.fn();
    installClickLog.mockReturnValue(stop);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ClickLogListener />));
    expect(installClickLog).toHaveBeenCalledWith(window);
    expect(container.innerHTML).toBe("");
    await act(async () => root.unmount());
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
