import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalArtifactJson } from "../../packages/shared/src/vertex/index.ts";
import {
  buildNativeCapacityFixtures,
  buildNativeContractFixtures,
} from "./fixtures.ts";
import { rawBytesSha256 } from "./generate.ts";
import { MAX_PAYLOAD_BYTES, parseStrictJson } from "./portable.ts";

const encodeNativeContractFixtures = async (
  includeCapacity = true
): Promise<Uint8Array> => {
  const document = await buildNativeContractFixtures();
  if (includeCapacity)
    document.cases.push(...(await buildNativeCapacityFixtures()));
  const bytes = new TextEncoder().encode(canonicalArtifactJson(document));
  parseStrictJson(bytes, MAX_PAYLOAD_BYTES);
  return bytes;
};

export const runNativeContractFixtureCli = async (
  args: readonly string[]
): Promise<number> => {
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new TypeError(
      "Usage: vertex-contracts.ts fixtures --output <new-explicit-fixture-path>"
    );
  }
  const output = resolve(args[1]);
  const bytes = await encodeNativeContractFixtures();
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      path: output,
      rawFixtureSha256: await rawBytesSha256(bytes),
    })
  );
  return 0;
};
