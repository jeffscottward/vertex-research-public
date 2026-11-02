import {
  assertAmbientInputs,
  destinationBinding,
  inputFailure,
  materializeApprovedSource,
  sha256,
  validateRequest,
  type ApprovedRevisionDeploymentRequest,
  type ApprovedSource,
  type GitObjectReader,
} from "./approved-inputs.ts";
import type { DeploymentEnvironment } from "./database.ts";

// Official registry child-manifest/config metadata verified 2026-09-22.
// This is not binary compatibility proof; preparation verifies actual versions.
export const runtimeImagePins = Object.freeze({
  node: "docker.io/library/node:22.13.1-bookworm-slim@sha256:e71b848e62e2c32bf5572b327b032a0da79b6a390bc924cdb827249c81e13a88",
  bun: "docker.io/oven/bun:1.3.14-slim@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0",
});

export type PreparationPolicy = Readonly<{
  version: 1;
  platform: "linux/amd64";
  node: "22.13.1";
  bun: "1.3.14";
  pnpm: "11.16.0";
  nodeImage: string;
  bunImage: string;
  offlineInputsSha256: string;
}>;
export type SealedDeploymentInputs = Readonly<{
  imageId: string;
  sourceSha256: string;
  authoritySha256: string;
  policySha256: string;
  dependencySha256: string;
  toolchainSha256: string;
}>;
export type AdapterOperation = Readonly<{
  mode: "check" | "deploy";
  environment: "production" | "staging";
}>;
export type RunnerPhase =
  | "admission"
  | "source"
  | "preparation"
  | "execution"
  | "cleanup";
const prerequisiteReasons = [
  "pinned-runtime-images-required",
  "pinned-offline-inputs-required",
  "runtime-image-unavailable",
  "offline-capsule-unavailable",
  "projected-provider-credential-required",
] as const;
export type RunnerResult = Readonly<{
  version: 1;
  mode: "check" | "deploy";
  environment: "production" | "staging";
  status: "completed" | "blocked" | "uncertain";
  phase: RunnerPhase;
  reason:
    | "none"
    | "operation-failed"
    | "cleanup-failed"
    | (typeof prerequisiteReasons)[number];
  exitCode: number;
  providerMayHaveBeenReached: boolean;
  cleanup: "complete" | "failed";
}>;
export type DeploymentRunnerPorts = Readonly<{
  reader: GitObjectReader;
  admit: (request: ApprovedRevisionDeploymentRequest) => Promise<void>;
  prepare: (
    source: ApprovedSource,
    policy: PreparationPolicy,
    policySha256: string
  ) => Promise<SealedDeploymentInputs>;
  execute: (
    inputs: SealedDeploymentInputs,
    operation: AdapterOperation
  ) => Promise<number>;
  cleanup: () => Promise<void>;
}>;

export const officialAdapterArguments = (
  operation: AdapterOperation
): readonly string[] => {
  if (
    !(
      ["check", "deploy"].includes(operation.mode) &&
      ["production", "staging"].includes(operation.environment)
    )
  )
    inputFailure("operation");
  return Object.freeze([
    "deploy",
    ...(operation.mode === "check" ? ["--dry-run"] : []),
    ...(operation.environment === "staging" ? ["--env", "staging"] : []),
  ]);
};

export const preparationPolicy = (
  source: ApprovedSource
): Readonly<{ policy: PreparationPolicy; sha256: string }> => {
  const file = source.files.find(
    (item) => item.path === "infra/docker/deployment/policy.json"
  );
  if (!file || file.bytes.length > 4096) inputFailure("preparation-policy");
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    inputFailure("preparation-policy");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    inputFailure("preparation-policy");
  const p = parsed as Record<string, unknown>;
  if (
    Object.keys(p).sort().join(",") !==
      "bun,bunImage,node,nodeImage,offlineInputsSha256,platform,pnpm,version" ||
    p["version"] !== 1 ||
    p["platform"] !== "linux/amd64" ||
    p["node"] !== "22.13.1" ||
    p["bun"] !== "1.3.14" ||
    p["pnpm"] !== "11.16.0"
  )
    inputFailure("preparation-policy");
  if (
    p["nodeImage"] !== runtimeImagePins.node ||
    p["bunImage"] !== runtimeImagePins.bun
  )
    inputFailure("pinned-runtime-images-required");
  if (
    typeof p["offlineInputsSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(p["offlineInputsSha256"])
  )
    inputFailure("pinned-offline-inputs-required");
  const node = source.files.find((item) => item.path === ".nvmrc");
  const root = source.files.find((item) => item.path === "package.json");
  if (node?.bytes.toString("utf8").trim() !== p["node"] || !root)
    inputFailure("toolchain-authority");
  const manifest = JSON.parse(root.bytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  if (manifest["packageManager"] !== `pnpm@${p["pnpm"]}`)
    inputFailure("toolchain-authority");
  return Object.freeze({
    policy: Object.freeze({ ...p }) as PreparationPolicy,
    sha256: sha256(file.bytes),
  });
};

export const runApprovedRevisionDeployment = async (
  request: ApprovedRevisionDeploymentRequest,
  source: DeploymentEnvironment,
  ports: DeploymentRunnerPorts
): Promise<RunnerResult> => {
  const mode = request?.mode === "deploy" ? "deploy" : "check";
  const environmentName =
    request?.environment === "staging" ? "staging" : "production";
  let phase: RunnerPhase = "admission";
  let exitCode = 1;
  let providerMayHaveBeenReached = false;
  let completed = false;
  let cleanup: "complete" | "failed" = "complete";
  let reason: RunnerResult["reason"] = "operation-failed";
  try {
    validateRequest(request);
    // Snapshot identity/authority before the first await; never retain caller maps.
    const admitted = Object.freeze({
      ...request,
      destinationBinding: destinationBinding(request.destinationBinding),
    });
    const environment = Object.freeze({ ...source });
    assertAmbientInputs(environment);
    await ports.admit(admitted);
    phase = "source";
    const snapshot = await materializeApprovedSource(
      admitted,
      ports.reader,
      environment
    );
    const { policy, sha256: policySha256 } = preparationPolicy(snapshot);
    phase = "preparation";
    const sealed = await ports.prepare(snapshot, policy, policySha256);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(sealed.imageId) ||
      sealed.sourceSha256 !== snapshot.manifestSha256 ||
      sealed.authoritySha256 !== snapshot.dependencyAuthoritySha256 ||
      sealed.policySha256 !== policySha256 ||
      !/^[a-f0-9]{64}$/.test(sealed.dependencySha256) ||
      !/^[a-f0-9]{64}$/.test(sealed.toolchainSha256)
    )
      inputFailure("sealed-identity");
    // A fresh admission observation cannot mutate the sealed image; it can only
    // deny a stale request. No post-upload check is used as an isolation claim.
    await ports.admit(admitted);
    phase = "execution";
    providerMayHaveBeenReached = admitted.mode === "deploy";
    const status = await ports.execute(
      sealed,
      Object.freeze({ mode: admitted.mode, environment: admitted.environment })
    );
    exitCode =
      Number.isInteger(status) && status >= 0 && status <= 255 ? status : 1;
    completed = exitCode === 0;
    if (completed) reason = "none";
  } catch (error) {
    // Never retain arbitrary exception, destination, credential or child output.
    exitCode = 1;
    if (error instanceof Error) {
      const prerequisite = prerequisiteReasons.find(
        (code) => error.message === `deployment-input:${code}`
      );
      if (prerequisite) reason = prerequisite;
    }
  } finally {
    try {
      await ports.cleanup();
    } catch {
      cleanup = "failed";
      phase = "cleanup";
      exitCode = 1;
      reason = "cleanup-failed";
    }
  }
  return Object.freeze({
    version: 1,
    mode,
    environment: environmentName,
    status:
      completed && cleanup === "complete"
        ? "completed"
        : providerMayHaveBeenReached
          ? "uncertain"
          : "blocked",
    phase,
    reason,
    exitCode,
    providerMayHaveBeenReached,
    cleanup,
  });
};
