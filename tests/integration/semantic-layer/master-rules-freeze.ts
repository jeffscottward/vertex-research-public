// The eval harness answers master_rules_search from a frozen fixture, not from the generated
// master-rule pack. Each pack rebuild (research/master-rules/build-master-rule-pack.mjs) changes the
// generated index, so a live search changed the tool result, the input digest of the next model call
// and made every recorded trial that calls master_rules_search stale (PR #272: H2.1-H2.3).
//
// master-rules.fixture.json maps one normalized search input to the value that masterRules/search
// returned when it was frozen. Replays read only this file. The recorder (record.ts) also reads it
// first; for a search that is not frozen yet it calls the live procedure once and adds the value, so a
// new recording freezes the results it saw. Synthetic eval input; the values are advisory research
// text from the committed pack, no account data.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MasterRulesSearchInputSchema } from "../../../packages/api/src/contracts/master-rules.ts";
import type {
  CallProcedure,
  ProcedureResult,
} from "../../../packages/api/src/server/mcp.ts";

export const MASTER_RULES_PROCEDURE = "masterRules/search";

export const MASTER_RULES_FIXTURE = fileURLToPath(
  new URL("./master-rules.fixture.json", import.meta.url)
);

const NOTE =
  "Frozen masterRules/search results for the semantic-layer eval (master-rules-freeze.ts). Keys are normalized search inputs. bun run eval:semantic:record adds a search that is not frozen yet; delete an entry to freeze it again from the current pack.";

export type FrozenMasterRules = Readonly<{
  note: string;
  searches: Record<string, unknown>;
}>;

/** The fixture key of one search: the schema-normalized input with sorted keys. */
export const masterRulesKey = (input: unknown): string | null => {
  const parsed = MasterRulesSearchInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const value: Record<string, unknown> = parsed.data;
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]])
    )
  );
};

export const readFrozenMasterRules = (
  path: string = MASTER_RULES_FIXTURE
): FrozenMasterRules => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("searches" in parsed) ||
    typeof parsed.searches !== "object" ||
    parsed.searches === null
  ) {
    throw new Error(`${path}: expected { note, searches }`);
  }
  return { note: NOTE, searches: { ...parsed.searches } };
};

export const writeFrozenMasterRules = (
  frozen: FrozenMasterRules,
  path: string = MASTER_RULES_FIXTURE
): void => {
  const searches = Object.fromEntries(
    Object.keys(frozen.searches)
      .sort()
      .map((key) => [key, frozen.searches[key]])
  );
  writeFileSync(
    `${path}.tmp`,
    `${JSON.stringify({ note: NOTE, searches }, null, 2)}\n`
  );
  renameSync(`${path}.tmp`, path);
};

/**
 * Wraps a procedure caller so masterRules/search reads the frozen fixture. mode "replay" refuses a
 * search that is not frozen; mode "record" calls the live procedure once and adds its value.
 * Invalid input goes to the live procedure, which returns the same validation error as in production.
 */
export const freezeMasterRules = (
  inner: CallProcedure,
  frozen: FrozenMasterRules,
  mode: "record" | "replay"
): CallProcedure => {
  return async (procedure, input): Promise<ProcedureResult> => {
    if (procedure !== MASTER_RULES_PROCEDURE) return inner(procedure, input);
    const key = masterRulesKey(input);
    if (key === null) return inner(procedure, input);
    if (Object.hasOwn(frozen.searches, key)) {
      return { ok: true, value: frozen.searches[key] };
    }
    if (mode === "replay") {
      return {
        code: "EVAL_MASTER_RULES_NOT_FROZEN",
        message: `master_rules_search ${key} is not in master-rules.fixture.json; run bun run eval:semantic:record to freeze it`,
        ok: false,
        status: 500,
      };
    }
    const result = await inner(procedure, input);
    if (result.ok) frozen.searches[key] = result.value;
    return result;
  };
};
