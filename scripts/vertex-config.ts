import { runVertexConfigCli } from "./vertex-config/cli.ts";

process.exitCode = runVertexConfigCli(process.argv, process.stdout);
