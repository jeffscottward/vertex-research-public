// Breadth-90 tick for the rig timer (research only, no orders). See scripts/breadth-90/tick.ts.
import { systemTickIo } from "./breadth-90/system.ts";
import { runBreadth90Tick } from "./breadth-90/tick.ts";

process.exitCode = await runBreadth90Tick(systemTickIo(process));
