import type { ComponentType } from "react";
import type * as Remotion from "remotion";
import { describe, expect, it, vi } from "vitest";

import "./index.ts";
import { RemotionRoot } from "./root.tsx";

// A plain recorder: registration happens at import, before any per-test mock reset.
const registered = vi.hoisted((): ComponentType[] => []);

vi.mock("remotion", async (importOriginal) => ({
  ...(await importOriginal<typeof Remotion>()),
  registerRoot: (root: ComponentType) => {
    registered.push(root);
  },
}));

describe("Remotion entry point", () => {
  it("registers the Academy root once", () => {
    expect(registered).toEqual([RemotionRoot]);
  });
});
