// Go-live draft collection for the rig timer (records only, no orders). See scripts/golive/collect.ts.
import { runGoLiveCollect, systemCollectIo } from "./golive/collect.ts";

process.exitCode = await runGoLiveCollect(systemCollectIo(process));
