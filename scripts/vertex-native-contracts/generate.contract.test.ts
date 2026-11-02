import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "../../packages/shared/src/vertex/index.ts";
import {
  buildVertexContractDocument,
  parseReplayableEventEnvelope,
  VERTEX_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex.ts";
import {
  parseExecutionProjection,
  parsePortfolioGenesis,
  PortfolioSnapshotSchema,
  VERTEX_CONTROL_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex-control.ts";
import {
  parseNativeFactProjection,
  parseNativeJournalProof,
  VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex-native-facts.ts";
import type { NativeFactProjection } from "../../packages/api/src/contracts/vertex-native-facts.ts";
import { VERTEX_WORKER_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-worker.ts";
import {
  parseRuntimePolicySelection,
  VERTEX_POLICY_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex-policy.ts";
import {
  parseModelUseRequest,
  VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex-model-use.ts";
import {
  computeNativeOutboxReplayGrantHash,
  parseNativeOutboxReplay,
  parsePortfolioEpochTransition,
  VERTEX_EPOCH_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex-worker-epoch.ts";
import {
  AUTHORITATIVE_SOURCE_PATHS,
  canonicalJsonSha256,
  generateNativeContractBundle,
  INVARIANT_PATH,
  rawBytesSha256,
  readRepositorySource,
  validateInvariantMetadata,
} from "./generate.ts";
import type {
  NativeContractBundle,
  NativeInvariantMetadata,
  SourceReader,
} from "./generate.ts";
import {
  assertPrograms,
  assertSupportedSchema,
  MAX_STRING_BYTES,
  normalizeIntegerLiteralSchemas,
  parseStrictJson,
} from "./portable.ts";
import {
  evaluateFixtureProgram,
  evaluateReplayFixture,
} from "./reference-fixture.ts";
import {
  buildNativeCapacityFixtures,
  buildNativeContractFixtures,
} from "./fixtures.ts";
import { buildNativeFactsFixtures } from "./native-facts-fixtures.ts";

const registry = {
  ...VERTEX_CONTRACT_SCHEMAS,
  ...VERTEX_CONTROL_CONTRACT_SCHEMAS,
  ...VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS,
  ...VERTEX_WORKER_CONTRACT_SCHEMAS,
  ...VERTEX_POLICY_CONTRACT_SCHEMAS,
  ...VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
  ...VERTEX_EPOCH_CONTRACT_SCHEMAS,
  PortfolioGenesis: PortfolioSnapshotSchema,
};
const metadata = async (): Promise<NativeInvariantMetadata> => {
  return parseStrictJson(
    await readFile(new URL("./invariants-v1.json", import.meta.url))
  ) as NativeInvariantMetadata;
};
const encoder = new TextEncoder();
const sourceAccepted = async (
  contract: string,
  payload: unknown
): Promise<boolean> => {
  try {
    canonicalArtifactJson(payload);
    const schema = registry[contract as keyof typeof registry];
    if (!schema?.safeParse(payload).success) return false;
    if (contract === "EventEnvelope")
      await parseReplayableEventEnvelope(payload);
    if (contract === "ExecutionProjection")
      await parseExecutionProjection(payload);
    if (contract === "PortfolioGenesis") await parsePortfolioGenesis(payload);
    if (contract === "NativeFactProjection")
      await parseNativeFactProjection(payload);
    if (contract === "RuntimePolicySelection")
      await parseRuntimePolicySelection(payload);
    if (contract === "ModelUseRequest") await parseModelUseRequest(payload);
    if (contract === "PortfolioEpochTransition")
      await parsePortfolioEpochTransition(payload);
    if (contract === "NativeOutboxReplay")
      await parseNativeOutboxReplay(payload);
    return true;
  } catch {
    return false;
  }
};

const portableAccepted = async (
  programs: Record<string, unknown>,
  contract: string,
  payload: unknown
): Promise<boolean> => {
  try {
    canonicalArtifactJson(payload);
    const schema = registry[contract as keyof typeof registry];
    if (
      !(
        schema?.safeParse(payload).success &&
        (await evaluateFixtureProgram(programs, contract, payload))
      )
    )
      return false;
    if (contract === "NativeOutboxReplay")
      return evaluateReplayFixture(programs, payload, (name, value) =>
        portableAccepted(programs, name, value)
      );
    return true;
  } catch {
    return false;
  }
};

// Authored only. These tests must not be executed until the parent authorizes
// the deferred verification phase. No environment, provider or broker access.
// Bundle generation runs the portable evaluator over every registry; under a
// fully loaded runner that takes seconds, which is not a latency claim.
describe("portable native source bridge", { timeout: 60_000 }, () => {
  it("covers every frozen base and control registry exactly", async () => {
    const rules = await metadata();
    expect(Object.keys(rules.contractRules).sort()).toEqual(
      Object.keys(registry).sort()
    );
    expect(() =>
      validateInvariantMetadata(rules, Object.keys(registry), rules.sourcePins)
    ).not.toThrow();
    for (const path of AUTHORITATIVE_SOURCE_PATHS) {
      expect(await rawBytesSha256(await readRepositorySource(path))).toBe(
        rules.sourcePins[path]
      );
    }
  });

  it("derives all structural shapes from authoritative input JSON Schema, deterministically", async () => {
    const first = await generateNativeContractBundle();
    const second = await generateNativeContractBundle();
    expect(first).toEqual(second);
    const bundle = parseStrictJson(first) as NativeContractBundle;
    expect(Object.keys(bundle).sort()).toEqual(
      [
        "bundleFormat",
        "schemaVersion",
        "hashProfile",
        "semanticProfile",
        "sources",
        "schemas",
        "programs",
        "contractRules",
        "programDigest",
        "sourceDigest",
      ].sort()
    );
    expect(bundle.bundleFormat).toBe("vertex-native-contract-bundle-v1");
    expect(bundle.schemaVersion).toBe("1.0.0");
    expect(bundle.hashProfile).toBe("gamma-json-utf8-safe-integer-v1");
    expect(bundle.semanticProfile).toBe("vertex-invariants-v1");
    // The generator also carries the model-use and epoch registries and
    // normalizes safe-integer literal schemas (`const: 2`) to `integer`.
    const inputSchemas = (
      registry: Record<string, z.ZodType>
    ): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(registry).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema, { io: "input" }),
        ])
      );
    const expected: Record<string, unknown> = {
      ...buildVertexContractDocument().schemas,
      ...inputSchemas(VERTEX_CONTROL_CONTRACT_SCHEMAS),
      ...inputSchemas(VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS),
      ...inputSchemas(VERTEX_WORKER_CONTRACT_SCHEMAS),
      ...inputSchemas(VERTEX_POLICY_CONTRACT_SCHEMAS),
      ...inputSchemas(VERTEX_MODEL_USE_CONTRACT_SCHEMAS),
      ...inputSchemas(VERTEX_EPOCH_CONTRACT_SCHEMAS),
      PortfolioGenesis: z.toJSONSchema(PortfolioSnapshotSchema, {
        io: "input",
      }),
    };
    expect(bundle.schemas).toEqual(
      Object.fromEntries(
        Object.entries(expected).map(([name, schema]) => [
          name,
          normalizeIntegerLiteralSchemas(schema),
        ])
      )
    );
    expect(bundle.programDigest).toBe(
      await canonicalJsonSha256(bundle.programs)
    );
    expect(bundle.sourceDigest).toBe(await canonicalJsonSha256(bundle.sources));
    expect(bundle.sources[INVARIANT_PATH]).toBe(
      await rawBytesSha256(await readRepositorySource(INVARIANT_PATH))
    );
    expect(new TextDecoder().decode(first)).toBe(canonicalArtifactJson(bundle));
    return expect(Object.hasOwn(bundle, "expected_sha256")).toBe(false);
  });

  it("rejects stale source bytes rather than blessing stale semantics", async () => {
    const altered: SourceReader = async (path) => {
      const original = await readRepositorySource(path);
      return path === AUTHORITATIVE_SOURCE_PATHS[0]
        ? encoder.encode(`${new TextDecoder().decode(original)}\n`)
        : original;
    };
    return await expect(generateNativeContractBundle(altered)).rejects.toThrow(
      "Stale invariant source pin"
    );
  });

  it("rejects a source change during explicit generation", async () => {
    const reads = new Map<string, number>();
    const unstable: SourceReader = async (path) => {
      const original = await readRepositorySource(path);
      const count = (reads.get(path) ?? 0) + 1;
      reads.set(path, count);
      return count === 2 && path === INVARIANT_PATH
        ? encoder.encode(`${new TextDecoder().decode(original)} `)
        : original;
    };
    return await expect(generateNativeContractBundle(unstable)).rejects.toThrow(
      "changed during generation"
    );
  });

  it("fails closed on metadata profiles, maps, coverage, calls, cycles and operators", async () => {
    const original = await metadata();
    const rejected = (
      mutate: (value: NativeInvariantMetadata) => void
    ): void => {
      const value = structuredClone(original);
      mutate(value);
      expect(() =>
        validateInvariantMetadata(
          value,
          Object.keys(registry),
          original.sourcePins
        )
      ).toThrow();
    };
    rejected((value) => {
      return (value.semanticProfile = "unknown");
    });
    rejected((value) => {
      delete value.contractRules["Quote"];
    });
    rejected((value) => {
      return (value.contractRules["Future"] = "Quote");
    });
    rejected((value) => {
      return (value.contractRules["Quote"] = "Missing");
    });
    rejected((value) => {
      return (value.sourcePins[AUTHORITATIVE_SOURCE_PATHS[0]] = "A".repeat(64));
    });
    rejected((value) => {
      return (value.sourcePins["extra"] = "a".repeat(64));
    });
    rejected((value) => {
      return (value.programs["Quote"] = ["futureOpcode", true]);
    });
    rejected((value) => {
      return (value.programs["Quote"] = ["call", "Missing", ["get", ""]]);
    });
    rejected((value) => {
      return (value.programs["Quote"] = ["call", "Quote", ["get", ""]]);
    });
    rejected((value) => {
      return (value.programs["Quote"] = ["parent", ""]);
    });
    rejected((value) => {
      return (value.programs["Quote"] = ["index"]);
    });
    rejected((value) => {
      return (value.programs["Quote"] = ["eq", true]);
    });
    rejected((value) => {
      return (value.programs["Quote"] = [
        "hashOmit",
        ["get", ""],
        ["lit", ["x", "x"]],
      ]);
    });
    expect(() =>
      validateInvariantMetadata(
        { ...original, unsupported: true },
        Object.keys(registry),
        original.sourcePins
      )
    ).toThrow();
    expect(() => assertPrograms({ Structural: true })).not.toThrow();
    return expect(() => assertPrograms({ FalseRule: false })).not.toThrow();
  });

  it("rejects unknown or invalid schema semantics at load, including nested keywords", () => {
    for (const schema of [
      { type: "object", unevaluatedProperties: false },
      { type: "array", items: { type: "integer", multipleOf: 2 } },
      { type: "string", format: "email" },
      { type: "number" },
      { type: "string", pattern: "(?=a)a" },
      { $ref: "https://example.invalid/schema" },
      { $ref: "#/$defs/Missing" },
      { minItems: -1 },
    ])
      expect(() => assertSupportedSchema(schema)).toThrow();
  });

  it("source safeParse plus replay/hash helpers agree with all explicit fixtures", async () => {
    const document = await buildNativeContractFixtures();
    const programs = (await metadata()).programs;
    const covered = new Set(
      document.cases.filter((test) => test.valid).map((test) => test.contract)
    );
    expect([...covered].sort()).toEqual(Object.keys(registry).sort());
    for (const test of document.cases) {
      expect(await sourceAccepted(test.contract, test.payload), test.name).toBe(
        test.valid
      );
      let structurallyValid = false;
      try {
        structurallyValid = registry[
          test.contract as keyof typeof registry
        ].safeParse(test.payload).success;
      } catch {
        // Source refinement helpers may throw on an already-invalid calendar;
        // parity is rejection, never acceptance or coercion.
        structurallyValid = false;
      }
      let semantic = false;
      try {
        semantic = await evaluateFixtureProgram(
          programs,
          test.contract,
          test.payload
        );
        if (semantic && test.contract === "NativeOutboxReplay")
          semantic = await evaluateReplayFixture(
            programs,
            test.payload,
            (name, value) => portableAccepted(programs, name, value)
          );
      } catch {
        semantic = false;
      }
      expect(structurallyValid && semantic, test.name).toBe(test.valid);
    }
  }, 60_000);

  it("checks semantic-negative fixtures independently of source refinements", async () => {
    const document = await buildNativeContractFixtures();
    const programs = (await metadata()).programs;
    // Structural-only invalid cases are source-schema territory. These are
    // explicit IR failures even when a loose JSON Schema would allow them.
    for (const name of [
      "Quote/bid",
      "Quote/source.entitlement.checkedAt",
      "TradeFlow/quantity",
      "StrategySpec/riskLimits.maximumLoss",
      "BacktestRun/leakageChecks.0.evidenceId",
      "KnowledgeImport/duplicateMappings.0.canonicalSourceId",
      "KnowledgeImport/unbound-content-hash",
      "KnowledgeImport/unlisted-source-hash",
      "KnowledgeImport/self-duplicate",
      "TradeIntent/limitPrice",
      "ExecutionReceipt/remainingQuantity",
      "EventEnvelope/producer-time-is-bound",
      "ExecutionProjection/receipt-time-is-bound",
      "PortfolioSnapshot/lots.0.openedAt",
      "PaperSimulationAdmission/maximumLoss",
    ]) {
      const test = document.cases.find((entry) => entry.name === name)!;
      expect(test, name).toBeDefined();
      let accepted = false;
      try {
        accepted = await evaluateFixtureProgram(
          programs,
          test.contract,
          test.payload
        );
      } catch {
        accepted = false;
      }
      expect(accepted, name).toBe(false);
    }
  });

  it("preserves strict get/null, lexical parent and isolated call roots", async () => {
    const rules = {
      PresentNull: ["eq", ["get", "value"], null],
      Missing: ["eq", ["get", "absent"], null],
      Scoped: [
        "every",
        ["get", "items"],
        ["some", ["root", "items"], ["eq", ["get", "id"], ["parent", "id"]]],
      ],
      Call: ["call", "PresentNull", ["get", "child"]],
    };
    expect(
      await evaluateFixtureProgram(rules, "PresentNull", { value: null })
    ).toBe(true);
    await expect(
      evaluateFixtureProgram(rules, "Missing", { value: null })
    ).rejects.toThrow("Missing field");
    expect(
      await evaluateFixtureProgram(rules, "Scoped", {
        items: [{ id: "a" }, { id: "b" }],
      })
    ).toBe(true);
    return expect(
      await evaluateFixtureProgram(rules, "Call", {
        value: "outer",
        child: { value: null },
      })
    ).toBe(true);
  });

  it("preserves bounded base64, indexed iteration and integer sums", async () => {
    const rules = {
      Base64: ["gt", ["base64Length", ["get", ""]], 0],
      Indexed: [
        "every",
        ["get", "items"],
        [
          "and",
          ["eq", ["get", "n"], ["index"]],
          [
            "eq",
            ["sum", ["get", "values"], ["add", ["get", ""], ["parent", "n"]]],
            ["get", "expected"],
          ],
          ["eq", ["get", "n"], ["index"]],
          ["eq", ["at", ["root", "labels"], ["index"]], ["get", "label"]],
        ],
      ],
      EmptySum: ["eq", ["sum", ["get", ""], ["get", ""]], 0],
      BadIndex: ["eq", ["at", ["lit", ["a"]], ["get", ""]], "a"],
    };
    expect(await evaluateFixtureProgram(rules, "Base64", "AA==")).toBe(true);
    for (const input of ["", "AB==", "AAB=", "AA", "AA==\n", "_w==", "===="]) {
      await expect(
        evaluateFixtureProgram(rules, "Base64", input)
      ).rejects.toThrow();
    }
    expect(
      await evaluateFixtureProgram(rules, "Indexed", {
        labels: ["a", "b"],
        items: [
          { n: 0, values: [1, 2], expected: 3, label: "a" },
          { n: 1, values: [3], expected: 4, label: "b" },
        ],
      })
    ).toBe(true);
    expect(await evaluateFixtureProgram(rules, "EmptySum", [])).toBe(true);
    for (const index of [-1, 1, "0", null]) {
      await expect(
        evaluateFixtureProgram(rules, "BadIndex", index)
      ).rejects.toThrow();
    }
    expect(() => assertPrograms({ Bad: ["index"] })).toThrow();
    return expect(() =>
      assertPrograms({
        Caller: ["every", ["lit", [1]], ["call", "Bad", ["get", ""]]],
        Bad: ["index"],
      })
    ).toThrow();
  });

  // Capacity fixtures run the portable evaluator over maximum-size payloads;
  // they prove bounded admission, not latency, so they get an explicit budget.
  it("keeps bounded admission capacity fixtures out of hot-path latency claims", async () => {
    const programs = (await metadata()).programs;
    for (const test of await buildNativeCapacityFixtures()) {
      expect(await sourceAccepted(test.contract, test.payload), test.name).toBe(
        test.valid
      );
      expect(
        await portableAccepted(programs, test.contract, test.payload),
        test.name
      ).toBe(test.valid);
    }
  }, 60_000);

  it("limits nested hash omissions to the declared replay boundary", async () => {
    expect(() =>
      assertPrograms({
        Bad: ["hashOmitPaths", ["get", ""], ["lit", ["sourceEventHash"]]],
      })
    ).toThrow();
    expect(() =>
      assertPrograms({
        Bad: [
          "hashOmitPaths",
          ["get", ""],
          ["lit", ["continuity.highWaterEventHash", "sourceEventHash"]],
        ],
      })
    ).toThrow();
    const programs = {
      Missing: [
        "hashOmitPaths",
        ["get", ""],
        ["lit", ["sourceEventHash", "continuity.highWaterEventHash"]],
      ],
    };
    return await expect(
      evaluateFixtureProgram(programs, "Missing", {
        sourceEventHash: "x",
        continuity: {},
      })
    ).rejects.toThrow("Missing hash omission");
  });

  it("replays raw-byte rejection, canonical UTF8/hash and exact signed epoch vectors", async () => {
    const document = await buildNativeContractFixtures();
    for (const test of document.rawByteReject) {
      expect(
        () => parseStrictJson(Buffer.from(test.hex, "hex")),
        test.name
      ).toThrow();
    }
    for (const test of document.codec) {
      expect(canonicalArtifactJson(test.value), test.name).toBe(
        test.canonicalUtf8
      );
      expect(await hashArtifact(test.canonicalUtf8), test.name).toBe(
        test.sha256
      );
    }
    for (const test of document.timestamps) {
      if (test.epochNanoseconds === null) {
        expect(() => timestampToEpochNanoseconds(test.timestamp)).toThrow();
      } else {
        expect(timestampToEpochNanoseconds(test.timestamp).toString()).toBe(
          test.epochNanoseconds
        );
      }
    }
    expect(await canonicalJsonSha256("x")).not.toBe(
      await rawBytesSha256(encoder.encode("x"))
    );
    expect(() =>
      parseStrictJson(encoder.encode(`${"[".repeat(65)}0${"]".repeat(65)}`))
    ).toThrow();
    return expect(() =>
      parseStrictJson(encoder.encode(`"${"x".repeat(MAX_STRING_BYTES + 1)}"`))
    ).toThrow();
  });

  it("checks policy pin refinements independently from the selection hash", async () => {
    const document = await buildNativeContractFixtures();
    const programs = (await metadata()).programs;
    const negatives = [
      "sourcePins",
      "modules",
      "policies",
      "configuration.1.group",
      "references",
      "providerCapabilities",
      "artifacts.1.bindingId",
      "configuration.0.referenceIds",
      "configuration.0.provenanceSourceIds",
      "references.0.accountAlias",
      "references.0.expiresAt",
      "references.0.lastVerifiedAt",
      "providerCapabilities.0.endpointReferenceId",
      "providerCapabilities.0.rightsPolicyId",
      "endpoint-reference-digest-mismatch-rehashed",
      "review.policyId",
      "research.moduleId",
      "research.modelVersion",
      "research.costBudgetUsd",
      "simulation.maximumLoss",
      "missing-role-tool",
      "missing-role-risk",
      "missing-role-review",
      "research-cannot-simulate",
    ];
    for (const suffix of negatives) {
      const name = `RuntimePolicySelection/${suffix}`;
      const test = document.cases.find((entry) => entry.name === name)!;
      expect(test, name).toBeDefined();
      let valid = false;
      try {
        valid = await evaluateFixtureProgram(
          programs,
          "RuntimePolicySelectionSemantics",
          test.payload
        );
      } catch {
        valid = false;
      }
      expect(valid, name).toBe(false);
    }
  });

  it("replays paired canonical native journal proof bytes without promoting hashes to authentication", async () => {
    const document = await buildNativeFactsFixtures();
    const programs = (await metadata()).programs;
    for (const test of document.proofs) {
      let valid = false;
      try {
        await parseNativeJournalProof(
          test.projection as NativeFactProjection,
          Uint8Array.from(Buffer.from(test.proofHex, "hex"))
        );
        valid = true;
      } catch {
        valid = false;
      }
      expect(valid, test.name).toBe(test.valid);
      let expressionValid = false;
      try {
        const bytes = Uint8Array.from(Buffer.from(test.proofHex, "hex"));
        const proof = parseStrictJson(bytes, 1_048_576);
        const projection = test.projection as NativeFactProjection;
        expressionValid =
          bytes.length > 0 &&
          canonicalArtifactJson(proof) ===
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes
            ) &&
          (await hashArtifact(bytes)) === projection.proof.sha256 &&
          registry.NativeFactProjection.safeParse(projection).success &&
          registry.NativeJournalProof.safeParse(proof).success &&
          (await evaluateFixtureProgram(
            programs,
            "NativeFactProjection",
            projection
          )) &&
          (await evaluateFixtureProgram(
            programs,
            "NativeJournalProof",
            proof
          )) &&
          (await evaluateFixtureProgram(programs, "NativeJournalProofBinding", {
            projection,
            proof,
          }));
      } catch {
        expressionValid = false;
      }
      expect(expressionValid, `${test.name}/portable-binding`).toBe(test.valid);
    }
    const projection = document.proofs[0]!.projection as NativeFactProjection;
    await expect(
      parseNativeJournalProof(projection, new Uint8Array())
    ).rejects.toThrow();
    await expect(
      parseNativeJournalProof(projection, new Uint8Array(1_048_577))
    ).rejects.toThrow();
    expect(projection.sequence).toBe("2");
    expect(projection.proofJournalSequence).toBe("9");
    expect(
      registry.NativeFactProjection.safeParse({
        ...projection,
        factOrdinal: -0,
      }).success
    ).toBe(false);
    const proof = parseStrictJson(
      Uint8Array.from(Buffer.from(document.proofs[0]!.proofHex, "hex"))
    ) as Record<string, unknown>;
    return expect(
      registry.NativeJournalProof.safeParse({ ...proof, factOrdinal: -0 })
        .success
    ).toBe(false);
  });

  it("binds retained transition scope and hashes every grant field except approval bytes", async () => {
    const cases = (await buildNativeContractFixtures()).cases;
    const retained = cases.find(
      (entry) =>
        entry.name ===
        "NativeOutboxReplay/retained-transition-one-to-two-replayed-two-to-three"
    )?.payload as {
      grant: Record<string, unknown>;
      retainedEpochTransitionBase64: string;
    };
    const transition = parseStrictJson(
      Buffer.from(retained.retainedEpochTransitionBase64, "base64")
    );
    const programs = (await metadata()).programs;
    expect(
      await evaluateFixtureProgram(
        programs,
        "NativeReplayRetainedTransitionBinding",
        { grant: retained.grant, transition }
      )
    ).toBe(true);
    for (const [field, value] of [
      ["priorOwnerEpoch", "3"],
      ["accountAlias", "other-account"],
      ["streamId", "other-stream"],
    ]) {
      expect(
        await evaluateFixtureProgram(
          programs,
          "NativeReplayRetainedTransitionBinding",
          { grant: { ...retained.grant, [field!]: value }, transition }
        )
      ).toBe(false);
    }
    const body = { ...retained.grant };
    delete body["approvalBase64"];
    const hash = await computeNativeOutboxReplayGrantHash(retained.grant);
    expect(hash).toBe(await canonicalJsonSha256(body));
    expect(
      await computeNativeOutboxReplayGrantHash({
        ...retained.grant,
        approvalBase64: "AQ==",
      })
    ).toBe(hash);
    return expect(
      await computeNativeOutboxReplayGrantHash({
        ...retained.grant,
        retainedEpochTransitionSha256: null,
      })
    ).not.toBe(hash);
  });
});
