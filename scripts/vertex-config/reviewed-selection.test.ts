import { describe, expect, it, vi } from "vitest";
import { parseAssignments } from "./core.ts";
import {
  inspectSelection,
  parseSelectionManifest,
  planReviewedSelection,
  type InspectionInput,
} from "./inspection.ts";

// The registry records the reviewing machine's absolute roots; re-root it beside
// this checkout so the fixtures hold wherever the repository is cloned.
vi.mock(
  "../../docs/vertex-rebuild/migration-matrix.json",
  async (importOriginal) =>
    (await import("./registry.test-support.ts")).rerootRegistry(importOriginal)
);

const key = "FINANCIAL_DATASETS_API_KEY";
const alias = "FINANCIALDATASETS_API_KEY";
const makeInput = (
  content = `${alias}=fixture-selected\n`,
  existing: string | null = null,
  keys: string[] = [alias]
): InspectionInput => ({
  manifest: parseSelectionManifest({
    version: 1,
    sources: [{ repository: "gamma-forge", path: "forge/.env.local", keys }],
  }),
  sources: [{ repository: "gamma-forge", path: "forge/.env.local", content }],
  schema: `${key}=\nQUANTDATA_API_KEY=\nIBKR_READ_ONLY=\n`,
  existing,
});
const values = (text: string) =>
  Object.fromEntries(
    parseAssignments(text).map((entry) => [entry.name, entry.value])
  );

describe("pure reviewed-selection application planning", () => {
  it("canonicalizes only a unique explicitly selected eligible literal", () => {
    const result = planReviewedSelection(
      makeInput(
        `${alias}=fixture-selected\nQUANTDATA_API_KEY=fixture-unselected\n`
      )
    );
    expect(result.addedNames).toEqual([key]);
    expect(values(result.content!)).toEqual({ [key]: "fixture-selected" });
    expect(result.report.selectedNames).toEqual([key]);
    return expect(JSON.stringify(result.report)).not.toMatch(
      /fixture-selected|fixture-unselected/
    );
  });

  it("retains identical canonical targets without reserializing or duplicating them", () => {
    const existing = `# keep formatting\nexport ${key} = 'fixture-selected' # existing\nUNKNOWN_SETTING=fixture-preserve\n`;
    const result = planReviewedSelection(makeInput(undefined, existing));
    expect(result.content).toBe(existing);
    expect(result.addedNames).toEqual([]);
    return expect(result.retainedNames).toEqual([key]);
  });

  it.each([
    "fixture-different",
    "placeholder-existing",
    "op://fixture-vault/item/field",
    "${UNRESOLVED}",
  ])(
    "blocks nonempty existing values, including otherwise ineligible literals %#",
    (value) => {
      const existing = `${key}='${value}'\nQUANTDATA_API_KEY=fixture-untouched\n`;
      const result = planReviewedSelection(makeInput(undefined, existing));
      expect(result.content).toBe(existing);
      expect(result.conflictingNames).toEqual([key]);
      expect(result.addedNames).toEqual([]);
      return expect(JSON.stringify(result.report)).not.toContain(value);
    }
  );

  it("does not partially plan other eligible names when one selection conflicts", () => {
    const result = planReviewedSelection(
      makeInput(
        `${alias}=fixture-new\nQUANTDATA_API_KEY=fixture-second\n`,
        `${key}=fixture-old\n`,
        [alias, "QUANTDATA_API_KEY"]
      )
    );
    expect(result.content).toBe(`${key}=fixture-old\n`);
    expect(result.addedNames).toEqual([]);
    return expect(result.conflictingNames).toEqual([key]);
  });

  it.each([
    `${alias}=fixture-a\n${alias}=fixture-b\n`,
    `${alias}=fixture-a\n${key}=fixture-b\n`,
  ])(
    "rejects conflicting duplicate and canonical-alias groups %#",
    (source) => {
      const result = planReviewedSelection(
        makeInput(source, null, [key, alias])
      );
      expect(result.conflictingNames).toEqual([key]);
      expect(result.addedNames).toEqual([]);
      return expect(result.content).toBeNull();
    }
  );

  it("groups equal source aliases without selecting an arbitrary winner", () => {
    const result = planReviewedSelection(
      makeInput(
        `${alias}=fixture-same\n${key}=fixture-same\n${key}=fixture-same\n`,
        null,
        [key, alias]
      )
    );
    expect(result.addedNames).toEqual([key]);
    expect(values(result.content!)).toEqual({ [key]: "fixture-same" });
    return expect(result.report.entries[0]!.equality).toBe("identical");
  });

  it.each([
    `${key}=fixture-selected\n${key}=\n`,
    `${alias}=fixture-selected\n`,
    `${key}=fixture-a\n${key}=fixture-b\n`,
  ])(
    "does not silently repair ambiguous or legacy-alias target entries %#",
    (existing) => {
      const result = planReviewedSelection(makeInput(undefined, existing));
      expect(result.conflictingNames).toEqual([key]);
      return expect(result.content).toBe(existing);
    }
  );

  it.each([
    ["IB_GATEWAY_HOST", "IBKR_HOST"],
    ["IB_GATEWAY_PORT", "IBKR_PORT"],
  ])(
    "protects existing legacy master alias %s without authorizing it as a source",
    (legacy, canonical) => {
      const input = makeInput(
        `${canonical}=fixture-selected\n`,
        `${legacy}=fixture-old\n`,
        [canonical]
      );
      const result = planReviewedSelection({
        ...input,
        schema: `${canonical}=\n`,
      });
      expect(result.conflictingNames).toEqual([canonical]);
      expect(result.content).toBe(`${legacy}=fixture-old\n`);
      const same = planReviewedSelection({
        ...input,
        existing: `${legacy}=fixture-selected\n`,
        schema: `${canonical}=\n`,
      });
      expect(same.conflictingNames).toEqual([canonical]);
      const deferred = makeInput(`${legacy}=fixture-selected\n`, null, [
        legacy,
      ]);
      const source = planReviewedSelection({
        ...deferred,
        schema: `${canonical}=\n`,
      });
      expect(source.addedNames).toEqual([]);
      return expect(source.report.deferredNames).toEqual([legacy]);
    }
  );

  it.each([
    "",
    "   ",
    "\n",
    "# kept\r\n",
    `export ${key} = '' # selected empty\r\n`,
    `${key}=\n${key}=' '\n`,
  ])("fills absent or wholly empty canonical assignments %#", (existing) => {
    const result = planReviewedSelection(makeInput(undefined, existing));
    // Distinct duplicate target encodings are ambiguous even if both trim empty.
    if (existing === `${key}=\n${key}=' '\n`) {
      expect(result.conflictingNames).toEqual([key]);
      return expect(result.content).toBe(existing);
    }
    expect(result.addedNames).toEqual([key]);
    expect(values(result.content!)[key]).toBe("fixture-selected");
    return expect(
      parseAssignments(result.content!).filter((entry) => entry.name === key)
    ).toHaveLength(1);
  });

  it("preserves unknown settings, comments, flags and quoted multiline lookalikes verbatim", () => {
    const prefix = `\uFEFF# unchanged\nUNKNOWN='first\n${key}=not-an-assignment\nlast'\nESCAPED="one\\"two"\nOTHER=unquoted # keep\nIBKR_READ_ONLY=false\nRESEARCH_RUNTIME_STATE=disabled\n`;
    const result = planReviewedSelection(
      makeInput(undefined, `${prefix}${key}=''\nTRAILING=last`)
    );
    expect(result.content!.startsWith(prefix)).toBe(true);
    expect(result.content).toContain("TRAILING=last\n");
    return expect(values(result.content!)).toMatchObject({
      IBKR_READ_ONLY: "false",
      RESEARCH_RUNTIME_STATE: "disabled",
      UNKNOWN: `first\n${key}=not-an-assignment\nlast`,
      [key]: "fixture-selected",
    });
  });

  it.each([
    "OPENAI_API_KEY",
    "UNREVIEWED",
    "IBKR_READ_ONLY",
    "QUANTVPS_SSH_PASSWORD",
  ])("never stages deferred, unknown or safety-selected name %s", (name) => {
    const result = planReviewedSelection(
      makeInput(`${name}=fixture-never-copy\n`, null, [name])
    );
    expect(result.addedNames).toEqual([]);
    expect(result.content).toBeNull();
    return expect(result.report.eligibleNames).toEqual([]);
  });

  it.each([
    "",
    "placeholder-value",
    "${MISSING}",
    "<unknown>",
    "op://fixture-vault/item/field",
  ])("never resolves or applies an ineligible/reference value %#", (value) => {
    const result = planReviewedSelection(makeInput(`${alias}='${value}'\n`));
    expect(result.addedNames).toEqual([]);
    expect(result.content).toBeNull();
    return expect(JSON.stringify(result.report)).not.toContain("op://");
  });

  it("honors schema eligibility without expanding the registry", () => {
    const input = makeInput();
    const result = planReviewedSelection({ ...input, schema: "UNRELATED=\n" });
    expect(result.addedNames).toEqual([]);
    return expect(result.report.deferredNames).toEqual([key]);
  });

  it("never applies template files or missing selected inputs", () => {
    const input = makeInput();
    const manifest = parseSelectionManifest({
      version: 1,
      sources: [
        { repository: "gamma-forge", path: ".env.example", keys: [alias] },
      ],
    });
    const template = planReviewedSelection({
      ...input,
      manifest,
      sources: [
        {
          repository: "gamma-forge",
          path: ".env.example",
          content: `${alias}=fixture-template\n`,
        },
      ],
    });
    expect(template.addedNames).toEqual([]);
    return expect(
      planReviewedSelection({
        ...input,
        sources: [{ ...input.sources[0]!, content: null }],
      }).addedNames
    ).toEqual([]);
  });

  it("fails closed on malformed master/source and unrepresentable selected output", () => {
    expect(() =>
      planReviewedSelection(makeInput(undefined, "invalid fixture-detail"))
    ).toThrow("invalid-master");
    expect(() =>
      planReviewedSelection(makeInput("invalid fixture-detail"))
    ).toThrow("invalid-dotenv");
    return expect(() =>
      planReviewedSelection(makeInput(`${alias}=fixture'"\`\n`))
    ).toThrow("unrepresentable-value");
  });

  it("retains the strict names-only inspector's previous invalid-master behavior", () => {
    const input = makeInput(undefined, "UNKNOWN=fixture-preserve\n");
    expect(() => inspectSelection(input)).toThrow("invalid-master");
    expect(planReviewedSelection(input).content).toContain(
      "UNKNOWN=fixture-preserve\n"
    );
    return expect(JSON.stringify(inspectSelection(makeInput()))).not.toContain(
      "fixture-selected"
    );
  });

  return it("bounds the combined master instead of writing a truncated partial value", () => {
    const existing = `UNKNOWN='${"x".repeat(1024 * 1024 - 12)}'\n`;
    return expect(() =>
      planReviewedSelection(makeInput(undefined, existing))
    ).toThrow("invalid-dotenv");
  });
});
