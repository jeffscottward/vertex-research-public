import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalArtifactJson } from "../../packages/shared/src/vertex/index.ts";
import { buildNativeFactsFixtures } from "./native-facts-fixtures.ts";
import { rawBytesSha256 } from "./generate.ts";
import { MAX_PAYLOAD_BYTES, parseStrictJson } from "./portable.ts";

// Pair verification is distinct from validating a standalone NativeJournalProof
// document. Neither can authenticate a publisher or authorize spendable capital.
const encodeNativeProofFixtures = async (): Promise<Uint8Array> => {
  const { proofs } = await buildNativeFactsFixtures();
  const document = {
    proofFixtureFormat: "vertex-native-journal-proof-fixtures-v1",
    schemaVersion: "1.0.0",
    cases: proofs,
  };
  const bytes = new TextEncoder().encode(canonicalArtifactJson(document));
  parseStrictJson(bytes, MAX_PAYLOAD_BYTES);
  return bytes;
};

export const runNativeProofFixtureCli = async (
  args: readonly string[]
): Promise<number> => {
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new TypeError(
      "Usage: vertex-contracts.ts proof-fixtures --output <new-explicit-proof-fixture-path>"
    );
  }
  const output = resolve(args[1]);
  const bytes = await encodeNativeProofFixtures();
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      path: output,
      rawProofFixtureSha256: await rawBytesSha256(bytes),
    })
  );
  return 0;
};
