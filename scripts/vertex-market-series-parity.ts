// Parity check of the QC-ports daily series import against services/research/strategies/qc_ports/data.py.
// Research only; never writes to an app database.
// Usage: bun scripts/vertex-market-series-parity.ts [<data dir>]
//        bun scripts/with-test-env.ts bun scripts/vertex-market-series-parity.ts --postgres [<data dir>]
// Without --postgres the parsed import rows are compared directly. With --postgres they are
// imported into a throwaway database on the local test Postgres (@darkfactory/testkit refuses any
// other server), loaded back through the repository, then compared, so the float8 round trip is
// part of the check. Python: $VERTEX_QC_PORTS_PYTHON, else /tmp/qcp-nt-venv/bin/python, else python3.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createMarketDailySeriesRepository,
  createNodeDatabase,
  type MarketDailyColumns,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
} from "@darkfactory/testkit/postgres";

import {
  loadSeriesImports,
  type SeriesImport,
} from "./market-series/import.ts";
import {
  compareDigests,
  formatParity,
  researchViewDigests,
  type ViewDigest,
} from "./market-series/parity.ts";

const args = process.argv.slice(2);
const viaPostgres = args.includes("--postgres");
const dir =
  args.find((arg) => !arg.startsWith("--")) ??
  process.env["VERTEX_QC_PORTS_DATA"] ??
  join(homedir(), "Documents", "reports", "vertex-qc-ports", "data");

const columnsOf = (entry: SeriesImport): MarketDailyColumns => ({
  adjClose: entry.points.map((point) => point.adjClose),
  close: entry.points.map((point) => point.close),
  dates: entry.points.map((point) => point.date),
  high: entry.points.map((point) => point.high),
  low: entry.points.map((point) => point.low),
  open: entry.points.map((point) => point.open),
});

const roundTrip = async (
  entries: readonly SeriesImport[]
): Promise<Map<string, MarketDailyColumns>> => {
  const database = await createPostgresTestDatabase();
  const resource = createNodeDatabase({
    connectionString: database.databaseUrl,
    maxConnections: 2,
  });
  try {
    await migrate(resource.db);
    const repository = createMarketDailySeriesRepository(resource.db);
    for (const entry of entries) {
      await repository.replaceSeries(entry.series, entry.points);
    }
    return await repository.loadSeries(entries.map((entry) => entry.series.id));
  } finally {
    await resource.close();
    await dropPostgresTestDatabase(database);
  }
};

const python =
  process.env["VERTEX_QC_PORTS_PYTHON"] ??
  (existsSync("/tmp/qcp-nt-venv/bin/python")
    ? "/tmp/qcp-nt-venv/bin/python"
    : "python3");

const imports = await loadSeriesImports(dir);
const loaded = viaPostgres
  ? await roundTrip(imports)
  : new Map(imports.map((entry) => [entry.series.id, columnsOf(entry)]));
const pythonRun = spawnSync(
  python,
  [new URL("./market-series/parity.py", import.meta.url).pathname, dir],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
);
if (pythonRun.status !== 0) {
  process.stderr.write(pythonRun.stderr);
  throw new Error(`${python} parity.py exited with ${pythonRun.status}`);
}
const rows = compareDigests(
  researchViewDigests(loaded),
  JSON.parse(pythonRun.stdout) as Record<string, ViewDigest>
);
process.stdout.write(
  `data ${dir}; ${viaPostgres ? "through a test Postgres round trip" : "parsed rows"}; python ${python}\n`
);
process.stdout.write(formatParity(rows));
process.exitCode = rows.every((row) => row.equal) ? 0 : 1;
