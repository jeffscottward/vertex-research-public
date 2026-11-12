import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  backtestResults,
  strategies,
  strategyPresets,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import { createStrategyLibraryRepository } from "./repositories.ts";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";
import {
  normalizeStrategyExternalValidation,
  normalizeStrategyParams,
  normalizeStrategyPresetValues,
  normalizeStrategyPriority,
  normalizeStrategySourceRef,
  normalizeStrategyTags,
  parseStoredStrategyFields,
  StrategyInputError,
  slugifyStrategyName,
} from "./strategy-library.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const dialect = new PgDialect();

interface Operation {
  conflict?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  kind: string;
  locked?: boolean;
  orderBy?: SQL[];
  set?: Record<string, unknown>;
  table?: unknown;
  values?: Record<string, unknown>;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued outcome.
const createDouble = (
  outcomes: Array<readonly Record<string, unknown>[] | Error>
) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      where: (condition: SQL | undefined) => {
        if (!(condition === undefined)) operation.where = condition;
        return chain;
      },
      orderBy: (...order: SQL[]) => {
        operation.orderBy = order;
        return chain;
      },
      limit: () => chain,
      for: () => {
        operation.locked = true;
        return chain;
      },
      values: (values: Record<string, unknown>) => {
        operation.values = values;
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      onConflictDoUpdate: (conflict: Record<string, unknown>) => {
        operation.conflict = conflict;
        return chain;
      },
      returning: () => chain,
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const outcome = outcomes.shift() ?? [];
        return (
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome)
        ).then(resolve, reject);
      },
    };
    operations.push(operation);
    return chain;
  };
  const database: Record<string, unknown> = {
    select: (fields?: Record<string, unknown>) =>
      builder({ kind: "select", ...(fields === undefined ? {} : { fields }) }),
    selectDistinctOn: () => builder({ kind: "selectDistinctOn" }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    update: (table: unknown) => builder({ kind: "update", table }),
    delete: (table: unknown) => builder({ kind: "delete", table }),
    transaction: (operation: (transaction: unknown) => Promise<unknown>) =>
      operation(database),
  };
  return { database: database as unknown as Database, operations };
};

const pgError = (code: string) => {
  return new DrizzleQueryError(
    "query",
    [],
    Object.assign(new Error("pg"), { code })
  );
};

// What every stored strategy row carries since migration 0065.
const plain = { priority: "normal", externalValidation: null };
const ADDED_BY_0065 = [
  "priority",
  "external_validation",
  "strategies_priority_check",
  "strategies_external_validation_check",
];
const claim = {
  sourceUrl: "https://youtu.be/XLMG6-SATRk",
  sourceTitle: "I Backtested 10,000 Strategies",
  sourceAuthor: "Lil Fish, YouTube",
  publishedOn: "2026-09-24",
  claimedMethod: "10,500 strategies ranked by total net R.",
  claimedMetrics: [
    { label: "Rank", value: "1 of 10,500" },
    { label: "Win rate", value: "14%" },
  ],
};

const lookback = {
  name: "lookback",
  type: "integer",
  title: "Lookback bars",
  default: 20,
  min: 5,
  max: 250,
  step: 1,
};
const threshold = {
  name: "threshold",
  type: "decimal",
  title: "Entry threshold",
  default: 0.5,
  min: 0,
  max: 1,
};
const useStops = {
  name: "use_stops",
  type: "boolean",
  title: "Use stops",
  default: true,
};
const venue = {
  name: "venue",
  type: "choice",
  title: "Venue",
  default: "cme",
  options: ["cme", "cboe"],
};
const params = normalizeStrategyParams([lookback, threshold, useStops, venue]);

describe("strategy params schema", () => {
  it("keeps valid integer, decimal, boolean and choice parameters in a stable shape", () => {
    expect(params).toEqual([lookback, threshold, useStops, venue]);
    expect(
      normalizeStrategyParams([{ ...threshold, min: null, max: undefined }])
    ).toEqual([
      {
        name: "threshold",
        type: "decimal",
        title: "Entry threshold",
        default: 0.5,
      },
    ]);
    return expect(normalizeStrategyParams([])).toEqual([]);
  });

  it("rejects defaults outside bounds, wrong default types and inverted bounds", () => {
    expect(() =>
      normalizeStrategyParams([{ ...lookback, default: 300 }])
    ).toThrow(/params\[0\]\.default must be at most 250/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, default: 4 }])
    ).toThrow(/at least 5/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, default: 20.5 }])
    ).toThrow(/default must be an integer/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, min: 10, max: 5, default: 7 }])
    ).toThrow(/min must not exceed max/);
    expect(() => normalizeStrategyParams([{ ...threshold, step: 0 }])).toThrow(
      /step must be positive/
    );
    expect(() =>
      normalizeStrategyParams([{ ...useStops, default: "yes" }])
    ).toThrow(/true or false/);
    expect(() =>
      normalizeStrategyParams([{ ...venue, default: "ice" }])
    ).toThrow(/one of cme, cboe/);
    return expect(() =>
      normalizeStrategyParams([{ ...lookback, default: undefined }])
    ).toThrow(/default is required/);
  });

  it("allows options only on choice parameters and bounds only on numeric ones", () => {
    expect(() =>
      normalizeStrategyParams([{ ...lookback, options: ["a"] }])
    ).toThrow(/options is not allowed for integer/);
    expect(() => normalizeStrategyParams([{ ...useStops, min: 0 }])).toThrow(
      /min is not allowed for boolean/
    );
    expect(() => normalizeStrategyParams([{ ...venue, max: 3 }])).toThrow(
      /max is not allowed for choice/
    );
    expect(() => normalizeStrategyParams([{ ...venue, options: [] }])).toThrow(
      /non-empty array/
    );
    return expect(() =>
      normalizeStrategyParams([{ ...venue, options: ["cme", "cme"] }])
    ).toThrow(/unique/);
  });

  return it("requires identifier names that are unique, known fields, a title and at most 60 entries", () => {
    expect(() =>
      normalizeStrategyParams([lookback, { ...threshold, name: "Lookback" }])
    ).toThrow(/duplicates another parameter/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, name: "1x" }])
    ).toThrow(/identifier/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, name: "bad-name" }])
    ).toThrow(/identifier/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, unit: "bars" }])
    ).toThrow(/unit is not a recognized field/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, title: " " }])
    ).toThrow(/title must not be blank/);
    expect(() =>
      normalizeStrategyParams([{ ...lookback, type: "float" }])
    ).toThrow(/type must be one of/);
    expect(() =>
      normalizeStrategyParams(
        Array.from({ length: 61 }, (_, index) => ({
          ...useStops,
          name: `p${index}`,
        }))
      )
    ).toThrow(/60/);
    return expect(() => normalizeStrategyParams({})).toThrow(
      StrategyInputError
    );
  });
});

describe("strategy preset values", () => {
  it("accepts a typed subset of the schema", () =>
    expect(
      normalizeStrategyPresetValues(
        { lookback: 50, venue: "cboe", use_stops: false },
        params
      )
    ).toEqual({ lookback: 50, venue: "cboe", use_stops: false }));

  return it("rejects unknown names, wrong types, out-of-bounds values and empty presets", () => {
    expect(() =>
      normalizeStrategyPresetValues({ lookbak: 50 }, params)
    ).toThrow(/lookbak is not a parameter/);
    expect(() =>
      normalizeStrategyPresetValues({ lookback: "50" }, params)
    ).toThrow(/values\.lookback must be an integer/);
    expect(() =>
      normalizeStrategyPresetValues({ lookback: 251 }, params)
    ).toThrow(/at most 250/);
    expect(() =>
      normalizeStrategyPresetValues({ threshold: -0.1 }, params)
    ).toThrow(/at least 0/);
    expect(() =>
      normalizeStrategyPresetValues({ use_stops: 1 }, params)
    ).toThrow(/true or false/);
    expect(() =>
      normalizeStrategyPresetValues({ venue: "ice" }, params)
    ).toThrow(/one of cme, cboe/);
    expect(() => normalizeStrategyPresetValues({}, params)).toThrow(
      /at least one/
    );
    return expect(() => normalizeStrategyPresetValues([], params)).toThrow(
      /must be an object/
    );
  });
});

describe("strategy fields", () => {
  it("derives slugs from names", () => {
    expect(slugifyStrategyName("Jump model (v2)")).toBe("jump-model-v2");
    expect(slugifyStrategyName("  Zero--DTE  ")).toBe("zero-dte");
    expect(slugifyStrategyName("--- a --- b ---")).toBe("a-b");
    // The cut at the length limit can leave one "-" at the end; it is removed.
    expect(slugifyStrategyName(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
    // CodeQL js/polynomial-redos (alert 22): a long run of "-" is trimmed in linear time.
    const started = performance.now();
    expect(slugifyStrategyName(`${"-".repeat(1_000_000)}a`)).toBe("a");
    expect(() => slugifyStrategyName("-".repeat(1_000_000))).toThrow(
      /derive a slug/
    );
    expect(performance.now() - started).toBeLessThan(2000);
    return expect(() => slugifyStrategyName("—")).toThrow(/derive a slug/);
  });

  it("accepts repository-relative source refs with an optional revision only", () => {
    expect(
      normalizeStrategySourceRef("services/research/strategies/hmm.py")
    ).toBe("services/research/strategies/hmm.py");
    expect(
      normalizeStrategySourceRef("services/research/strategies/hmm.py@36ca13b")
    ).toBe("services/research/strategies/hmm.py@36ca13b");
    expect(normalizeStrategySourceRef(" ")).toBeNull();
    expect(normalizeStrategySourceRef(undefined)).toBeUndefined();
    for (const bad of [
      "/etc/passwd",
      "../secrets.py",
      "a/../b.py",
      "a//b.py",
      "https://x.test/a.py",
      "dir/",
      "a.py@",
      "a.py@bad rev",
    ]) {
      expect(() => normalizeStrategySourceRef(bad), bad).toThrow(/sourceRef/);
    }
  });

  it("accepts normal and high priority only", () => {
    expect(normalizeStrategyPriority("normal")).toBe("normal");
    expect(normalizeStrategyPriority("high")).toBe("high");
    for (const bad of ["urgent", "", "HIGH", 1, null, undefined]) {
      expect(() => normalizeStrategyPriority(bad), String(bad)).toThrow(
        /priority must be one of normal, high/
      );
    }
    return expect(() => normalizeStrategyPriority("low")).toThrow(
      StrategyInputError
    );
  });

  it("keeps a valid external claim, trims its text and passes null and undefined through", () => {
    expect(normalizeStrategyExternalValidation(claim)).toEqual(claim);
    expect(
      normalizeStrategyExternalValidation({
        ...claim,
        sourceTitle: "  Padded title ",
        claimedMetrics: [{ label: " Rank ", value: " 1 " }],
      })
    ).toEqual({
      ...claim,
      sourceTitle: "Padded title",
      claimedMetrics: [{ label: "Rank", value: "1" }],
    });
    expect(normalizeStrategyExternalValidation(null)).toBeNull();
    expect(normalizeStrategyExternalValidation(undefined)).toBeUndefined();
    return expect(
      normalizeStrategyExternalValidation({
        ...claim,
        claimedMetrics: Array.from({ length: 12 }, (_, index) => ({
          label: `m${index}`,
          value: "v",
        })),
      })?.claimedMetrics
    ).toHaveLength(12);
  });

  it("rejects each invalid external claim field", () => {
    const metric = { label: "Rank", value: "1" };
    const cases: [unknown, RegExp][] = [
      ["a claim", /externalValidation must be an object/],
      [[claim], /externalValidation must be an object/],
      [{ ...claim, verified: true }, /externalValidation\.verified is not/],
      [
        { ...claim, sourceUrl: "http://youtu.be/x" },
        /sourceUrl must be an https URL/,
      ],
      [{ ...claim, sourceUrl: "not a url" }, /sourceUrl must be an https URL/],
      [{ ...claim, sourceUrl: 7 }, /sourceUrl must be a string/],
      [
        { ...claim, sourceUrl: `https://x.test/${"a".repeat(300)}` },
        /sourceUrl must not exceed 300/,
      ],
      [{ ...claim, sourceTitle: " " }, /sourceTitle must not be blank/],
      [
        { ...claim, sourceTitle: "t".repeat(201) },
        /sourceTitle must not exceed 200/,
      ],
      [{ ...claim, sourceAuthor: undefined }, /sourceAuthor must be a string/],
      [
        { ...claim, sourceAuthor: "a".repeat(121) },
        /sourceAuthor must not exceed 120/,
      ],
      [
        { ...claim, publishedOn: "24.09.2026" },
        /publishedOn must be a calendar date/,
      ],
      [
        { ...claim, publishedOn: "2026-13-01" },
        /publishedOn must be a calendar date/,
      ],
      [
        { ...claim, publishedOn: "2026-02-30" },
        /publishedOn must be a calendar date/,
      ],
      [
        { ...claim, publishedOn: 20_260_924 },
        /publishedOn must be a calendar date/,
      ],
      [{ ...claim, claimedMethod: "" }, /claimedMethod must not be blank/],
      [
        { ...claim, claimedMethod: "m".repeat(1001) },
        /claimedMethod must not exceed 1000/,
      ],
      [
        { ...claim, claimedMethod: "line\nbreak" },
        /claimedMethod must not contain control/,
      ],
      [
        { ...claim, claimedMetrics: [] },
        /claimedMetrics must be a non-empty array/,
      ],
      [
        { ...claim, claimedMetrics: "Rank 1" },
        /claimedMetrics must be a non-empty array/,
      ],
      [
        { ...claim, claimedMetrics: Array.from({ length: 13 }, () => metric) },
        /claimedMetrics must not exceed 12 entries/,
      ],
      [
        { ...claim, claimedMetrics: ["Rank 1"] },
        /claimedMetrics\[0\] must be an object/,
      ],
      [
        { ...claim, claimedMetrics: [{ ...metric, unit: "R" }] },
        /claimedMetrics\[0\]\.unit is not a recognized field/,
      ],
      [
        { ...claim, claimedMetrics: [metric, { label: "", value: "1" }] },
        /claimedMetrics\[1\]\.label must not be blank/,
      ],
      [
        { ...claim, claimedMetrics: [{ label: "l".repeat(61), value: "1" }] },
        /label must not exceed 60/,
      ],
      [
        {
          ...claim,
          claimedMetrics: [{ label: "Rank", value: "v".repeat(81) }],
        },
        /value must not exceed 80/,
      ],
      [
        { ...claim, claimedMetrics: [{ label: "Rank" }] },
        /claimedMetrics\[0\]\.value must be a string/,
      ],
    ];
    for (const [value, message] of cases) {
      expect(
        () => normalizeStrategyExternalValidation(value),
        String(message)
      ).toThrow(message);
    }
  });

  it("parses the stored priority and claim of a row and refuses a stored value that does not parse", () => {
    expect(parseStoredStrategyFields(plain)).toEqual(plain);
    expect(
      parseStoredStrategyFields({ priority: "high", externalValidation: claim })
    ).toEqual({ priority: "high", externalValidation: claim });
    expect(() =>
      parseStoredStrategyFields({ priority: "normal", externalValidation: {} })
    ).toThrow(/externalValidation\.sourceUrl must be a string/);
    return expect(() => parseStoredStrategyFields({})).toThrow(/priority/);
  });

  return it("trims, dedupes and bounds tags", () => {
    expect(normalizeStrategyTags([" regime ", "Regime", "options"])).toEqual([
      "regime",
      "options",
    ]);
    expect(() =>
      normalizeStrategyTags(
        Array.from({ length: 21 }, (_, index) => `t${index}`)
      )
    ).toThrow(/20/);
    expect(() => normalizeStrategyTags(["x".repeat(33)])).toThrow(/32/);
    return expect(() => normalizeStrategyTags([""])).toThrow(/blank/);
  });
});

describe("strategy library repository", () => {
  const deps = { now: () => FIXED_NOW, generateId: () => "gen-1" };

  it("creates with a derived slug and normalized fields", async () => {
    const double = createDouble([[{ id: "gen-1", ...plain }]]);
    await createStrategyLibraryRepository(double.database, deps).create({
      name: " Jump model v2 ",
      kind: "python",
      tags: ["regime"],
      section: " Regime ",
      sourceRef: "services/research/strategies/jump.py",
      params: [lookback],
    });
    const insert = double.operations[0]!;
    expect(insert.table).toBe(strategies);
    return expect(insert.values).toEqual({
      id: "gen-1",
      name: "Jump model v2",
      slug: "jump-model-v2",
      kind: "python",
      status: "idea",
      description: null,
      sourceRef: "services/research/strategies/jump.py",
      tags: ["regime"],
      favorite: false,
      section: "Regime",
      params: [lookback],
      priority: "normal",
      externalValidation: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
  });

  it("maps invalid input and duplicate slugs", async () => {
    const repository = createStrategyLibraryRepository(
      createDouble([]).database
    );
    await expect(
      repository.create({ name: "x", kind: "rust" as never })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.create({
        name: "x",
        kind: "python",
        params: [{ ...lookback, default: 999 }],
      })
    ).rejects.toThrow(/default must be at most 250/);
    const duplicate = createDouble([pgError("23505")]);
    return await expect(
      createStrategyLibraryRepository(duplicate.database).create({
        name: "hmm",
        kind: "python",
      })
    ).rejects.toBeInstanceOf(DatabaseConflictError);
  });

  it("creates and updates the priority and the external claim", async () => {
    const double = createDouble([
      [{ id: "gen-1", priority: "high", externalValidation: claim }],
    ]);
    const created = await createStrategyLibraryRepository(
      double.database,
      deps
    ).create({
      name: "Volume spike breakout",
      kind: "python",
      priority: "high",
      externalValidation: { ...claim, sourceAuthor: " Lil Fish, YouTube " },
    });
    expect(created).toMatchObject({
      priority: "high",
      externalValidation: claim,
    });
    expect(double.operations[0]!.values).toMatchObject({
      priority: "high",
      externalValidation: claim,
    });
    const update = createDouble([[{ id: "s1" }], [{ id: "s1", ...plain }]]);
    const updated = await createStrategyLibraryRepository(
      update.database,
      deps
    ).update({ id: "s1", priority: "normal", externalValidation: null });
    expect(updated).toMatchObject(plain);
    expect(update.operations[1]!.set).toEqual({
      priority: "normal",
      externalValidation: null,
      updatedAt: FIXED_NOW,
    });
    const set = createDouble([
      [{ id: "s1" }],
      [{ id: "s1", priority: "normal", externalValidation: claim }],
    ]);
    await createStrategyLibraryRepository(set.database, deps).update({
      id: "s1",
      externalValidation: claim,
    });
    expect(set.operations[1]!.set).toEqual({
      externalValidation: claim,
      updatedAt: FIXED_NOW,
    });
    // The row vanished between the lock and the update: no row comes back.
    const vanished = createDouble([[{ id: "s1" }], []]);
    expect(
      await createStrategyLibraryRepository(vanished.database, deps).update({
        id: "s1",
        priority: "high",
      })
    ).toBeNull();
    const repository = createStrategyLibraryRepository(
      createDouble([]).database
    );
    await expect(
      repository.create({
        name: "x",
        kind: "python",
        priority: "urgent" as never,
      })
    ).rejects.toThrow(/Invalid repository input: priority must be one of/);
    await expect(
      repository.create({
        name: "x",
        kind: "python",
        externalValidation: { ...claim, sourceUrl: "http://x.test" },
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.update({ id: "s1", priority: "low" as never })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return await expect(
      repository.update({ id: "s1", externalValidation: { claimed: true } })
    ).rejects.toThrow(/externalValidation\.claimed is not a recognized field/);
  });

  it("fails a read whose stored priority or claim does not parse and passes other errors on", async () => {
    const stored = { id: "s1", presetCount: 0, backtestCount: 0 };
    const badClaim = createDouble([
      [{ ...stored, priority: "high", externalValidation: { sourceUrl: 1 } }],
    ]);
    await expect(
      createStrategyLibraryRepository(badClaim.database).list()
    ).rejects.toThrow(
      "Database operation failed: strategy s1 read (stored externalValidation.sourceUrl must be a string)"
    );
    const badPriority = createDouble([
      [{ ...stored, priority: "urgent", externalValidation: null }],
    ]);
    await expect(
      createStrategyLibraryRepository(badPriority.database).get("s1")
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
    const poisoned = {
      ...stored,
      externalValidation: null,
      get priority(): string {
        throw new TypeError("driver failure");
      },
    };
    await expect(
      createStrategyLibraryRepository(
        createDouble([[poisoned]]).database
      ).list()
    ).rejects.toThrow(TypeError);
    const good = createDouble([
      [{ ...stored, priority: "high", externalValidation: claim }],
      [],
    ]);
    const found = await createStrategyLibraryRepository(good.database).get(
      "s1"
    );
    return expect(found?.strategy).toMatchObject({
      priority: "high",
      externalValidation: claim,
    });
  });

  it("filters by search, status, favorite and unsorted section", async () => {
    const double = createDouble([
      [{ id: "s1", presetCount: "2", backtestCount: 1, ...plain }],
    ]);
    const rows = await createStrategyLibraryRepository(double.database).list({
      search: "50%_off",
      status: "researching",
      favorite: true,
      section: null,
    });
    expect(rows[0]).toMatchObject({ presetCount: 2, backtestCount: 1 });
    // Counts correlate on the outer strategies row, never on the subquery's own id.
    const fields = double.operations[0]!.fields!;
    expect(dialect.sqlToQuery(fields["presetCount"] as SQL).sql).toBe(
      '(select count(*)::int from "strategy_presets" as "sp" where "sp"."strategy_id" = "strategies"."id")'
    );
    expect(dialect.sqlToQuery(fields["backtestCount"] as SQL).sql).toBe(
      '(select count(*)::int from "backtest_results" as "br" where "br"."strategy_id" = "strategies"."id")'
    );
    const query = dialect.sqlToQuery(double.operations[0]!.where!);
    expect(query.sql).toContain('"strategies"."section" is null');
    expect(query.sql).toContain('"strategies"."tags"::text ilike');
    expect(query.params).toContain("%50\\%\\_off%");
    expect(query.params).toContain("researching");
    expect(query.params).toContain(true);
    return await expect(
      createStrategyLibraryRepository(double.database).list({
        search: "x".repeat(101),
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("orders high priority first in SQL, before the limit", async () => {
    const double = createDouble([
      [{ id: "s-high", presetCount: 0, backtestCount: 0, ...plain }],
    ]);
    await createStrategyLibraryRepository(double.database).list({ limit: 1 });
    const order = (double.operations[0]!.orderBy ?? []).map(
      (entry) => dialect.sqlToQuery(entry).sql
    );
    return expect(order).toEqual([
      `case when "strategies"."priority" = 'high' then 0 else 1 end`,
      '"strategies"."updated_at" desc',
      '"strategies"."id" desc',
    ]);
  });

  it("filters by one source tag with a jsonb containment test", async () => {
    const double = createDouble([
      [{ id: "s1", presetCount: 0, backtestCount: 0, ...plain }],
    ]);
    await createStrategyLibraryRepository(double.database).list({
      tag: " quantjourney ",
    });
    const query = dialect.sqlToQuery(double.operations[0]!.where!);
    expect(query.sql).toContain('"strategies"."tags" @> $1::jsonb');
    expect(query.params).toEqual(['["quantjourney"]']);
    return await expect(
      createStrategyLibraryRepository(double.database).list({ tag: " " })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("refuses a params change that would orphan a saved preset", async () => {
    const double = createDouble([
      [{ id: "s1" }],
      [{ name: "fast", values: { lookback: 10 } }],
    ]);
    const repository = createStrategyLibraryRepository(double.database, deps);
    await expect(
      repository.update({ id: "s1", params: [{ ...lookback, min: 20 }] })
    ).rejects.toThrow(/preset fast no longer fits/);
    expect(
      double.operations.some((operation) => operation.kind === "update")
    ).toBe(false);
    return expect(double.operations[0]!.locked).toBe(true);
  });

  it("updates fields and returns null for a missing strategy", async () => {
    const double = createDouble([
      [{ id: "s1" }],
      [{ id: "s1", favorite: true, ...plain }],
    ]);
    const row = await createStrategyLibraryRepository(
      double.database,
      deps
    ).update({ id: "s1", favorite: true, section: "" });
    expect(row).toMatchObject({ favorite: true });
    expect(double.operations[1]!.set).toEqual({
      favorite: true,
      section: null,
      updatedAt: FIXED_NOW,
    });
    const missing = createDouble([[]]);
    expect(
      await createStrategyLibraryRepository(missing.database).update({
        id: "nope",
        favorite: true,
      })
    ).toBeNull();
    return await expect(
      createStrategyLibraryRepository(missing.database).update({ id: "s1" })
    ).rejects.toThrow(/at least one field/);
  });

  it("upserts presets by name after validating against the stored schema", async () => {
    const double = createDouble([
      [{ params }],
      [],
      [{ id: "gen-1", name: "fast" }],
    ]);
    const preset = await createStrategyLibraryRepository(
      double.database,
      deps
    ).savePreset({
      strategyId: "s1",
      name: " fast ",
      values: { lookback: 10, venue: "cboe" },
    });
    expect(preset).toMatchObject({ name: "fast" });
    const insert = double.operations[2]!;
    expect(insert.table).toBe(strategyPresets);
    expect(insert.values).toMatchObject({
      strategyId: "s1",
      name: "fast",
      values: { lookback: 10, venue: "cboe" },
    });
    expect(insert.conflict).toMatchObject({
      set: { values: { lookback: 10, venue: "cboe" }, updatedAt: FIXED_NOW },
    });
    const invalid = createDouble([[{ params }]]);
    await expect(
      createStrategyLibraryRepository(invalid.database).savePreset({
        strategyId: "s1",
        name: "x",
        values: { lookback: 1 },
      })
    ).rejects.toThrow(/at least 5/);
    const missing = createDouble([[]]);
    return expect(
      await createStrategyLibraryRepository(missing.database).savePreset({
        strategyId: "nope",
        name: "x",
        values: { lookback: 10 },
      })
    ).toBeNull();
  });

  it("caps presets per strategy and removes presets scoped to their strategy", async () => {
    const full = createDouble([
      [{ params }],
      Array.from({ length: 50 }, (_, index) => ({ name: `p${index}` })),
    ]);
    await expect(
      createStrategyLibraryRepository(full.database).savePreset({
        strategyId: "s1",
        name: "new",
        values: { lookback: 10 },
      })
    ).rejects.toThrow(/at most 50 presets/);
    const removal = createDouble([[{ id: "p1" }], []]);
    const repository = createStrategyLibraryRepository(removal.database);
    expect(await repository.removePreset({ strategyId: "s1", id: "p1" })).toBe(
      true
    );
    expect(await repository.removePreset({ strategyId: "s1", id: "p2" })).toBe(
      false
    );
    return expect(
      dialect.sqlToQuery(removal.operations[0]!.where!).params
    ).toEqual(["p1", "s1"]);
  });

  return it("reads the latest linked backtest per strategy and skips empty id lists", async () => {
    const double = createDouble([
      [
        {
          strategyId: "s1",
          id: "bt-2",
          createdAt: FIXED_NOW,
          maxDrawdown: -0.1,
          equity: null,
        },
      ],
    ]);
    const repository = createStrategyLibraryRepository(double.database);
    expect(await repository.latestBacktests([])).toEqual([]);
    expect(double.operations).toHaveLength(0);
    expect(await repository.latestBacktests(["s1", "s1"])).toEqual([
      {
        strategyId: "s1",
        id: "bt-2",
        createdAt: FIXED_NOW,
        maxDrawdown: -0.1,
        equity: [],
      },
    ]);
    expect(double.operations[0]!.table).toBe(backtestResults);
    return expect(
      dialect.sqlToQuery(double.operations[0]!.where!).params
    ).toEqual(["s1"]);
  });
});

describe("0019 strategy library migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0019_strategy_library.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0019_strategy_library.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("is idempotent and matches the drizzle columns, checks and indexes", () => {
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE|DROP)\s/im
    );
    for (const table of [strategies, strategyPresets]) {
      const config = getTableConfig(table);
      expect(migration).toContain(
        `CREATE TABLE IF NOT EXISTS "${config.name}"`
      );
      const block = migration.slice(
        migration.indexOf(`CREATE TABLE IF NOT EXISTS "${config.name}"`)
      );
      const columns = [
        ...block.slice(0, block.indexOf(");")).matchAll(/^\s{2}"([a-z_]+)" /gm),
      ].map((match) => match[1]);
      expect(columns.sort()).toEqual(
        config.columns
          .map((column) => column.name)
          .filter((name) => !ADDED_BY_0065.includes(name))
          .sort()
      );
      for (const check of config.checks) {
        if (ADDED_BY_0065.includes(check.name)) continue;
        expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      }
      for (const index of config.indexes) {
        expect(migration).toMatch(
          new RegExp(
            `CREATE (UNIQUE )?INDEX IF NOT EXISTS "${index.config.name}" ON "${config.name}"`
          )
        );
      }
    }
    expect(migration).toContain(
      'REFERENCES "public"."strategies"("id") ON DELETE cascade'
    );
    return expect(migration).toContain(
      'REFERENCES "public"."strategies"("id") ON DELETE set null'
    );
  });

  it("seeds one researching python row per strategy module without overwriting", () => {
    const seeds = [
      ...migration.matchAll(
        /\('strategy-seed-[a-z-]+', '([a-z-]+)', '[^']+', '[^']+', 'python', 'researching', 'services\/research\/strategies\/([a-z_]+)\.py'/g
      ),
    ];
    expect(seeds.map((match) => match[2]).sort()).toEqual([
      "composite",
      "fundamental",
      "hmm",
      "jump",
      "macro",
      "options_payoff",
      "paper_lab",
      "quant",
      "swing",
      "wheel",
      "zero_dte",
    ]);
    for (const match of seeds) {
      expect(match[1]).toBe(match[2]!.replaceAll("_", "-"));
    }
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled as idx 19 after 0018", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0019_strategy_library"
    );
    expect(journal.entries[index]).toMatchObject({
      idx: 19,
      tag: "0019_strategy_library",
    });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 18,
      tag: "0018_backtest_run_config",
    });
  });

  return it("rollback refuses while operator data exists and never cascades", () => {
    expect(rollback).toContain(
      "strategy_presets is not empty; refusing rollback"
    );
    expect(rollback).toContain('WHERE "strategy_id" IS NOT NULL');
    expect(rollback).toContain('OR "updated_at" <> "created_at"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
    for (const match of migration.matchAll(/\('(strategy-seed-[a-z-]+)'/g)) {
      expect(rollback).toContain(`'${match[1]}'`);
    }
  });
});
