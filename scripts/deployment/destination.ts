import { createHash } from "node:crypto";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import type { DeploymentEnvironment } from "./database.ts";

/** wrangler.jsonc carries comments: parse it as JSONC and fail closed on any error. */
export const parseWranglerConfiguration = (text: string): unknown => {
  const errors: ParseError[] = [];
  const config: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) throw new SyntaxError("Invalid wrangler.jsonc");
  return config;
};

export type WebDeploymentEnvironment = "production" | "staging";
export type WebDeploymentDestinationCheck = Readonly<{
  ok: boolean;
  status: "blocked" | "verified";
  message: string;
}>;

const blocked = (message: string): WebDeploymentDestinationCheck => ({
  ok: false,
  status: "blocked",
  message,
});

const record = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const checkWebDeploymentDestination = (
  input: unknown,
  source: DeploymentEnvironment = {}
): WebDeploymentDestinationCheck => {
  if (
    !record(input) ||
    (input["environment"] !== "production" &&
      input["environment"] !== "staging")
  ) {
    return blocked(
      "An explicit production or staging deployment environment is required"
    );
  }
  if (!record(input["config"])) {
    return blocked("A parsed Wrangler destination configuration is required");
  }
  const staging = input["environment"] === "staging";
  const config = input["config"];
  const selected =
    staging && record(config["env"])
      ? config["env"]["staging"]
      : staging
        ? undefined
        : config;
  if (!record(selected)) {
    return blocked(
      "The selected environment requires its own explicit Wrangler configuration"
    );
  }
  const accountId = selected["account_id"];
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId)) {
    return blocked(
      "Deployment is blocked: an explicit verified destination account is missing or malformed"
    );
  }
  const accountFingerprint = createHash("sha256")
    .update(accountId)
    .digest("hex");
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"]) {
    if (source[key] && source[key] !== accountId) {
      return blocked(
        "Ambient account selection conflicts with the verified destination"
      );
    }
  }
  // Presence, including an empty value, is unsupported. The adapter and Vite
  // have different fallback rules; neither may select a second config or env.
  for (const key of [
    "CLOUDFLARE_ENV",
    "WRANGLER_ENV",
    "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
    "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT",
    "CLOUDFLARE_VITE_BUILD",
    "WRANGLER_CI_OVERRIDE_NAME",
  ]) {
    if (source[key] !== undefined) {
      return blocked(
        "Ambient environment, configuration, build-output, and Worker-name selectors are forbidden"
      );
    }
  }
  const workerName = staging
    ? "vertex-research-web-staging"
    : "vertex-research-web";
  const origin = staging
    ? "https://staging.vertex.xyz"
    : "https://app.vertex.xyz";
  if (selected["name"] !== workerName) {
    return blocked(
      "The selected Worker must use the isolated environment-specific Vertex name"
    );
  }
  if (selected["workers_dev"] !== false || selected["preview_urls"] !== false) {
    return blocked(
      "Workers.dev and preview delivery must remain explicitly disabled"
    );
  }
  const routes = selected["routes"];
  if (!Array.isArray(routes) || routes.length !== 1) {
    return blocked(
      "Deployment is blocked: exactly one verified isolated custom-domain route is required"
    );
  }
  const route: unknown = routes[0];
  if (
    !record(route) ||
    route["pattern"] !== new URL(origin).hostname ||
    route["custom_domain"] !== true ||
    Object.keys(route).some(
      (key) => !["pattern", "custom_domain"].includes(key)
    )
  ) {
    return blocked(
      "Inherited, apex, wildcard, foreign, or implicit delivery routes are forbidden"
    );
  }
  const vars = selected["vars"];
  if (
    !record(vars) ||
    vars["APP_ENV"] !== "production" ||
    vars["APP_URL"] !== origin ||
    vars["BETTER_AUTH_URL"] !== origin
  ) {
    return blocked(
      "Application and authentication origins must match the isolated verified destination"
    );
  }
  if (
    vars["EMAIL_PROVIDER"] !== "disabled" ||
    vars["EMAIL_TRANSPORT"] !== "disabled" ||
    vars["EMAIL_FROM"] ||
    vars["RESEND_API_KEY"]
  ) {
    return blocked(
      "Email provider, transport, sending identity, and credentials must remain disabled or absent"
    );
  }
  const verification = input["verification"];
  if (!record(verification)) {
    return blocked(
      "An explicit private operator destination-verification receipt is required"
    );
  }
  if (
    typeof input["headSha"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(input["headSha"])
  ) {
    return blocked(
      "Destination verification requires the exact current Git commit SHA"
    );
  }
  if (
    verification["version"] !== 1 ||
    verification["environment"] !== input["environment"] ||
    verification["accountFingerprint"] !== accountFingerprint ||
    verification["workerName"] !== workerName ||
    verification["origin"] !== origin ||
    verification["exactSha"] !== input["headSha"]
  ) {
    return blocked(
      "Destination verification does not match the selected account, site, environment, and exact SHA"
    );
  }
  if (
    typeof verification["approvedBy"] !== "string" ||
    !verification["approvedBy"].trim() ||
    verification["accountVerified"] !== true ||
    verification["domainVerified"] !== true ||
    verification["cutoverApproved"] !== true
  ) {
    return blocked(
      "Explicit human account/domain verification and destination cutover approval are required"
    );
  }
  return {
    ok: true,
    status: "verified",
    message:
      "Isolated web destination matches the explicit operator verification; deployment policy gates remain required",
  };
};
