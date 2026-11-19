// Step-4 "current engine vs Nautilus" report page (research only). See scripts/engine-comparison-report/run.ts.
import { nodeReportIo } from "./engine-comparison-report/node-io.ts";
import { runEngineComparisonReport } from "./engine-comparison-report/run.ts";

process.exitCode = await runEngineComparisonReport(
  process.argv.slice(2),
  nodeReportIo(process.env)
);
