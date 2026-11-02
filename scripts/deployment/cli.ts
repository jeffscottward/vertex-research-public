import { createHash } from "node:crypto";
import {
  runProductionWebDatabaseCheck,
  type DeploymentCheckStream,
  type DeploymentEnvironment,
} from "./database.ts";
import {
  checkWebDeploymentDestination,
  parseWranglerConfiguration,
} from "./destination.ts";
import {
  destinationBinding,
  type ApprovedRevisionDeploymentRequest,
} from "./approved-inputs.ts";

export type WebDeploymentDependencies = Readonly<{
  source: DeploymentEnvironment;
  readConfiguration: (headSha: string) => Promise<string>;
  readReceipt: (path: string) => Promise<string>;
  currentHead: () => Promise<string>;
  cleanTree: () => Promise<boolean>;
  assertAdapterInputs: () => Promise<void>;
  deploy: (request: ApprovedRevisionDeploymentRequest) => Promise<number>;
  output: DeploymentCheckStream;
  errorOutput: DeploymentCheckStream;
}>;

const parseOptions = (args: readonly string[]) => {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !(
        key &&
        ["--environment", "--destination-receipt", "--mode"].includes(key) &&
        value
      ) ||
      options.has(key)
    ) {
      return;
    }
    options.set(key, value);
  }
  const environment = options.get("--environment");
  const receipt = options.get("--destination-receipt");
  const mode = options.get("--mode") ?? "validate";
  if (!["validate", "check", "deploy"].includes(mode)) {
    return;
  }
  if ((environment !== "production" && environment !== "staging") || !receipt) {
    return;
  }
  return { environment, receipt, mode };
};

export const runWebDeploymentCli = async (
  args: readonly string[],
  dependencies: WebDeploymentDependencies
): Promise<number> => {
  const fail = (message: string) => {
    dependencies.errorOutput.write(
      `deployment destination check: blocked: ${message}\n`
    );
    return 1;
  };
  const options = parseOptions(args);
  if (!options) {
    return fail(
      "Explicit --environment production|staging and --destination-receipt are required; preview and override options are forbidden"
    );
  }
  try {
    if (!(await dependencies.cleanTree())) {
      return fail(
        "A clean working tree is required for exact-SHA destination verification"
      );
    }
    await dependencies.assertAdapterInputs();
    const headSha = await dependencies.currentHead();
    const text = await dependencies.readConfiguration(headSha);
    const config = parseWranglerConfiguration(text);
    const receipt: unknown = JSON.parse(
      await dependencies.readReceipt(options.receipt)
    );
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      Array.isArray(receipt) ||
      (receipt as Record<string, unknown>)["configurationSha256"] !==
        createHash("sha256").update(text).digest("hex")
    ) {
      return fail(
        "The private receipt must bind the exact Wrangler configuration digest"
      );
    }
    const report = checkWebDeploymentDestination(
      {
        environment: options.environment,
        config,
        verification: receipt,
        headSha,
      },
      dependencies.source
    );
    if (!report.ok) {
      return fail(report.message);
    }
    const databaseStatus = runProductionWebDatabaseCheck(
      dependencies.source,
      dependencies.output,
      dependencies.errorOutput
    );
    if (databaseStatus !== 0) {
      return databaseStatus;
    }
    // These observations reject detectable drift during validation. They are
    // not isolation: the runtime independently seals and verifies Git objects.
    await dependencies.assertAdapterInputs();
    if (
      !(await dependencies.cleanTree()) ||
      (await dependencies.currentHead()) !== headSha ||
      (await dependencies.readConfiguration(headSha)) !== text
    ) {
      return fail(
        "Source, configuration, or HEAD changed during validation; no adapter operation was started"
      );
    }
    dependencies.output.write(
      `deployment destination check: ${report.message}\n`
    );
    if (options.mode === "validate") return 0;
    return await dependencies.deploy(
      Object.freeze({
        exactSha: headSha,
        configurationSha256: createHash("sha256").update(text).digest("hex"),
        environment: options.environment as "production" | "staging",
        mode: options.mode as "check" | "deploy",
        destinationBinding: destinationBinding(receipt),
      })
    );
  } catch {
    return fail(
      "Unable to complete deployment verification or the requested adapter operation; inspect private operator evidence without bypassing gates"
    );
  }
};
