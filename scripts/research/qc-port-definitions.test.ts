import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { normalizeStrategyParams } from "../../packages/db/src/server/strategy-library.ts";
import {
  type CliIo,
  MIGRATION_URL,
  QC_PORT_IDEAS,
  qcPortRevisions,
  ROLLBACK_URL,
  renderMigration,
  renderRollback,
  runQcPortDefinitions,
  type Spawn,
} from "./qc-port-definitions.ts";

const migration = readFileSync(MIGRATION_URL, "utf8");
const rollback = readFileSync(ROLLBACK_URL, "utf8");

const ROW =
  /\('qc-def-(qc-[a-z0-9-]+)-r1', '(qc-[a-z0-9-]+)', 1, '((?:[^']|'')+)', '((?:[^']|'')+)'::jsonb, '([0-9a-f]{64})', '((?:[^']|'')+)', 'migration:0061'\)/gu;
const NOTE =
  /^Research run A of (qc-[a-z0-9-]+): from (\d{4}-\d{2}-\d{2}), capital 100000, data to (\d{4}-\d{2}-\d{2}) \(research_studies (qc-[a-z0-9-]+)\)$/u;

type StoredRow = Readonly<{
  idea: string;
  definition: Record<string, unknown>;
  sha256: string;
  start: string;
  dataTo: string;
}>;

const stored: StoredRow[] = [...migration.matchAll(ROW)].map((match) => {
  const note = NOTE.exec((match[6] as string).replaceAll("''", "'"));
  return {
    dataTo: note?.[3] as string,
    definition: JSON.parse((match[4] as string).replaceAll("''", "'")),
    idea: match[1] as string,
    sha256: match[5] as string,
    start: note?.[2] as string,
  };
});

/** The generator input recovered from the committed migration. */
type MutableInput = Record<
  string,
  { run: string; start: string; definition: unknown }
>;

const committedInput = (): MutableInput =>
  Object.fromEntries(
    stored.map((row) => [
      row.idea,
      {
        definition: row.definition,
        run: `${row.idea.slice(3)}/A`,
        start: row.start,
      },
    ])
  );

/** The committed input with one idea's entry edited in place. */
const editIdea = (
  idea: string,
  edit: (entry: MutableInput[string]) => void
): MutableInput => {
  const input = committedInput();
  const entry = input[idea];
  if (entry === undefined) throw new Error(`no ${idea}`);
  edit(entry);
  return input;
};
const DATA_TO = stored[0]?.dataTo as string;

const createIo = (
  overrides: Partial<CliIo> = {},
  files: Record<string, string> = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const io: CliIo = {
    env: {},
    readText: async (url) => {
      const text = files[String(url)];
      if (text === undefined) throw new Error(`no file ${String(url)}`);
      return text;
    },
    spawn: vi.fn<Spawn>(),
    stderr: { write: (text: string) => err.push(text) > 0 },
    stdout: { write: (text: string) => out.push(text) > 0 },
    writeText: async (url, text) => {
      written.set(url.pathname, text);
    },
    ...overrides,
  };
  return { err, io, out, written };
};

const pythonSpawn = (date = `${DATA_TO}\n`): Spawn =>
  vi.fn<Spawn>((_command, args) =>
    args[0] === "-m"
      ? { status: 0, stderr: "", stdout: JSON.stringify(committedInput()) }
      : { status: 0, stderr: "", stdout: date }
  );

describe("committed migration 0061", () => {
  it("stores the 11 ideas sorted by id with one data-to date", () => {
    expect(stored.map((row) => row.idea)).toEqual([...QC_PORT_IDEAS]);
    expect(new Set(stored.map((row) => row.dataTo)).size).toBe(1);
  });

  it("is exactly the generator output, rollback included", async () => {
    const revisions = await qcPortRevisions(committedInput(), DATA_TO);
    expect(revisions.map((revision) => revision.sha256)).toEqual(
      stored.map((row) => row.sha256)
    );
    expect(renderMigration(revisions)).toBe(migration);
    expect(renderRollback(revisions)).toBe(rollback);
  });

  it("links each library row by fixed choice params the library accepts", async () => {
    const revisions = await qcPortRevisions(committedInput(), DATA_TO);
    for (const revision of revisions) {
      const params = JSON.parse(revision.paramsJson);
      expect(normalizeStrategyParams(params)).toHaveLength(4);
      expect(params.map((param: { name: string }) => param.name)).toEqual([
        "definitionId",
        "definitionSha256",
        "runFrom",
        "initialCapital",
      ]);
      expect(params[1]).toEqual({
        default: revision.sha256,
        name: "definitionSha256",
        options: [revision.sha256],
        title: "Definition SHA-256",
        type: "choice",
      });
      expect(params[3].default).toBe("100000");
      expect(migration).toContain(
        `WHERE "id" = 'strategy-seed-${revision.idea}' AND "params" = '[]'::jsonb AND EXISTS (SELECT 1 FROM "strategy_definition_revisions" r WHERE r."id" = '${revision.id}' AND r."sha256" = '${revision.sha256}' AND r."created_by" = 'migration:0061');`
      );
    }
  });
});

describe("qcPortRevisions", () => {
  it("parses with the schema defaults and escapes quotes", async () => {
    const input = editIdea("qc-asset-class-trend", (entry) => {
      entry.definition = {
        ...stored[0]?.definition,
        exit: undefined,
        name: "Trend's edge",
        sizing: undefined,
      };
    });
    const revisions = await qcPortRevisions(input, DATA_TO);
    expect(JSON.parse(revisions[0]?.definitionJson ?? "")).toMatchObject({
      exit: { any: [] },
      name: "Trend's edge",
      sizing: { mode: "allIn" },
    });
    expect(renderMigration(revisions)).toContain("'Trend''s edge'");
  });

  it("keeps backslashes literal under standard_conforming_strings", async () => {
    const input = editIdea("qc-asset-class-trend", (entry) => {
      entry.definition = { ...stored[0]?.definition, name: "Trend \\ edge" };
    });
    const revisions = await qcPortRevisions(input, DATA_TO);
    const sql = renderMigration(revisions);
    expect(revisions[0]?.name).toBe("Trend \\ edge");
    expect(sql).toContain("'Trend \\ edge'");
    expect(sql).toContain('"name":"Trend \\\\ edge"');
    expect(sql).not.toContain("E'");
    expect(
      sql.indexOf("SET LOCAL standard_conforming_strings = on;")
    ).toBeLessThan(sql.indexOf("INSERT INTO"));
    const down = renderRollback(revisions);
    expect(
      down.indexOf("SET LOCAL standard_conforming_strings = on;")
    ).toBeLessThan(down.indexOf("INSERT INTO"));
  });

  const withoutOpex = (): MutableInput => {
    const input = committedInput();
    delete input["qc-opex-week"];
    return input;
  };

  it.each([
    [committedInput(), "2026-11", "data-to must be"],
    [withoutOpex(), DATA_TO, "definitions must cover exactly"],
    [
      editIdea("qc-opex-week", (entry) => {
        entry.run = "opex-week/B";
      }),
      DATA_TO,
      "qc-opex-week: expected run A",
    ],
    [
      editIdea("qc-opex-week", (entry) => {
        entry.start = "1993";
      }),
      DATA_TO,
      "qc-opex-week: expected run A",
    ],
    [
      editIdea("qc-opex-week", (entry) => {
        entry.definition = { name: "x" };
      }),
      DATA_TO,
      "qc-opex-week: ",
    ],
  ])("refuses bad input %#", async (input, dataTo, message) => {
    await expect(qcPortRevisions(input, dataTo)).rejects.toThrow(message);
  });
});

describe("runQcPortDefinitions", () => {
  const inputFiles = (): Record<string, string> => ({
    "defs.json": JSON.stringify(committedInput()),
    [String(MIGRATION_URL)]: migration,
    [String(ROLLBACK_URL)]: rollback,
  });

  it("writes both files from an input file and prints the hashes", async () => {
    const { io, out, written } = createIo({}, inputFiles());
    await expect(
      runQcPortDefinitions(["--input", "defs.json", "--data-to", DATA_TO], io)
    ).resolves.toBe(0);
    expect(written.get(MIGRATION_URL.pathname)).toBe(migration);
    expect(written.get(ROLLBACK_URL.pathname)).toBe(rollback);
    expect(out).toEqual(stored.map((row) => `${row.idea} ${row.sha256}\n`));
  });

  it("checks without writing: equal files pass, changed or missing files fail", async () => {
    const equal = createIo({}, inputFiles());
    await expect(
      runQcPortDefinitions(
        ["--check", "--input", "defs.json", "--data-to", DATA_TO],
        equal.io
      )
    ).resolves.toBe(0);
    expect(equal.written.size).toBe(0);
    const files = inputFiles();
    files[String(MIGRATION_URL)] = `${migration}-- edited\n`;
    delete files[String(ROLLBACK_URL)];
    const stale = createIo({}, files);
    await expect(
      runQcPortDefinitions(
        ["--input", "defs.json", "--data-to", DATA_TO, "--check"],
        stale.io
      )
    ).resolves.toBe(1);
    expect(stale.err).toEqual([
      `${MIGRATION_URL.pathname} differs from the generator output\n`,
      `${ROLLBACK_URL.pathname} differs from the generator output\n`,
    ]);
  });

  it("runs the Python definitions command in services/research, reading the last bar date", async () => {
    const spawn = pythonSpawn();
    const { io, written } = createIo({ env: { HOME: "/home/x" }, spawn });
    await expect(runQcPortDefinitions([], io)).resolves.toBe(0);
    expect(written.get(MIGRATION_URL.pathname)).toBe(migration);
    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.map(([command, args]) => [command, args[0]])).toEqual([
      ["/tmp/qcp-nt-venv/bin/python", "-m"],
      ["/tmp/qcp-nt-venv/bin/python", "-c"],
    ]);
    expect(calls[0]?.[1]).toEqual(["-m", "strategies.qc_ports", "definitions"]);
    expect(calls[0]?.[2].cwd).toMatch(/services\/research\/$/u);
    expect(calls[0]?.[2].env).toEqual({ HOME: "/home/x", PYTHONPATH: "." });
  });

  it("takes the python from --python, then VERTEX_NAUTILUS_PYTHON, and --data-to over the last bar", async () => {
    const flagged = pythonSpawn();
    await runQcPortDefinitions(
      ["--python", "/opt/py", "--data-to", DATA_TO],
      createIo({ env: { VERTEX_NAUTILUS_PYTHON: "/env/py" }, spawn: flagged })
        .io
    );
    expect(vi.mocked(flagged).mock.calls.map(([command]) => command)).toEqual([
      "/opt/py",
    ]);
    const fromEnv = pythonSpawn();
    await runQcPortDefinitions(
      [],
      createIo({ env: { VERTEX_NAUTILUS_PYTHON: "/env/py" }, spawn: fromEnv })
        .io
    );
    expect(vi.mocked(fromEnv).mock.calls[0]?.[0]).toBe("/env/py");
  });

  it("reports a failing Python run", async () => {
    const spawn = vi.fn<Spawn>(() => ({
      status: 2,
      stderr: "no module\n",
      stdout: "",
    }));
    const { err, io } = createIo({ spawn });
    await expect(runQcPortDefinitions([], io)).resolves.toBe(1);
    expect(err.join("")).toBe(
      "qc-port definitions failed: /tmp/qcp-nt-venv/bin/python -m strategies.qc_ports definitions exited with 2: no module\n"
    );
  });

  it.each([[["--force"]], [["--input"]], [["--input", "--check"]]])(
    "refuses usage %j",
    async (argv) => {
      const { err, io } = createIo();
      await expect(runQcPortDefinitions(argv, io)).resolves.toBe(1);
      expect(err.join("")).toContain(
        "qc-port definitions failed: usage: bun scripts/research-qc-port-definitions.ts"
      );
    }
  );

  it("refuses --check without --input, before running Python", async () => {
    const spawn = pythonSpawn();
    const { err, io, written } = createIo({ spawn });
    await expect(
      runQcPortDefinitions(["--check", "--data-to", DATA_TO], io)
    ).resolves.toBe(1);
    expect(err.join("")).toContain("--check needs --input");
    expect(spawn).not.toHaveBeenCalled();
    expect(written.size).toBe(0);
  });

  it("needs --data-to with --input and reports non-Error failures", async () => {
    const missing = createIo({}, inputFiles());
    await expect(
      runQcPortDefinitions(["--input", "defs.json"], missing.io)
    ).resolves.toBe(1);
    expect(missing.err.join("")).toContain("--input needs --data-to");
    const plain = createIo({
      spawn: vi.fn<Spawn>(() => {
        throw "spawn refused";
      }),
    });
    await expect(runQcPortDefinitions([], plain.io)).resolves.toBe(1);
    expect(plain.err.join("")).toBe(
      "qc-port definitions failed: spawn refused\n"
    );
  });
});
