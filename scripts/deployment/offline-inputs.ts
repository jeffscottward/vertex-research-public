import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeploymentCheckStream } from "./database.ts";
import { capsuleDigest, readOfflineCapsule } from "./runner-runtime.ts";

/** Repository root; the capsule lives under its ignored private/ directory. */
export const OFFLINE_INPUTS_ROOT = fileURLToPath(
  new URL("../../", import.meta.url)
);

// Engineering preparation evidence only. No download, Docker, install, source
// edit, destination receipt or deployment authority is created by this command.
export const runOfflineInputsFingerprint = async (
  args: readonly string[],
  root: string,
  output: DeploymentCheckStream,
  errorOutput: DeploymentCheckStream
): Promise<number> => {
  if (args.length !== 1 || args[0] !== "fingerprint") {
    errorOutput.write(
      "deployment offline inputs: explicit fingerprint operation required\n"
    );
    return 1;
  }
  try {
    const files = await readOfflineCapsule(
      resolve(root, "private/deployment/offline-inputs")
    );
    output.write(
      `${JSON.stringify({
        version: 1,
        offlineInputsSha256: capsuleDigest(files),
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
        approval: false,
      })}\n`
    );
    return 0;
  } catch {
    errorOutput.write(
      "deployment offline inputs: bounded regular credentialless capsule unavailable\n"
    );
    return 1;
  }
};
