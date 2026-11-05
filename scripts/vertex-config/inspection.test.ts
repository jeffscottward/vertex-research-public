import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import registry from "../../docs/vertex-rebuild/migration-matrix.json";
import { inventory } from "./core.ts";
import {
  boundInspectionRepositoryIds,
  LOCAL_TRADING_ROOT,
  inspectSelection,
  inspectionRepositoryIds,
  parseSelectionManifest,
  type InspectionInput,
  type SourceSelection,
} from "./inspection.ts";

// The registry records the reviewing machine's absolute roots; re-root it beside
// this checkout so the fixtures hold wherever the repository is cloned.
vi.mock(
  "../../docs/vertex-rebuild/migration-matrix.json",
  async (importOriginal) =>
    (await import("./registry.test-support.ts")).rerootRegistry(importOriginal)
);

const key = "FINANCIAL_DATASETS_API_KEY";
const legacy = "FINANCIALDATASETS_API_KEY";
const schema = `${key}=\nQUANTDATA_API_KEY=\nDATABASE_URL=\n`;
const selection = (
  keys: readonly string[] = [key],
  path = "forge/.env",
  repository = "gamma-forge"
): SourceSelection => ({ repository, path, keys });
const input = (
  content: string | null,
  keys: readonly string[] = [key],
  path = "forge/.env"
): InspectionInput => ({
  manifest: { version: 1, sources: [selection(keys, path)] },
  sources: [{ repository: "gamma-forge", path, content }],
  schema,
  existing: null,
});

describe("explicit source-selection manifest", () => {
  it("derives IDs from the existing reviewed root registry", () => {
    // The retired signal bot keeps its registry row (migration history) but is
    // never read (owner 2026-11-04).
    const retired = ["charan-discord-bot"];
    expect(inspectionRepositoryIds).toEqual(
      registry.roots
        .map((entry) => entry.id)
        .filter((id) => !retired.includes(id))
    );
    expect(Object.isFrozen(inspectionRepositoryIds)).toBe(true);
    return expect(
      parseSelectionManifest({
        version: 1,
        sources: [selection([key], "roth-bot/.env.local", "AI-Cornell-bots")],
      }).sources[0]?.path
    ).toBe("roth-bot/.env.local");
  });

  it("does not turn registry additions, external sources or relocated roots into read authority", () => {
    expect(
      boundInspectionRepositoryIds(
        [
          { id: "gamma-forge", sourcePath: "/synthetic/trading/gamma-forge" },
          { id: "gamma-forge", sourcePath: "/external/gamma-forge" },
          { id: "Fincept", sourcePath: "/synthetic/trading/Fincept" },
          { id: "../outside", sourcePath: "/synthetic/trading/../outside" },
        ],
        "/synthetic/trading"
      )
    ).toEqual(["gamma-forge"]);
    // The default root is the parent directory of this checkout.
    expect(
      boundInspectionRepositoryIds([
        {
          id: "gamma-forge",
          sourcePath: join(LOCAL_TRADING_ROOT, "gamma-forge"),
        },
      ])
    ).toEqual(["gamma-forge"]);
    return expect(() =>
      parseSelectionManifest({
        version: 1,
        sources: [selection([key], ".env", "Fincept")],
      })
    ).toThrow("invalid-manifest-repository");
  });

  it.each(
    [
      null,
      [],
      {},
      { version: 2, sources: [] },
      { version: 1, sources: null },
      { version: 1, sources: [] },
      { version: 1, sources: Array.from({ length: 65 }, () => selection()) },
      { version: 1, sources: [selection()], root: "/external" },
    ].map((manifest) => ({ manifest }))
  )("rejects unknown or unbounded manifest structure %#", ({ manifest }) => {
    return expect(() => parseSelectionManifest(manifest)).toThrow(
      "invalid-manifest"
    );
  });

  it.each(
    [
      null,
      [],
      {},
      { ...selection(), root: "/external" },
      { ...selection(), keys: undefined },
    ].map((source) => ({ source }))
  )("rejects malformed selections %#", ({ source }) => {
    return expect(() =>
      parseSelectionManifest({ version: 1, sources: [source] })
    ).toThrow("invalid-manifest");
  });

  it.each(["unknown", "../gamma-forge", "/external", 1, null])(
    "rejects unregistered repository %#",
    (repository) => {
      return expect(() =>
        parseSelectionManifest({
          version: 1,
          sources: [{ ...selection(), repository }],
        })
      ).toThrow("invalid-manifest-repository");
    }
  );

  it.each([
    "../.env",
    "/.env",
    "./.env",
    "forge/../.env",
    "forge//.env",
    "forge\\.env",
    "forge/%2e%2e/.env",
    "forge/.env.production",
    "forge/secrets.json",
    "forge/.env/",
    "forge/\0.env",
    "a".repeat(513),
    null,
    1,
  ])("rejects non-normalized or unsupported source path %#", (path) => {
    return expect(() =>
      parseSelectionManifest({
        version: 1,
        sources: [{ ...selection(), path }],
      })
    ).toThrow("invalid-manifest-path");
  });

  it.each(
    [
      [],
      ["lower"],
      ["BAD-NAME"],
      ["A\nB"],
      ["A".repeat(129)],
      [null],
      [3],
      null,
      "KEY",
      Array.from({ length: 257 }, (_, index) => `KEY_${index}`),
    ].map((keys) => ({ keys }))
  )("rejects malformed key selections %#", ({ keys }) => {
    return expect(() =>
      parseSelectionManifest({
        version: 1,
        sources: [{ ...selection(), keys }],
      })
    ).toThrow("invalid-manifest-keys");
  });

  it("rejects duplicate paths and key names", () => {
    expect(() =>
      parseSelectionManifest({
        version: 1,
        sources: [selection(), selection()],
      })
    ).toThrow("duplicate-manifest-selection");
    return expect(() =>
      parseSelectionManifest({ version: 1, sources: [selection([key, key])] })
    ).toThrow("duplicate-manifest-selection");
  });

  return it("copies selections without retaining mutable caller arrays", () => {
    const keys = [key];
    const manifest = parseSelectionManifest({
      version: 1,
      sources: [selection(keys)],
    });
    keys.push("QUANTDATA_API_KEY");
    return expect(manifest.sources[0]?.keys).toEqual([key]);
  });
});

describe("pure names-only inspection plan", () => {
  it("coalesces only the reviewed financial alias and emits no values or value hashes", () => {
    const result = inspectSelection(
      input(`${key}=fixture-financial\n${legacy}='fixture-financial'\n`, [
        key,
        legacy,
      ])
    );
    expect(result.selectedNames).toEqual([key]);
    expect(result.eligibleNames).toEqual([key]);
    expect(result.entries[0]).toMatchObject({
      name: key,
      equality: "identical",
      decision: "eligible-candidate",
      groups: [
        {
          id: "g1",
          origins: [
            { repository: "gamma-forge", path: "forge/.env", kind: "source" },
            { repository: "gamma-forge", path: "forge/.env", kind: "source" },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-financial|FINANCIALDATASETS_API_KEY|hash|op:\/\//
    );
    // The real merge and runtime have not acquired the inspection-only alias.
    return expect(
      inventory(schema, [
        { label: "gamma-forge/.env", content: `${legacy}=fixture-financial\n` },
      ]).selected
    ).toEqual({});
  });

  it("never infers a winner among conflicting canonical and legacy candidates", () => {
    const result = inspectSelection(
      input(`${legacy}=fixture-one\n${key}=fixture-two\n${key}=fixture-one\n`, [
        legacy,
        key,
      ])
    );
    expect(result.conflictingNames).toEqual([key]);
    expect(result.entries[0]).toMatchObject({
      equality: "conflicting",
      decision: "unresolved",
      groups: [{ id: "g1" }, { id: "g2" }],
    });
    expect(
      result.entries[0]?.groups.map((group) => group.origins.length)
    ).toEqual([2, 1]);
    return expect(JSON.stringify(result)).not.toMatch(
      /fixture-one|fixture-two/
    );
  });

  it("groups duplicate-heavy conflicts once while preserving opaque insertion order", () => {
    const lines = Array.from(
      { length: 12_000 },
      (_, index) => `${key}=fixture-candidate-${index}\n`
    );
    const content = [...lines, ...lines.slice(0, 1000)].join("");
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    const result = inspectSelection(input(content));
    const entry = result.entries[0]!;
    expect(entry.equality).toBe("conflicting");
    expect(entry.decision).toBe("unresolved");
    expect(entry.groups).toHaveLength(12_000);
    expect(entry.groups[0]).toMatchObject({
      id: "g1",
      origins: [{ path: "forge/.env" }, { path: "forge/.env" }],
    });
    expect(entry.groups[11_999]).toMatchObject({
      id: "g12000",
      origins: [{ path: "forge/.env" }],
    });
    expect(
      entry.groups.reduce((count, group) => count + group.origins.length, 0)
    ).toBe(13_000);
    return expect(JSON.stringify(result)).not.toMatch(
      /fixture-candidate|op:\/\/|hash/
    );
  });

  it("compares selected nested files across repositories without expanding key selection", () => {
    const first = selection([legacy]);
    const second = selection([key], ".env.local", "ai-hedge-fund");
    const result = inspectSelection({
      manifest: { version: 1, sources: [first, second] },
      schema,
      existing: null,
      sources: [
        {
          ...first,
          content: `${legacy}=fixture-match\nQUANTDATA_API_KEY=fixture-unselected\n`,
        },
        { ...second, content: `${key}=fixture-match\n` },
      ],
    });
    expect(result.selectedNames).toEqual([key]);
    expect(result.entries[0]?.equality).toBe("identical");
    return expect(result.entries[0]?.groups[0]?.origins).toEqual([
      { repository: "gamma-forge", path: "forge/.env", kind: "source" },
      { repository: "ai-hedge-fund", path: ".env.local", kind: "source" },
    ]);
  });

  it.each([
    "",
    " ",
    "your_key",
    "replace-me",
    "changeme",
    "example-key",
    "placeholder",
    "dummy",
    "test_key",
    "<insert-key>",
    "${SECRET}",
  ])("excludes empty and placeholder candidates %#", (value) => {
    const result = inspectSelection(input(`${key}='${value}'\n`));
    expect(result.ineligibleNames).toEqual([key]);
    expect(result.eligibleNames).toEqual([]);
    return expect(result.entries[0]).toMatchObject({
      equality: "absent",
      decision: "no-candidate",
      groups: [],
    });
  });

  it("excludes all unresolved references without resolving or comparing them", () => {
    const result = inspectSelection(
      input(
        `${key}=op://fixture/provider/key\n${key}=' op://fixture/other/key'\n${key}=fixture-literal\n`
      )
    );
    expect(result.excludedNames).toEqual([key]);
    expect(result.eligibleNames).toEqual([key]);
    expect(result.conflictingNames).toEqual([]);
    expect(result.entries[0]?.equality).toBe("unique");
    return expect(JSON.stringify(result)).not.toMatch(
      /op:\/\/|fixture-literal|fixture\/provider/
    );
  });

  it.each([".env.schema", "app/.env.example"])(
    "does not ingest template literals from %s",
    (path) => {
      const result = inspectSelection(
        input(`${key}=fixture-template\n`, [key], path)
      );
      expect(result.ineligibleNames).toEqual([key]);
      return expect(result.entries[0]?.observations[0]?.reason).toBe(
        "template"
      );
    }
  );

  it("makes every reviewed unsupported name explicitly deferred, not silently dropped or aliased", () => {
    const names = [
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "AUTH_SECRET",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "IB_GATEWAY_HOST",
      "COMPOSER_API_KEY",
      "COMPOSER_TRADE_API_KEY",
      "QUANTPAD_API_KEY",
      "UNKNOWN_REVIEWED_NAME",
    ];
    const result = inspectSelection(
      input(names.map((name) => `${name}=fixture-deferred\n`).join(""), names)
    );
    expect(result.deferredNames).toEqual([...names].sort());
    expect(result.eligibleNames).toEqual([]);
    expect(
      result.entries.every(
        (entry) =>
          entry.groups.length === 0 &&
          entry.observations[0]?.reason === "unsupported-name"
      )
    ).toBe(true);
    return expect(JSON.stringify(result)).not.toContain("fixture-deferred");
  });

  it("defers schema gaps and reports explicitly excluded safety/SSH names", () => {
    const result = inspectSelection(
      input(
        "RESEND_API_KEY=fixture-gap\nIBKR_TRADING_MODE=live\nQUANTVPS_SSH_PASSWORD=fixture-ssh\n",
        ["RESEND_API_KEY", "IBKR_TRADING_MODE", "QUANTVPS_SSH_PASSWORD"]
      )
    );
    expect(result.deferredNames).toEqual(["RESEND_API_KEY"]);
    expect(result.excludedNames).toEqual([
      "IBKR_TRADING_MODE",
      "QUANTVPS_SSH_PASSWORD",
    ]);
    return expect(
      result.entries.find((entry) => entry.name === "RESEND_API_KEY")
        ?.observations[0]?.reason
    ).toBe("schema-gap");
  });

  it("does not make missing unsupported or excluded names eligible", () => {
    const result = inspectSelection(
      input(null, ["OPENAI_API_KEY", "IBKR_TRADING_MODE"])
    );
    expect(result.deferredNames).toEqual(["OPENAI_API_KEY"]);
    expect(result.excludedNames).toEqual(["IBKR_TRADING_MODE"]);
    return expect(
      result.entries.every((entry) => entry.decision === "no-candidate")
    ).toBe(true);
  });

  it.each([
    "malformed",
    "mysql://fixture:fixture@branch.pg.psdb.cloud/db",
    "postgresql://fixture:fixture@127.0.0.1/db",
  ])("keeps incompatible database candidates ineligible %#", (value) => {
    const result = inspectSelection(
      input(`DATABASE_URL=${value}\n`, ["DATABASE_URL"])
    );
    expect(result.ineligibleNames).toEqual(["DATABASE_URL"]);
    return expect(result.entries[0]?.observations[0]?.reason).toBe(
      "ineligible-database"
    );
  });

  it("permits only the existing PlanetScale Postgres database boundary", () => {
    const result = inspectSelection(
      input(
        "DATABASE_URL=postgresql://fixture:fixture@branch.pg.psdb.cloud/db\n",
        ["DATABASE_URL"]
      )
    );
    return expect(result.eligibleNames).toEqual(["DATABASE_URL"]);
  });

  it.each([null, "UNSELECTED=fixture-only\n"])(
    "reports a missing selected assignment without discovery %#",
    (content) => {
      const result = inspectSelection(input(content));
      expect(result.ineligibleNames).toEqual([key]);
      return expect(result.entries[0]?.observations[0]?.reason).toBe(
        content === null ? "missing-file" : "missing-key"
      );
    }
  );

  it("retains master precedence while exposing conflicting sources without replacing it", () => {
    const request = {
      ...input(`${key}=fixture-new\n`),
      existing: `${key}=fixture-master\n`,
    };
    const result = inspectSelection(request);
    expect(result.conflictingNames).toEqual([key]);
    expect(result.entries[0]?.decision).toBe("retain-existing-master");
    expect(result.entries[0]?.groups[1]?.origins).toEqual([
      { repository: null, path: "private/configuration/.env", kind: "master" },
    ]);
    expect(request.existing).toBe(`${key}=fixture-master\n`);
    return expect(JSON.stringify(result)).not.toMatch(
      /fixture-master|fixture-new/
    );
  });

  it("retains an existing master reference but excludes it from candidate equality", () => {
    const result = inspectSelection({
      ...input(null),
      existing: `${key}=op://fixture/provider/key\n`,
    });
    expect(result.entries[0]).toMatchObject({
      equality: "absent",
      decision: "retain-existing-master",
      groups: [],
    });
    expect(result.excludedNames).toEqual([key]);
    return expect(JSON.stringify(result)).not.toContain("op://");
  });

  it("rejects ambiguous or invalid master data rather than suggesting replacement", () => {
    expect(() =>
      inspectSelection({
        ...input(null),
        existing: `${key}=fixture-a\n${key}=fixture-b\n`,
      })
    ).toThrow("invalid-master");
    expect(() =>
      inspectSelection({
        ...input(null),
        existing: "NOT_SUPPORTED=fixture-private\n",
      })
    ).toThrow("invalid-master");
    return expect(() =>
      inspectSelection(input("broken fixture-private"))
    ).toThrow("invalid-dotenv");
  });

  return it("rejects collector/manifest mismatches before planning", () => {
    const request = input(null);
    expect(() => inspectSelection({ ...request, sources: [] })).toThrow(
      "invalid-inspection-sources"
    );
    expect(() =>
      inspectSelection({
        ...request,
        sources: [
          { repository: "full-port", path: "forge/.env", content: null },
        ],
      })
    ).toThrow("invalid-inspection-sources");
    return expect(() =>
      inspectSelection({
        ...request,
        sources: [{ repository: "gamma-forge", path: ".env", content: null }],
      })
    ).toThrow("invalid-inspection-sources");
  });
});
