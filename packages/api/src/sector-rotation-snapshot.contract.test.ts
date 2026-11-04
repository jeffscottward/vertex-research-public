import { describe, expect, it } from "vitest";
import { SectorRotationSnapshotSchema } from "./contracts/sector-rotation";
import fixture from "./fixtures/sector-rotation-snapshot.v1.json";

// The Python model services/research/gamma/schemas/market.py SectorRotationSnapshot parses the
// same fixture (services/research/tests/test_sector_rotation_input.py).
describe("sector rotation snapshot fixture v1", () => {
  it("parses with the shared schema", () => {
    const parsed = SectorRotationSnapshotSchema.parse(fixture);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sectors).toHaveLength(11);
    expect(parsed.changes).toHaveLength(2);
    expect(parsed).toEqual(fixture);
  });

  it("rejects another schema version", () => {
    const result = SectorRotationSnapshotSchema.safeParse({
      ...fixture,
      schemaVersion: 2,
    });
    expect(result.success).toBe(false);
  });
});
