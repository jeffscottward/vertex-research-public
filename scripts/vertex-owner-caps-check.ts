import { runOwnerCapsCheck } from "./vertex-owner-caps/cli.ts";

process.exitCode = runOwnerCapsCheck(process.argv, process.env, process.stdout);
