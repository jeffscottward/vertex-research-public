import {
  objectId,
  sha256,
  type ApprovedRevisionDeploymentRequest,
  type GitObjectReader,
} from "./approved-inputs.ts";
import { runtimeImagePins } from "./runner.ts";

export const syntheticEnvironment = Object.freeze({
  DATABASE_PROVIDER: "planetscale",
  DATABASE_URL:
    "postgresql://test:test@aws.pg.psdb.cloud:6432/isolated_test?sslmode=verify-full",
});
export const syntheticPolicy = Object.freeze({
  version: 1,
  platform: "linux/amd64",
  node: "22.13.1",
  bun: "1.3.14",
  pnpm: "11.16.0",
  nodeImage: runtimeImagePins.node,
  bunImage: runtimeImagePins.bun,
  offlineInputsSha256: "f".repeat(64),
});
export const syntheticRevision = (
  overrides: Record<string, string | null> = {},
  environment: "production" | "staging" = "production",
  modes: Record<string, string> = {}
) => {
  const origin =
    environment === "production"
      ? "https://app.vertex.xyz"
      : "https://staging.vertex.xyz";
  const workerName =
    environment === "production"
      ? "vertex-research-web"
      : "vertex-research-web-staging";
  const selected = {
    account_id: "a".repeat(32),
    name: workerName,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: new URL(origin).hostname, custom_domain: true }],
    vars: {
      APP_ENV: "production",
      APP_URL: origin,
      BETTER_AUTH_URL: origin,
      EMAIL_PROVIDER: "disabled",
      EMAIL_TRANSPORT: "disabled",
    },
  };
  const configuration = JSON.stringify(
    environment === "production" ? selected : { env: { staging: selected } }
  );
  const files: Record<string, string | null> = {
    "package.json": JSON.stringify({ packageManager: "pnpm@11.16.0" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: [apps/*, packages/*]\n",
    ".nvmrc": "22.13.1\n",
    "infra/docker/deployment/policy.json": JSON.stringify(syntheticPolicy),
    "apps/web/wrangler.jsonc": configuration,
    "apps/web/package.json": "{}",
    "apps/web/src/app/(portal)/[id]/page.civet": "export default () => null\n",
    ...overrides,
  };
  const objects = new Map<string, Buffer>();
  const put = (kind: string, bytes: Buffer) => {
    const oid = objectId(kind, bytes);
    objects.set(oid, bytes);
    return oid;
  };
  const paths = Object.keys(files).filter((path) => files[path] !== null);
  const tree = (prefix: string): string => {
    const names = [
      ...new Set(
        paths
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split("/")[0]!)
      ),
    ].sort();
    const entries = names.map((name) => {
      const path = prefix + name;
      const directory = paths.some((key) => key.startsWith(`${path}/`));
      const oid = directory
        ? tree(`${path}/`)
        : put("blob", Buffer.from(files[path]!));
      return Buffer.concat([
        Buffer.from(
          `${directory ? "40000" : (modes[path] ?? "100644")} ${name}\0`
        ),
        Buffer.from(oid, "hex"),
      ]);
    });
    return put("tree", Buffer.concat(entries));
  };
  const treeId = tree("");
  const exactSha = put(
    "commit",
    Buffer.from(
      `tree ${treeId}\nauthor Synthetic <synthetic@example.invalid> 0 +0000\n\nfixture\n`
    )
  );
  const configurationSha256 = sha256(
    Buffer.from(files["apps/web/wrangler.jsonc"] ?? configuration)
  );
  const request: ApprovedRevisionDeploymentRequest = {
    exactSha,
    configurationSha256,
    environment,
    mode: "check",
    destinationBinding: {
      version: 1,
      exactSha,
      configurationSha256,
      environment,
      workerName,
      origin,
      accountFingerprint: sha256("a".repeat(32)),
      approvedBy: "synthetic-operator",
      accountVerified: true,
      domainVerified: true,
      cutoverApproved: true,
    },
  };
  const reader: GitObjectReader = {
    read: async (_kind, oid) => {
      const bytes = objects.get(oid);
      if (!bytes) throw new Error("synthetic-missing-object");
      return bytes;
    },
  };
  return { request, reader, objects, files, treeId };
};
