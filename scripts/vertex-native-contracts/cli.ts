import { runNativeContractFixtureCli } from "./export-fixtures.ts";
import { runNativeProofFixtureCli } from "./export-proof-fixtures.ts";
import { runNativeContractGeneratorCli } from "./generate.ts";

export type VertexContractCommand = (
  arguments_: readonly string[]
) => Promise<number>;

export type VertexContractCommands = Readonly<
  Record<"generate" | "fixtures" | "proof-fixtures", VertexContractCommand>
>;

export const VERTEX_CONTRACT_COMMANDS: VertexContractCommands = {
  generate: runNativeContractGeneratorCli,
  fixtures: runNativeContractFixtureCli,
  "proof-fixtures": runNativeProofFixtureCli,
};

const isCommand = (
  value: string | undefined,
  commands: VertexContractCommands
): value is keyof VertexContractCommands =>
  value !== undefined && Object.hasOwn(commands, value);

// Each command writes one new explicit output path; nothing runs on import.
export const runVertexContractsCli = async (
  arguments_: readonly string[],
  writeError: (value: string) => void,
  commands: VertexContractCommands = VERTEX_CONTRACT_COMMANDS
): Promise<number> => {
  const [command, ...rest] = arguments_;
  if (!isCommand(command, commands)) {
    writeError(
      "Usage: vertex-contracts.ts <generate|fixtures|proof-fixtures> --output <new-explicit-path>\n"
    );
    return 2;
  }
  return await commands[command](rest);
};
