import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkWebDeploymentDestination,
  parseWranglerConfiguration,
} from "./destination.ts";

// Synthetic identities only; no provider calls or real deployment approval.
const accountId = "a".repeat(32);
const headSha = "b".repeat(40);
const fixture = (
  environment: "production" | "staging" = "production",
  destinationAccount = accountId
) => {
  const staging = environment === "staging";
  const workerName = staging
    ? "vertex-research-web-staging"
    : "vertex-research-web";
  const origin = staging
    ? "https://staging.vertex.xyz"
    : "https://app.vertex.xyz";
  const selected = {
    name: workerName,
    account_id: destinationAccount,
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
  const config: Record<string, unknown> = staging
    ? { env: { staging: selected } }
    : selected;
  return {
    environment,
    headSha,
    config,
    verification: {
      version: 1,
      environment,
      accountFingerprint: createHash("sha256")
        .update(destinationAccount)
        .digest("hex"),
      workerName,
      origin,
      exactSha: headSha,
      approvedBy: "synthetic-operator",
      accountVerified: true,
      domainVerified: true,
      cutoverApproved: true,
    },
  };
};

const selectedConfig = (
  request: ReturnType<typeof fixture>
): Record<string, unknown> => {
  if (request.environment === "staging") {
    return (request.config["env"] as { staging: Record<string, unknown> })
      .staging;
  }
  return request.config;
};

const blocked = (request: unknown) => {
  return expect(checkWebDeploymentDestination(request)).toMatchObject({
    ok: false,
    status: "blocked",
  });
};

describe("isolated web deployment destinations", () => {
  it.each(["production", "staging"] as const)(
    "accepts only an explicit verified isolated %s destination",
    (environment) => {
      return expect(
        checkWebDeploymentDestination(fixture(environment))
      ).toEqual({
        ok: true,
        status: "verified",
        message:
          "Isolated web destination matches the explicit operator verification; deployment policy gates remain required",
      });
    }
  );

  it("blocks the unbound checkout for both environments", async () => {
    const config = parseWranglerConfiguration(
      await readFile(
        new URL("../../apps/web/wrangler.jsonc", import.meta.url),
        "utf8"
      )
    );
    for (const environment of ["production", "staging"] as const) {
      blocked({ ...fixture(environment), config });
    }
  });

  it("parses commented JSONC and rejects malformed configuration", () => {
    expect(
      parseWranglerConfiguration('{\n  // comment\n  "name": "web",\n}')
    ).toEqual({ name: "web" });
    expect(() => parseWranglerConfiguration('{ "name": ')).toThrow(
      "Invalid wrangler.jsonc"
    );
  });

  it.each([undefined, null, [], {}, { environment: "preview" }])(
    "blocks missing or malformed destination input %#",
    (request) => {
      return blocked(request);
    }
  );

  it.each([undefined, null, [], {}, "verified"])(
    "blocks missing or malformed verification %#",
    (verification) => {
      return blocked({ ...fixture(), verification });
    }
  );

  it.each([undefined, null, [], {}, "config"])(
    "blocks missing or malformed selected config %#",
    (config) => {
      blocked({ ...fixture(), config });
      return blocked({
        ...fixture("staging"),
        config: { env: { staging: config } },
      });
    }
  );

  it("never inherits a production account or target into staging", () => {
    const request = fixture("staging");
    const selected = selectedConfig(request);
    delete selected["account_id"];
    blocked({
      ...request,
      config: { account_id: accountId, env: { staging: selected } },
    });
    blocked({ ...request, config: { env: null } });
    return blocked({ ...request, config: { env: [] } });
  });

  it.each([
    "darkfactory-web",
    "darkfactory-web-staging",
    "vertex",
    "vertex-research-web-staging",
  ])("blocks inherited or wrong production worker %s", (name) => {
    const request = fixture();
    selectedConfig(request)["name"] = name;
    request.verification.workerName = name;
    return blocked(request);
  });

  it.each([
    "darkfactory.example.test",
    "staging.darkfactory.example.test",
    "vertex.xyz",
    "*.vertex.xyz",
    "app.vertex.xyz/*",
    "app.vertex.xyz.evil.test",
  ])("blocks old, apex, wildcard, and foreign routes %s", (pattern) => {
    const request = fixture();
    selectedConfig(request)["routes"] = [{ pattern, custom_domain: true }];
    return blocked(request);
  });

  it.each(
    [
      undefined,
      [],
      ["app.vertex.xyz"],
      [{ pattern: "app.vertex.xyz" }],
      [{ pattern: "app.vertex.xyz", custom_domain: false }],
      [
        {
          pattern: "app.vertex.xyz",
          custom_domain: true,
          zone_id: "unexpected",
        },
      ],
      [
        { pattern: "app.vertex.xyz", custom_domain: true },
        { pattern: "vertex.xyz", custom_domain: true },
      ],
    ].map((routes) => ({ routes }))
  )("blocks absent, implicit, or extra delivery routes %#", ({ routes }) => {
    const request = fixture();
    selectedConfig(request)["routes"] = routes;
    return blocked(request);
  });

  it.each([undefined, "", "placeholder", "A".repeat(32), "a".repeat(31)])(
    "blocks missing or malformed accounts %#",
    (account) => {
      const request = fixture();
      selectedConfig(request)["account_id"] = account;
      return blocked(request);
    }
  );

  it.each(["production", "staging"] as const)(
    "allows deliberate existing-account reuse for an explicitly approved isolated %s target",
    (environment) => {
      const existingAccount = "d".repeat(32);
      const request = fixture(environment, existingAccount);
      expect(checkWebDeploymentDestination(request)).toMatchObject({
        ok: true,
        status: "verified",
      });
      return expect(
        checkWebDeploymentDestination(request, {
          CLOUDFLARE_ACCOUNT_ID: existingAccount,
          CF_ACCOUNT_ID: existingAccount,
        })
      ).toMatchObject({ ok: true });
    }
  );

  it("allows the same account in both environments only with separate explicit target approvals", () => {
    const production = fixture();
    const staging = fixture("staging");
    const config = { ...production.config, ...staging.config };
    expect(
      checkWebDeploymentDestination({ ...production, config })
    ).toMatchObject({ ok: true });
    expect(checkWebDeploymentDestination({ ...staging, config })).toMatchObject(
      { ok: true }
    );
    blocked({ ...staging, config, verification: production.verification });
    return blocked({
      ...production,
      config,
      verification: staging.verification,
    });
  });

  it.each(["production", "staging"] as const)(
    "blocks copied %s account selection without rebinding operator evidence",
    (environment) => {
      const request = fixture(environment);
      selectedConfig(request)["account_id"] = "d".repeat(32);
      return blocked(request);
    }
  );

  it.each([
    "accountVerified",
    "domainVerified",
    "cutoverApproved",
    "approvedBy",
  ] as const)(
    "requires explicit %s evidence even when reusing an existing account",
    (key) => {
      const request = fixture("production", "d".repeat(32));
      return blocked({
        ...request,
        verification: { ...request.verification, [key]: undefined },
      });
    }
  );

  it.each(["workers_dev", "preview_urls"])(
    "blocks missing or enabled %s",
    (key) => {
      for (const value of [undefined, true]) {
        const request = fixture();
        selectedConfig(request)[key] = value;
        blocked(request);
      }
    }
  );

  it.each([undefined, [], {}, { APP_ENV: "development" }])(
    "blocks missing or invalid runtime vars %#",
    (vars) => {
      const request = fixture();
      selectedConfig(request)["vars"] = vars;
      return blocked(request);
    }
  );

  it.each([
    ["APP_URL", "https://vertex.xyz"],
    ["BETTER_AUTH_URL", "https://darkfactory.example.test"],
    ["EMAIL_PROVIDER", "resend"],
    ["EMAIL_TRANSPORT", "resend"],
    ["EMAIL_FROM", "sender@old.example.test"],
    ["RESEND_API_KEY", "synthetic-not-a-key"],
  ])("blocks origin or delivery drift in %s", (key, value) => {
    const request = fixture();
    const selected = selectedConfig(request);
    selected["vars"] = {
      ...(selected["vars"] as Record<string, unknown>),
      [key]: value,
    };
    return blocked(request);
  });

  it.each([
    ["version", 2],
    ["environment", "staging"],
    ["accountFingerprint", "c".repeat(64)],
    ["workerName", "darkfactory-web"],
    ["origin", "https://vertex.xyz"],
    ["exactSha", "c".repeat(40)],
    ["approvedBy", ""],
    ["approvedBy", "   "],
    ["accountVerified", false],
    ["domainVerified", false],
    ["cutoverApproved", false],
  ])("blocks absent or mismatched operator evidence %s", (key, value) => {
    const request = fixture();
    return blocked({
      ...request,
      verification: { ...request.verification, [key]: value },
    });
  });

  it.each([undefined, "", "main", "b".repeat(39), "B".repeat(40)])(
    "blocks a non-exact current SHA %#",
    (sha) => {
      return blocked({ ...fixture(), headSha: sha });
    }
  );

  it("rejects ambient destination overrides without exposing their values", () => {
    for (const key of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CF_ACCOUNT_ID",
      "CLOUDFLARE_ENV",
      "WRANGLER_ENV",
      "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
      "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT",
      "CLOUDFLARE_VITE_BUILD",
      "WRANGLER_CI_OVERRIDE_NAME",
    ]) {
      const report = checkWebDeploymentDestination(fixture(), {
        [key]: "private-override",
      });
      expect(report).toMatchObject({ ok: false, status: "blocked" });
      expect(report.message).not.toContain("private-override");
    }
    return expect(
      checkWebDeploymentDestination(fixture(), {
        CLOUDFLARE_ACCOUNT_ID: accountId,
      })
    ).toMatchObject({ ok: true });
  });

  it("does not reflect private malformed input into diagnostics", () => {
    const report = checkWebDeploymentDestination({
      ...fixture(),
      verification: { approvedBy: "private-value" },
    });
    expect(JSON.stringify(report)).not.toContain("private-value");
    return expect(JSON.stringify(report)).not.toContain(accountId);
  });

  return it.each(["production", "staging"] as const)(
    "rejects unsupported %s selectors even when empty or apparently matching",
    (environment) => {
      for (const key of [
        "CLOUDFLARE_ENV",
        "WRANGLER_ENV",
        "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
        "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT",
        "CLOUDFLARE_VITE_BUILD",
        "WRANGLER_CI_OVERRIDE_NAME",
      ]) {
        for (const value of ["", environment, "wrangler.jsonc", "false"]) {
          expect(
            checkWebDeploymentDestination(fixture(environment), {
              [key]: value,
            })
          ).toMatchObject({ ok: false });
        }
      }
      return expect(
        checkWebDeploymentDestination(fixture(environment), {
          CLOUDFLARE_ENV: undefined,
        })
      ).toMatchObject({ ok: true });
    }
  );
});
