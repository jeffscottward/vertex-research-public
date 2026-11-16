import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  CallProcedure,
  ProcedureResult,
} from "../../../packages/api/src/server/mcp.ts";
import {
  type FrozenMasterRules,
  freezeMasterRules,
  MASTER_RULES_PROCEDURE,
  masterRulesKey,
  readFrozenMasterRules,
} from "./master-rules-freeze.ts";
import type { Recording } from "./recording.ts";

const LIVE: ProcedureResult = { ok: true, value: { live: true } };

const spy = (): { calls: [string, unknown][]; call: CallProcedure } => {
  const calls: [string, unknown][] = [];
  return {
    call: async (procedure, input) => {
      calls.push([procedure, input]);
      return LIVE;
    },
    calls,
  };
};

const frozenWith = (input: unknown, value: unknown): FrozenMasterRules => {
  const key = masterRulesKey(input);
  if (key === null) throw new Error("invalid test input");
  return { note: "", searches: { [key]: value } };
};

describe("master_rules_search freeze", () => {
  it("normalizes the key: defaults filled, keys sorted", () => {
    expect(masterRulesKey({ limit: 5, query: "gap" })).toBe(
      masterRulesKey({ limit: 5, query: "gap" })
    );
    expect(masterRulesKey({ query: "gap" })).toBe(
      masterRulesKey({ limit: 10, query: "gap" })
    );
    expect(masterRulesKey({ limit: 99 })).toBeNull();
  });

  it("replay answers a frozen search without the live pack", async () => {
    const inner = spy();
    const call = freezeMasterRules(
      inner.call,
      frozenWith({ query: "gap" }, { frozen: true }),
      "replay"
    );
    await expect(
      call(MASTER_RULES_PROCEDURE, { query: "gap" })
    ).resolves.toEqual({ ok: true, value: { frozen: true } });
    expect(inner.calls).toEqual([]);
  });

  it("replay refuses a search that is not frozen", async () => {
    const inner = spy();
    const call = freezeMasterRules(
      inner.call,
      { note: "", searches: {} },
      "replay"
    );
    const result = await call(MASTER_RULES_PROCEDURE, { query: "gap" });
    expect(result).toMatchObject({
      code: "EVAL_MASTER_RULES_NOT_FROZEN",
      ok: false,
    });
    expect(inner.calls).toEqual([]);
  });

  it("record freezes a new search once and passes other procedures through", async () => {
    const inner = spy();
    const frozen: FrozenMasterRules = { note: "", searches: {} };
    const call = freezeMasterRules(inner.call, frozen, "record");
    await expect(
      call(MASTER_RULES_PROCEDURE, { query: "gap" })
    ).resolves.toEqual(LIVE);
    await expect(
      call(MASTER_RULES_PROCEDURE, { query: "gap" })
    ).resolves.toEqual(LIVE);
    await call("semanticTerms/list", {});
    await call(MASTER_RULES_PROCEDURE, { limit: 99 });
    expect(inner.calls.map(([procedure]) => procedure)).toEqual([
      MASTER_RULES_PROCEDURE,
      "semanticTerms/list",
      MASTER_RULES_PROCEDURE,
    ]);
    expect(Object.values(frozen.searches)).toEqual([{ live: true }]);
  });

  it("the fixture holds every master_rules_search in the recording", () => {
    const recording: Recording = JSON.parse(
      readFileSync(
        new URL("./eval-recording.fixture.json", import.meta.url),
        "utf8"
      )
    );
    const frozen = readFrozenMasterRules();
    const searches = recording.trials.flatMap((trial) =>
      trial.completions.flatMap((completion) =>
        completion.toolCalls
          .filter((toolCall) => toolCall.name === "master_rules_search")
          .map((toolCall) => masterRulesKey(JSON.parse(toolCall.arguments)))
      )
    );
    expect(searches.length).toBeGreaterThan(0);
    for (const key of searches) {
      expect(key !== null && Object.hasOwn(frozen.searches, key)).toBe(true);
    }
  });
});
