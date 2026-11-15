// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { mountLab, unmountLab } from "../test-support.tsx";
import {
  LAB_SEMANTIC_CATALOG,
  labSemanticTermsGateway,
  SEMANTIC_TERMS_LAB_ENTRIES,
} from "./semantic-terms.tsx";

afterEach(async () => {
  await unmountLab();
});

describe("semantic terms lab entry", () => {
  it.each(SEMANTIC_TERMS_LAB_ENTRIES)(
    "renders $id with fake data",
    async (entry) => {
      const host = await mountLab(entry.render(new URLSearchParams()));
      expect(host.querySelector("h1")?.textContent).toBe(entry.title);
      expect(host.textContent).toContain("Demo widget count (fake)");
    }
  );

  it("serves the fake catalog and accepts edits", async () => {
    await expect(labSemanticTermsGateway.catalog()).resolves.toBe(
      LAB_SEMANTIC_CATALOG
    );
    await expect(labSemanticTermsGateway.certify({} as never)).resolves.toEqual(
      { ok: true }
    );
    await expect(labSemanticTermsGateway.update({} as never)).resolves.toEqual({
      ok: true,
    });
  });
});
