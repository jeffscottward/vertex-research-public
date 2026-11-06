// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountLab, unmountLab } from "../../lab/test-support.tsx";
import LabEntryPage, { metadata as entryMetadata } from "./[entry]/page.tsx";
import LabPage, { metadata } from "./page.tsx";

const enable = () => {
  vi.stubEnv("VERTEX_UI_LAB", "on");
  vi.stubEnv("APP_ENV", "development");
};

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await unmountLab();
});

describe("/lab route files", () => {
  it("return 404 when VERTEX_UI_LAB is unset", async () => {
    vi.stubEnv("VERTEX_UI_LAB", undefined);
    vi.stubEnv("APP_ENV", "development");
    await expect(
      LabPage({ searchParams: Promise.resolve({}) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      LabEntryPage({
        params: Promise.resolve({ entry: "charts" }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("return 404 in production even when VERTEX_UI_LAB=on", async () => {
    vi.stubEnv("VERTEX_UI_LAB", "on");
    vi.stubEnv("APP_ENV", "production");
    await expect(
      LabPage({ searchParams: Promise.resolve({}) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      LabEntryPage({
        params: Promise.resolve({ entry: "charts" }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("render the index and an entry when on, and are never indexed", async () => {
    enable();
    expect(metadata.robots).toEqual({ follow: false, index: false });
    expect(entryMetadata.robots).toEqual({ follow: false, index: false });
    const index = await mountLab(
      await LabPage({ searchParams: Promise.resolve({ theme: "light" }) })
    );
    expect(index.querySelector("h1")?.textContent).toBe("UI lab");
    expect(
      index.querySelector("[data-lab-frame]")?.getAttribute("data-theme")
    ).toBe("default-light");
    await unmountLab();
    const entry = await mountLab(
      await LabEntryPage({
        params: Promise.resolve({ entry: "missing-entry" }),
        searchParams: Promise.resolve({ symbol: "NVDA" }),
      })
    );
    expect(entry.textContent).toContain("Unknown lab entry");
  });
});
