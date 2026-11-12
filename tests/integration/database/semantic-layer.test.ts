import { readFileSync } from "node:fs";

import {
  type SemanticAttributeGrainValue,
  strategies,
} from "@darkfactory/db/schema";
import {
  createNodeDatabase,
  createSemanticLayerRepository,
  createSemanticReader,
  type Database,
  SEMANTIC_READER_ROLE,
  type SemanticLayerRepository,
  type SemanticReader,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertReaderRole,
  semanticReaderUrl,
} from "../semantic-layer/harness.ts";

// Agent semantic layer on a real Postgres: the seeded catalog, every certified SQL attribute on the
// synthetic fixture of docs/vertex-rebuild/agent-semantic-layer.md, and read-only enforcement by the
// database (READ ONLY transaction + role "vertex_semantic_reader"), not by a keyword filter.

const FIXTURE = readFileSync(
  new URL(
    "../../../docs/vertex-rebuild/agent-semantic-layer/fixture.sql",
    import.meta.url
  ),
  "utf8"
);
const RUN = { rowLimit: 50, timeoutMs: 5000 } as const;

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;
let repository: SemanticLayerRepository;
let reader: SemanticReader;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

/** Runs one SQL attribute of a term: the given grain, else the first (`strategy` before `run_spec`). */
const run = async (
  termId: string,
  params: (string | number | null)[],
  grain?: SemanticAttributeGrainValue
) => {
  const attributes = (await repository.term(termId))?.attributes ?? [];
  const attribute =
    grain === undefined
      ? attributes[0]
      : attributes.find((row) => row.grain === grain);
  if (attribute === undefined) {
    throw new Error(`no ${grain ?? ""} SQL attribute for ${termId}`);
  }
  return reader.run(attribute, params, RUN);
};

let strategiesBefore = 0;
const strategyCount = async () =>
  (await database().select({ id: strategies.id }).from(strategies)).length;

const okRows = async (
  termId: string,
  params: (string | number | null)[],
  grain?: SemanticAttributeGrainValue
) => {
  const result = await run(termId, params, grain);
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  return result.rows;
};

describe("semantic layer (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
    await assertReaderRole(resource.db);
    await resource.db.execute(FIXTURE);
    repository = createSemanticLayerRepository(
      resource.db,
      () => new Date("2026-11-08T12:00:00.000Z")
    );
    reader = createSemanticReader(semanticReaderUrl(testDatabase.databaseUrl));
    strategiesBefore = await strategyCount();
  });

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("seeds ten certified terms, one SQL attribute per Postgres term plus two run-spec ones, and six joins on real columns", async () => {
    const catalog = await repository.catalog();
    expect(catalog.terms.map((term) => [term.id, term.source])).toEqual([
      ["backtest_max_drawdown", "postgres"],
      ["backtest_sharpe", "postgres"],
      ["crown_copy_leg", "none"],
      ["deployment_request", "postgres"],
      ["drift_level", "postgres"],
      ["net_liquidation", "feed"],
      ["open_risk", "feed"],
      ["pnl", "feed"],
      ["position", "feed"],
      ["strategy_gate_pass", "postgres"],
    ]);
    expect(catalog.terms.every((term) => term.certified)).toBe(true);
    expect(
      catalog.attributes.map((attribute) => [
        attribute.id,
        attribute.termId,
        attribute.grain,
        attribute.certifiedBy,
      ])
    ).toEqual([
      [
        "backtest_max_drawdown",
        "backtest_max_drawdown",
        "strategy",
        "migration 0056",
      ],
      [
        "backtest_max_drawdown_run_spec",
        "backtest_max_drawdown",
        "run_spec",
        "eval fixture (stands in for the owner)",
      ],
      ["backtest_sharpe", "backtest_sharpe", "strategy", "migration 0056"],
      [
        "backtest_sharpe_run_spec",
        "backtest_sharpe",
        "run_spec",
        "eval fixture (stands in for the owner)",
      ],
      ["deployment_request", "deployment_request", "request", "migration 0056"],
      ["drift_level", "drift_level", "monitor", "migration 0056"],
      [
        "strategy_gate_pass",
        "strategy_gate_pass",
        "candidate",
        "migration 0056",
      ],
    ]);
    // 0058 leaves the 0056 rows as they were: only grain is filled in.
    expect(
      catalog.attributes
        .filter((attribute) => attribute.grain !== "run_spec")
        .every(
          (attribute) => attribute.certified && attribute.updatedBy === null
        )
    ).toBe(true);
    expect(
      (await repository.term("backtest_sharpe"))?.attributes.map(
        (attribute) => attribute.grain
      )
    ).toEqual(["strategy", "run_spec"]);
    expect(catalog.relationships).toHaveLength(6);
    const columns = await database().execute<{ name: string }>(
      "select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'"
    );
    const known = new Set(columns.rows.map((row) => row.name));
    for (const join of catalog.relationships) {
      expect(known.has(`${join.fromTable}.${join.fromColumn}`)).toBe(true);
      expect(known.has(`${join.toTable}.${join.toColumn}`)).toBe(true);
    }
  });

  it("backtest_sharpe uses the latest succeeded engine run and never notebook records", async () => {
    const rows = await okRows("backtest_sharpe", [null]);
    expect(rows.map((row) => [row["strategy"], row["sharpe"]])).toEqual([
      ["RSI Mean Reversion", 1.45],
      ["Sector Momentum", 1.31],
      ["Opening Range Breakout", 0.82],
    ]);
    expect(rows[2]).toMatchObject({
      newer_runs_not_succeeded: 1,
      run_id: "br_orb_2",
    });
    expect(await okRows("backtest_sharpe", ["opening"])).toHaveLength(1);
  });

  it("backtest_max_drawdown reports the engine fraction in percent and filters by a threshold", async () => {
    const rows = await okRows("backtest_max_drawdown", [
      "opening-range-breakout",
      null,
    ]);
    expect(rows).toMatchObject([{ max_drawdown_percent: 18.9 }]);
    const worse = await okRows("backtest_max_drawdown", [null, 20]);
    expect(
      worse.map((row) => [row["strategy"], row["max_drawdown_percent"]])
    ).toEqual([["Sector Momentum", 22.5]]);
  });

  it("backtest_sharpe per run spec: latest succeeded run per full run spec, only runs with no strategy", async () => {
    const rows = await okRows("backtest_sharpe", [null], "run_spec");
    expect(
      rows.map((row) => [
        row["symbol"],
        row["timeframe"],
        row["rule"],
        row["stop_loss_pct"],
        row["sharpe"],
        row["run_id"],
        row["succeeded_runs_in_spec"],
        row["newer_runs_not_succeeded"],
      ])
    ).toEqual([
      [
        "DIA",
        "1m",
        "breakout entry 20 exit 10 trend SMA 200",
        0,
        1.21,
        "br_free_dia_1",
        1,
        1,
      ],
      ["IWM", "1d", "smaCross fast 10 slow 30", 0, 0.71, "br_free_iwm_2", 2, 0],
      // Same rule as the GLD row below with a 2% stop: a different backtest (sweep cell), its own row.
      ["GLD", "1d", "smaCross fast 5 slow 20", 2, 0.33, "br_free_gld_2", 1, 0],
      ["GLD", "1d", "smaCross fast 5 slow 20", 0, -0.12, "br_free_gld_1", 1, 0],
    ]);
    expect(rows[0]).toMatchObject({
      cost_bps: 1,
      date_from: "2021-01-01",
      date_to: "2026-09-30",
      take_profit_pct: 0,
      engine_version: "vx-engine-1.5",
      strategy_on_run: null,
    });
    expect(
      (await okRows("backtest_sharpe", ["iwm"], "run_spec")).map(
        (row) => row["run_id"]
      )
    ).toEqual(["br_free_iwm_2"]);
    // A strategy name matches no run without a strategy.
    expect(await okRows("backtest_sharpe", ["opening"], "run_spec")).toEqual(
      []
    );
  });

  it("backtest_max_drawdown per run spec reports percent and filters by a threshold", async () => {
    const worse = await okRows("backtest_max_drawdown", [null, 20], "run_spec");
    expect(
      worse.map((row) => [row["symbol"], row["max_drawdown_percent"]])
    ).toEqual([
      ["GLD", 41.2],
      ["IWM", 25.8],
    ]);
    expect(
      await okRows("backtest_max_drawdown", ["DIA", null], "run_spec")
    ).toMatchObject([{ max_drawdown_percent: 8.3, run_id: "br_free_dia_1" }]);
  });

  it("strategy_gate_pass maps verified, rejected and evaluated to passed, failed and not_gated", async () => {
    const passed = await okRows("strategy_gate_pass", [null, "passed"]);
    expect(passed.map((row) => row["candidate"])).toEqual([
      "SPY sma-cross 20/50",
      "SPY rsi14 below 30",
    ]);
    const failedSpy = await okRows("strategy_gate_pass", ["SPY", "failed"]);
    expect(failedSpy.map((row) => row["candidate"]).sort()).toEqual([
      "SPY bollinger 20/2",
      "SPY breakout 55",
    ]);
    expect(await okRows("strategy_gate_pass", ["c_qqq", null])).toHaveLength(2);
  });

  it("deployment_request and drift_level answer the owner's waiting and drift questions", async () => {
    expect(
      await okRows("deployment_request", ["requested", null])
    ).toMatchObject([
      { meaning: "waiting for the owner", strategy: "Opening Range Breakout" },
    ]);
    const approved = await okRows("deployment_request", ["approved", null]);
    expect(approved[0]).toMatchObject({ strategy: "Sector Momentum" });
    expect(typeof approved[0]?.["decided_at"]).toBe("string");
    expect(
      (await okRows("drift_level", [null])).map((row) => [
        row["strategy"],
        row["level"],
      ])
    ).toEqual([
      ["Opening Range Breakout", "alert"],
      ["Sector Momentum", "warn"],
    ]);
    expect(await okRows("drift_level", ["all"])).toHaveLength(3);
  });

  it("refuses writes at the database: a function that deletes fails in the read-only transaction", async () => {
    await database().execute(
      "create function semantic_test_delete() returns bigint language sql as 'with gone as (delete from strategies returning 1) select count(*) from gone'"
    );
    const result = await reader.run(
      { sql: "select semantic_test_delete() as deleted" },
      [],
      RUN
    );
    expect(result).toMatchObject({
      failure: "write_refused",
      status: "failed",
    });
    expect(await strategyCount()).toBe(strategiesBefore);
  });

  it("refuses tables outside the reader grant, second statements and long runs", async () => {
    expect(
      await reader.run({ sql: 'select email from "user"' }, [], RUN)
    ).toMatchObject({ failure: "permission_denied", status: "failed" });
    expect(
      await reader.run(
        { sql: "select 1 as one; delete from strategies" },
        [],
        RUN
      )
    ).toMatchObject({ failure: "invalid_sql", status: "failed" });
    expect(
      await reader.run({ sql: "select pg_sleep(2) as slept" }, [], {
        rowLimit: 5,
        timeoutMs: 100,
      })
    ).toMatchObject({ failure: "timeout", status: "failed" });
    expect(await strategyCount()).toBe(strategiesBefore);
  });

  it("cannot switch back to the app role or read outside the grant from inside one SELECT", async () => {
    for (const role of ["darkfactory_test_runner", "darkfactory_app"]) {
      expect(
        await reader.run(
          { sql: `select set_config('role', '${role}', true) as switched` },
          [],
          RUN
        )
      ).toMatchObject({ failure: "permission_denied", status: "failed" });
    }
    expect(
      await reader.run(
        {
          sql: "select query_to_xml('select email from \"user\"', true, true, '')::text as leaked",
        },
        [],
        RUN
      )
    ).toMatchObject({ failure: "permission_denied", status: "failed" });
    expect(
      await reader.run({ sql: "select id from strategies for update" }, [], RUN)
    ).toMatchObject({ status: "failed" });
  });

  it("keeps the texts of one batch apart on their shared connection", async () => {
    // A session-level setting made by one text is rolled back with its transaction: the next text
    // sees the defaults, the reader role, a read-only transaction and its own statement timeout.
    const settings = await reader.runAll(
      [
        {
          sql: "select set_config('search_path', 'pg_catalog', false) as path",
        },
        { sql: "select current_setting('search_path') as path" },
        {
          sql: "select set_config('statement_timeout', '0', false) as timeout",
        },
        {
          sql: "select current_setting('statement_timeout') as timeout, current_setting('transaction_read_only') as read_only, current_user::text as role",
        },
      ],
      [],
      RUN
    );
    expect(settings.map(({ status }) => status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(settings[0]).toMatchObject({ rows: [{ path: "pg_catalog" }] });
    expect(settings[1]).toMatchObject({ rows: [{ path: '"$user", public' }] });
    expect(settings[3]).toMatchObject({
      rows: [{ read_only: "on", role: SEMANTIC_READER_ROLE, timeout: "5s" }],
    });

    // A session advisory lock survives a rollback; DISCARD ALL after each text releases it. A custom
    // setting's value is reset too. The texts share one backend, so this is the shared connection.
    const session = await reader.runAll(
      [
        {
          sql: "select pg_backend_pid() as pid, pg_advisory_lock(424242)::text as locked, set_config('probe.x', 'leaked', false) as probe",
        },
        {
          sql: "select pg_backend_pid() as pid, (select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as held, coalesce(current_setting('probe.x', true), '') as probe",
        },
      ],
      [],
      RUN
    );
    expect(session.map(({ status }) => status)).toEqual(["ok", "ok"]);
    expect(session[0]).toMatchObject({ rows: [{ probe: "leaked" }] });
    expect(session[1]).toMatchObject({ rows: [{ held: 0, probe: "" }] });
    expect(session[1]?.rows[0]?.["pid"]).toBe(session[0]?.rows[0]?.["pid"]);

    // A failed text ends the batch: nothing runs on the connection after it.
    const refused = await reader.runAll(
      [
        { sql: "select count(*)::int as n from strategies" },
        { sql: 'select email from "user"' },
        { sql: "select count(*)::int as n from strategies" },
      ],
      [],
      RUN
    );
    expect(refused.map(({ status }) => status)).toEqual(["ok", "failed"]);
    expect(refused[0]).toMatchObject({ rows: [{ n: strategiesBefore }] });
    expect(refused[1]).toMatchObject({ failure: "permission_denied" });
  });

  it("answers reader_unavailable for a missing or app-role connection, never falling back", async () => {
    expect(
      await createSemanticReader(null).run({ sql: "select 1 as one" }, [], RUN)
    ).toMatchObject({
      failure: "reader_unavailable",
      status: "failed",
    });
    const appUrl = (testDatabase as PostgresTestDatabase).databaseUrl;
    expect(
      await createSemanticReader(appUrl).run(
        { sql: "select 1 as one" },
        [],
        RUN
      )
    ).toMatchObject({
      failure: "reader_unavailable",
    });
    const wrongPassword = new URL(semanticReaderUrl(appUrl));
    wrongPassword.password = "wrong";
    expect(
      await createSemanticReader(wrongPassword.toString()).run(
        { sql: "select 1 as one" },
        [],
        RUN
      )
    ).toMatchObject({ failure: "reader_unavailable" });
  });

  it("caps rows and reports truncation", async () => {
    const result = await reader.run(
      { sql: "select id from strategies order by id" },
      [],
      { rowLimit: 2, timeoutMs: 5000 }
    );
    expect(result).toMatchObject({ status: "ok", truncated: true });
    expect(result.status === "ok" && result.rows).toEqual([
      { id: "s_gap" },
      { id: "s_mom" },
    ]);
  });

  it("certifies or uncertifies a seed row by the version the operator read (microsecond timestamps)", async () => {
    const seed = (await repository.catalog()).terms.find(
      (term) => term.id === "crown_copy_leg"
    );
    if (seed === undefined) throw new Error("seed missing");
    expect(
      await repository.certify({
        actor: "u_owner",
        certified: false,
        expectedUpdatedAt: new Date(seed.updatedAt.getTime()),
        id: "crown_copy_leg",
        kind: "term",
        note: "Checked: still no data source.",
      })
    ).toBe("certified");
    expect((await repository.term("crown_copy_leg"))?.term).toMatchObject({
      certified: false,
      certificationNote: "Checked: still no data source.",
    });
  });

  it("an edit removes the certification until an operator certifies again", async () => {
    const edited = await repository.updateAttribute(
      "drift_level",
      { description: "Paper forward drift monitors by level (edited)." },
      "u_owner"
    );
    expect(edited).toMatchObject({ certified: false, updatedBy: "u_owner" });
    expect(
      await repository.certify({
        actor: "u_owner",
        certified: true,
        expectedUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
        id: "drift_level",
        kind: "attribute",
        note: "Reviewed an older version.",
      })
    ).toBe("changed");
    expect(
      await repository.certify({
        actor: "u_owner",
        certified: true,
        expectedUpdatedAt: (edited as { updatedAt: Date }).updatedAt,
        id: "drift_level",
        kind: "attribute",
        note: "Reviewed.",
      })
    ).toBe("certified");
    expect((await repository.term("drift_level"))?.attributes[0]).toMatchObject(
      {
        certificationNote: "Reviewed.",
        certified: true,
        certifiedBy: "u_owner",
      }
    );
    expect(
      await repository.updateTerm("missing_term", { label: "x" }, "u_owner")
    ).toBeNull();
    expect(
      await repository.certify({
        actor: "u_owner",
        certified: true,
        expectedUpdatedAt: new Date(),
        id: "missing_term",
        kind: "term",
        note: null,
      })
    ).toBe("not_found");
  });
});
