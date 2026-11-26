import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  FLOW_CAPTURE_VALUES,
  FLOW_EXTRA_OPTION_TICKER_VALUES,
  FLOW_INDEX_OPTION_TICKER_VALUES,
  FLOW_OPTION_PRINT_SYMBOL_VALUES,
  FLOW_OPTION_TICKER_VALUES,
  FLOW_SOURCE_VALUES,
  FLOW_SYMBOL_VALUES,
  flowBook,
  flowEvents,
  flowGex,
  flowLargeTrades,
  flowMarketPremium,
  flowMarketPremiumSessions,
  flowMinutes,
  flowNetDrift,
  flowOptionGaps,
  flowOptionPrints,
  flowSamples,
} from "../schema/index.ts";

const TABLES = [
  flowSamples,
  flowMinutes,
  flowBook,
  flowOptionPrints,
  flowEvents,
  flowGex,
];

describe("0052_flow_pipeline migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0052_flow_pipeline.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0052_flow_pipeline.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("only creates tables and grants the app role what the flow repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_samples", "flow_minutes", "flow_book", "flow_option_prints", "flow_events", "flow_gex" TO "vertex_research"'
    );
  });

  it.each(TABLES.map((table) => getTableConfig(table)))(
    "matches the drizzle columns, checks and indexes of $name",
    (config) => {
      const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("\n);", start));
      const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
        (match) => match[1]
      );
      expect([...sqlColumns].sort()).toEqual(
        config.columns.map((column) => column.name).sort()
      );
      for (const check of config.checks)
        expect(body).toContain(`CONSTRAINT "${check.name}" CHECK`);
      for (const index of config.indexes)
        expect(migration).toContain(
          `INDEX "${index.config.name}" ON "${config.name}"`
        );
    }
  );

  it("is the 53rd journal entry and the rollback drops only the flow tables", () => {
    expect(journal.entries[52]).toMatchObject({
      idx: 52,
      tag: "0052_flow_pipeline",
    });
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    const drops = [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)];
    expect(drops.map((match) => match[1]).sort()).toEqual(
      TABLES.map((table) => getTableConfig(table).name).sort()
    );
  });
});

describe("0053_flow_option_gaps migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0053_flow_option_gaps.sql");
  const rollback = read("../../rollback/0053_flow_option_gaps.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowOptionGaps);

  it("only creates flow_option_gaps and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_option_gaps"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_option_gaps" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('PRIMARY KEY("symbol","start_time")');
    for (const check of config.checks)
      expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
  });

  it("is the 54th journal entry and the rollback drops only flow_option_gaps", () => {
    expect(journal.entries[53]).toMatchObject({
      idx: 53,
      tag: "0053_flow_option_gaps",
    });
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_option_gaps"]);
  });
});

describe("0077_flow_net_drift migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0077_flow_net_drift.sql");
  const rollback = read("../../rollback/0077_flow_net_drift.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowNetDrift);
  const CHECKS = [
    "flow_book_check",
    "flow_events_check",
    "flow_gex_check",
    "flow_minutes_check",
    "flow_option_gaps_check",
    "flow_option_prints_check",
    "flow_samples_check",
  ];
  const addText = (name: string): string => {
    const line = migration
      .split("\n")
      .find((entry) => entry.includes(`ADD CONSTRAINT "${name}" CHECK`));
    if (line === undefined) throw new Error(`no ADD for ${name}`);
    return line;
  };

  it("creates flow_net_drift, replaces the seven checks and changes no row", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT)\s|DROP TABLE/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_net_drift"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_net_drift" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check of flow_net_drift", () => {
    const create = migration.slice(0, migration.indexOf(");"));
    const sqlColumns = [...create.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('PRIMARY KEY("ticker","part","minute")');
    expect(config.checks.map((check) => check.name)).toEqual([
      "flow_net_drift_check",
    ]);
    expect(migration).toContain('CONSTRAINT "flow_net_drift_check" CHECK');
  });

  it("drops and adds each of the seven checks with the four symbols", () => {
    for (const name of CHECKS) {
      expect(migration.split(`DROP CONSTRAINT "${name}"`).length - 1).toBe(1);
      expect(migration.split(`ADD CONSTRAINT "${name}"`).length - 1).toBe(1);
      expect(addText(name)).toContain("'QQQ', 'NQ'");
    }
    expect(addText("flow_gex_check")).toContain("'NDX'");
    expect(addText("flow_option_prints_check")).toContain("'NDX'");
    expect(addText("flow_samples_check")).toContain("'net_drift'");
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0077_flow_net_drift"
    );
  });

  it("every schema symbol, ticker and source value is in the check text of the migration", () => {
    for (const symbol of FLOW_SYMBOL_VALUES)
      expect(addText("flow_samples_check")).toContain(`'${symbol}'`);
    for (const ticker of FLOW_INDEX_OPTION_TICKER_VALUES) {
      expect(addText("flow_gex_check")).toContain(`'${ticker}'`);
      expect(addText("flow_option_prints_check")).toContain(`'${ticker}'`);
    }
    // market_premium came later, with 0088_flow_market_premium.
    for (const source of FLOW_SOURCE_VALUES.filter(
      (value) => value !== "market_premium"
    ))
      expect(addText("flow_samples_check")).toContain(`'${source}'`);
  });

  it("the rollback restores the old checks, drops only flow_net_drift and deletes no row", () => {
    expect(rollback).not.toMatch(
      /CASCADE|TRUNCATE|IF EXISTS "|^\s*DELETE\s/imu
    );
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_net_drift"]);
    for (const name of CHECKS) {
      const add = rollback
        .split("\n")
        .find((line) => line.includes(`ADD CONSTRAINT "${name}" CHECK`));
      expect(add).toContain("in ('SPY', 'ES')");
      expect(add).not.toContain("QQQ");
      expect(rollback).toContain(`DROP CONSTRAINT "${name}";`);
    }
  });
});

describe("0078_flow_large_trades migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0078_flow_large_trades.sql");
  const rollback = read("../../rollback/0078_flow_large_trades.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowLargeTrades);

  it("only creates flow_large_trades and grants the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_large_trades"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_large_trades" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check of flow_large_trades", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('PRIMARY KEY("symbol","second","seq")');
    expect(config.checks.map((check) => check.name)).toEqual([
      "flow_large_trades_check",
    ]);
    for (const check of config.checks)
      expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0078_flow_large_trades"
    );
  });

  it("the rollback drops only flow_large_trades, without cascade", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_large_trades"]);
  });
});

describe("0083_flow_capture_streamed migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0083_flow_capture_streamed.sql");
  const rollback = read("../../rollback/0083_flow_capture_streamed.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowLargeTrades);
  const DROP =
    'ALTER TABLE "flow_large_trades" DROP CONSTRAINT "flow_large_trades_check";';
  const ADD =
    'ALTER TABLE "flow_large_trades" ADD CONSTRAINT "flow_large_trades_check" CHECK (';
  const checkOf = (sqlText: string) =>
    /ADD CONSTRAINT "flow_large_trades_check" CHECK \((.+)\);/u.exec(
      sqlText
    )?.[1];

  it("only replaces the check constraint of flow_large_trades", () => {
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim());
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(DROP);
    expect(statements[1]?.startsWith(ADD)).toBe(true);
    expect(migration).not.toMatch(
      /\b(TRUNCATE|UPDATE|DELETE|INSERT|CREATE|DROP TABLE|DROP COLUMN|ADD COLUMN)\b/iu
    );
  });

  it("permits the capture values of the schema and agrees with the drizzle check", () => {
    expect([...FLOW_CAPTURE_VALUES]).toEqual(["sampled", "streamed"]);
    const [check] = config.checks;
    expect(config.checks).toHaveLength(1);
    expect(check?.name).toBe("flow_large_trades_check");
    const drizzle = new PgDialect().sqlToQuery(
      check?.value ?? sql`missing`
    ).sql;
    expect(checkOf(migration)).toBe(drizzle);
    expect(drizzle).toContain(
      `"flow_large_trades"."capture" in (${FLOW_CAPTURE_VALUES.map((value) => `'${value}'`).join(", ")})`
    );
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.find((entry) => entry.idx === 83)?.tag).toBe(
      "0083_flow_capture_streamed"
    );
  });

  it("the rollback deletes only streamed rows and restores the check of 0078", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS|DROP TABLE/u);
    expect(
      rollback.split("\n").filter((line) => line.startsWith("DELETE"))
    ).toEqual([
      `DELETE FROM "public"."flow_large_trades" WHERE "capture" = 'streamed';`,
    ]);
    expect(rollback).toContain(
      'ALTER TABLE "public"."flow_large_trades" DROP CONSTRAINT "flow_large_trades_check";'
    );
    const created = read("../../migrations/0078_flow_large_trades.sql");
    const old = /CONSTRAINT "flow_large_trades_check" CHECK \((.+)\)$/mu.exec(
      created
    )?.[1];
    expect(old).toContain(`"capture" in ('sampled')`);
    expect(checkOf(rollback)).toBe(old);
    expect(rollback.indexOf("DELETE FROM")).toBeLessThan(
      rollback.indexOf("DROP CONSTRAINT")
    );
    expect(rollback).toContain("This file is not the rollback path");
    expect(rollback).toContain("cannot be fetched again");
    expect(rollback).toContain("explicit owner decision");
  });
});

describe("0088_flow_market_premium migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0088_flow_market_premium.sql");
  const rollback = read("../../rollback/0088_flow_market_premium.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const samplesCheck = (text: string) =>
    /ADD CONSTRAINT "flow_samples_check" CHECK \((.+)\);/u.exec(text)?.[1];
  const columnsOf = (table: string) => {
    const body =
      new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]+?)\\n\\);`, "u").exec(
        migration
      )?.[1] ?? "";
    return [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map((match) => match[1]);
  };

  it("creates the two tables, replaces only the flow_samples check and changes no row", () => {
    expect(migration).not.toMatch(/^\s*(TRUNCATE|UPDATE|DELETE|INSERT)\s/im);
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_market_premium", "flow_market_premium_sessions"]);
    expect(
      [...migration.matchAll(/ALTER TABLE "(\w+)" (DROP|ADD) CONSTRAINT/g)].map(
        (m) => `${m[1]} ${m[2]}`
      )
    ).toEqual(["flow_samples DROP", "flow_samples ADD"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_market_premium" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "flow_market_premium_sessions" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, keys and checks of both tables", () => {
    for (const table of [flowMarketPremium, flowMarketPremiumSessions]) {
      const config = getTableConfig(table);
      expect([...columnsOf(config.name)].sort()).toEqual(
        config.columns.map((column) => column.name).sort()
      );
      for (const check of config.checks)
        expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
    }
    expect(migration).toContain('PRIMARY KEY("session_date","ticker")');
    expect(migration).toContain('"session_date" date PRIMARY KEY NOT NULL');
  });

  it("permits every schema source in the new flow_samples check", () => {
    const check = samplesCheck(migration) ?? "";
    for (const source of FLOW_SOURCE_VALUES)
      expect(check).toContain(`'${source}'`);
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0088_flow_market_premium"
    );
  });

  it("the rollback restores the old sample check, drops only the two tables and deletes no row", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS|DELETE /u);
    const restored = samplesCheck(rollback) ?? "";
    expect(restored).toContain("'net_drift'");
    expect(restored).not.toContain("market_premium");
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_market_premium", "flow_market_premium_sessions"]);
  });
});

describe("0095_flow_option_tickers migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0095_flow_option_tickers.sql");
  const rollback = read("../../rollback/0095_flow_option_tickers.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: Array<{ tag: string }>;
  };

  const CHECKS = [
    "flow_events_check",
    "flow_option_gaps_check",
    "flow_option_prints_check",
    "flow_samples_check",
  ] as const;

  const addText = (sql: string, name: string): string =>
    sql
      .split("\n")
      .find((line) => line.includes(`ADD CONSTRAINT "${name}" CHECK`)) ?? "";

  it("widens the four option-print table checks to include every option-print symbol and ticker", () => {
    for (const name of CHECKS) {
      expect(migration.split(`DROP CONSTRAINT "${name}"`).length - 1).toBe(1);
      expect(migration.split(`ADD CONSTRAINT "${name}"`).length - 1).toBe(1);
    }
    for (const symbol of FLOW_OPTION_PRINT_SYMBOL_VALUES) {
      expect(addText(migration, "flow_option_prints_check")).toContain(
        `'${symbol}'`
      );
      expect(addText(migration, "flow_option_gaps_check")).toContain(
        `'${symbol}'`
      );
      expect(addText(migration, "flow_samples_check")).toContain(`'${symbol}'`);
      expect(addText(migration, "flow_events_check")).toContain(`'${symbol}'`);
    }
    for (const ticker of FLOW_OPTION_TICKER_VALUES)
      expect(addText(migration, "flow_option_prints_check")).toContain(
        `'${ticker}'`
      );
    // Added option-only tickers are restricted to options samples and quantdata events.
    expect(addText(migration, "flow_samples_check")).toContain(
      'and "flow_samples"."source" = \'options\''
    );
    expect(addText(migration, "flow_events_check")).toContain(
      'and "flow_events"."source" = \'quantdata\''
    );
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0095_flow_option_tickers"
    );
  });

  it("the rollback refuses while rows for added tickers exist, deletes no rows and restores the four pre-0095 checks", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS|DELETE /u);
    expect(rollback).toContain("RAISE EXCEPTION");
    for (const ticker of FLOW_EXTRA_OPTION_TICKER_VALUES)
      expect(rollback).toContain(`'${ticker}'`);
    for (const name of CHECKS) {
      expect(rollback).toContain(`DROP CONSTRAINT "${name}";`);
      const restored = addText(rollback, name);
      expect(restored).toContain("in ('SPY', 'ES', 'QQQ', 'NQ')");
      for (const ticker of FLOW_EXTRA_OPTION_TICKER_VALUES)
        expect(restored).not.toContain(`'${ticker}'`);
    }
    expect(addText(rollback, "flow_samples_check")).toContain(
      "'market_premium'"
    );
  });
});

describe("0098_flow_option_prints_oi_flags migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read(
    "../../migrations/0098_flow_option_prints_oi_flags.sql"
  );
  const rollback = read(
    "../../rollback/0098_flow_option_prints_oi_flags.down.sql"
  );
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: Array<{ tag: string }>;
  };

  it("drops NOT NULL on opening and volume_over_oi, enforces paired OI-0 nullability, and updates no rows", () => {
    expect(migration).toContain('DROP CONSTRAINT "flow_option_prints_check";');
    expect(migration).toContain(
      'ALTER TABLE "flow_option_prints" ALTER COLUMN "opening" DROP NOT NULL;'
    );
    expect(migration).toContain(
      'ALTER TABLE "flow_option_prints" ALTER COLUMN "volume_over_oi" DROP NOT NULL;'
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "flow_option_prints_check" CHECK'
    );
    expect(migration).toContain(
      '("flow_option_prints"."opening" is null) = ("flow_option_prints"."volume_over_oi" is null)'
    );
    expect(migration).toContain(
      '("flow_option_prints"."opening" is not null or ("flow_option_prints"."open_interest" is not null and "flow_option_prints"."open_interest" = 0))'
    );
    expect(migration).not.toMatch(/UPDATE |DELETE |TRUNCATE /u);
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0098_flow_option_prints_oi_flags"
    );
  });

  it("the rollback refuses while NULL flags exist, mutates no rows, and restores pre-0098 check and NOT NULL", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS|DELETE |UPDATE /u);
    expect(rollback).toContain("RAISE EXCEPTION");
    expect(rollback).toContain('"opening" IS NULL OR "volume_over_oi" IS NULL');
    expect(rollback).toContain('DROP CONSTRAINT "flow_option_prints_check";');
    expect(rollback).toContain(
      'ALTER TABLE "public"."flow_option_prints" ALTER COLUMN "opening" SET NOT NULL;'
    );
    expect(rollback).toContain(
      'ALTER TABLE "public"."flow_option_prints" ALTER COLUMN "volume_over_oi" SET NOT NULL;'
    );
    expect(rollback).toContain(
      "ADD CONSTRAINT \"flow_option_prints_check\" CHECK (\"flow_option_prints\".\"symbol\" in ('SPY', 'ES', 'QQQ', 'NQ', 'IWM', 'NVDA')"
    );
    expect(rollback).not.toContain('"opening" is null');
  });
});
