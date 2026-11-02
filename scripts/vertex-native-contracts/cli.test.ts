import { describe, expect, it, vi } from "vitest";
import {
  runVertexContractsCli,
  VERTEX_CONTRACT_COMMANDS,
  type VertexContractCommands,
} from "./cli.ts";
import { runNativeContractFixtureCli } from "./export-fixtures.ts";
import { runNativeProofFixtureCli } from "./export-proof-fixtures.ts";
import { runNativeContractGeneratorCli } from "./generate.ts";

const fakeCommands = () => {
  const generate = vi.fn(async () => 0);
  const fixtures = vi.fn(async () => 0);
  const proofFixtures = vi.fn(async () => 3);
  const commands: VertexContractCommands = {
    generate,
    fixtures,
    "proof-fixtures": proofFixtures,
  };
  return { commands, generate, fixtures, proofFixtures };
};

describe("vertex native contracts CLI", () => {
  it("binds each subcommand to its exclusive-output writer", () => {
    expect(VERTEX_CONTRACT_COMMANDS).toEqual({
      generate: runNativeContractGeneratorCli,
      fixtures: runNativeContractFixtureCli,
      "proof-fixtures": runNativeProofFixtureCli,
    });
  });

  it("forwards only the remaining arguments to the selected command", async () => {
    const { commands, generate, fixtures, proofFixtures } = fakeCommands();
    const writeError = vi.fn();
    expect(
      await runVertexContractsCli(
        ["generate", "--output", "/tmp/bundle.json"],
        writeError,
        commands
      )
    ).toBe(0);
    expect(generate).toHaveBeenCalledWith(["--output", "/tmp/bundle.json"]);
    expect(
      await runVertexContractsCli(["proof-fixtures"], writeError, commands)
    ).toBe(3);
    expect(proofFixtures).toHaveBeenCalledWith([]);
    expect(fixtures).not.toHaveBeenCalled();
    expect(writeError).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [["unknown"]],
    [["toString"]],
    [["--output", "/tmp/bundle.json"]],
  ])("rejects %j with usage and exit code 2", async (arguments_) => {
    const { commands, generate, fixtures, proofFixtures } = fakeCommands();
    const writeError = vi.fn();
    expect(await runVertexContractsCli(arguments_, writeError, commands)).toBe(
      2
    );
    expect(writeError).toHaveBeenCalledWith(
      expect.stringContaining("Usage: vertex-contracts.ts")
    );
    for (const command of [generate, fixtures, proofFixtures]) {
      expect(command).not.toHaveBeenCalled();
    }
  });
});
