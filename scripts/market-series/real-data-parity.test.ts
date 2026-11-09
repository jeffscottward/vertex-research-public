// Parity of the QC-ports daily series import with services/research/strategies/qc_ports/data.py on
// the real fetch (research data, never committed). Skips when the data or a Python with the
// research code is missing: $VERTEX_QC_PORTS_DATA or ~/Documents/reports/vertex-qc-ports/data, and
// $VERTEX_QC_PORTS_PYTHON or /tmp/qcp-nt-venv/bin/python.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MarketDailyColumns } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import { loadSeriesImports, type SeriesImport } from "./import.ts";
import {
  compareDigests,
  researchViewDigests,
  type ViewDigest,
} from "./parity.ts";

const dir =
  process.env["VERTEX_QC_PORTS_DATA"] ??
  join(homedir(), "Documents", "reports", "vertex-qc-ports", "data");
const python =
  process.env["VERTEX_QC_PORTS_PYTHON"] ?? "/tmp/qcp-nt-venv/bin/python";
const ready =
  existsSync(join(dir, "SHA256SUMS")) &&
  (python !== "/tmp/qcp-nt-venv/bin/python" || existsSync(python));

const columnsOf = (entry: SeriesImport): MarketDailyColumns => ({
  adjClose: entry.points.map((point) => point.adjClose),
  close: entry.points.map((point) => point.close),
  dates: entry.points.map((point) => point.date),
  high: entry.points.map((point) => point.high),
  low: entry.points.map((point) => point.low),
  open: entry.points.map((point) => point.open),
});

describe.skipIf(!ready)(
  "series import parity on the real qc-ports data",
  () => {
    it("equals data.py for every series, bar view and total-return view", async () => {
      const imports = await loadSeriesImports(dir);
      const loaded = new Map(
        imports.map((entry) => [entry.series.id, columnsOf(entry)])
      );
      const run = spawnSync(
        python,
        [new URL("./parity.py", import.meta.url).pathname, dir],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
      );
      expect(run.status, run.stderr).toBe(0);
      const rows = compareDigests(
        researchViewDigests(loaded),
        JSON.parse(run.stdout) as Record<string, ViewDigest>
      );
      expect(rows.filter((row) => !row.equal)).toEqual([]);
      expect(rows.length).toBe(46);
    }, 120_000);
  }
);
