import { runVertexContractsCli } from "./vertex-native-contracts/cli.ts";

process.exitCode = await runVertexContractsCli(process.argv.slice(2), (value) =>
  process.stderr.write(value)
);
