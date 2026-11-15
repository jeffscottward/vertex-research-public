import { runGraphCli } from "./graph/cli.ts";
import {
  nodeGraphFileSystem,
  nodeGraphProcess,
  nodeGraphToolchain,
} from "./graph/system.ts";

process.exitCode = await runGraphCli(process.argv.slice(2), {
  graph: {
    files: nodeGraphFileSystem,
    process: nodeGraphProcess,
    toolchain: nodeGraphToolchain,
  },
  writeOutput: (value) => process.stdout.write(value),
  writeError: (value) => process.stderr.write(value),
});
