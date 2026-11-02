import {
  OFFLINE_INPUTS_ROOT,
  runOfflineInputsFingerprint,
} from "./deployment/offline-inputs.ts";

process.exitCode = await runOfflineInputsFingerprint(
  process.argv.slice(2),
  OFFLINE_INPUTS_ROOT,
  process.stdout,
  process.stderr
);
