import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { capabilityManifestSchema } from "./capabilities.ts";
import {
  CapabilityManifestValidationError,
  loadCapabilityManifest,
} from "./server/capabilities-loader.ts";

const manifestUrl = new URL("../../../capabilities.yaml", import.meta.url);
const readManifest = async (): Promise<string> =>
  await readFile(manifestUrl, "utf8");
// The product brand is not template identity, so `bun run init` rewrites
// project.name in capabilities.yaml alone; read the name the manifest carries.
const projectName = (() => {
  const match = /^project:\n(?:[ \t]+.*\n)*?[ \t]+name: (.+)$/mu.exec(
    readFileSync(manifestUrl, "utf8")
  );
  if (match?.[1] === undefined)
    throw new Error("capabilities.yaml has no project.name");
  return match[1];
})();

const captureManifestError = (
  source: string
): CapabilityManifestValidationError => {
  try {
    loadCapabilityManifest(source);
  } catch (error) {
    if (error instanceof CapabilityManifestValidationError) return error;
    throw error;
  }
  throw new Error("expected manifest validation to fail");
};

const expectedManifest = {
  project: {
    name: projectName,
    slug: "darkfactory",
    version: "0.3.1",
    framework_api: "next-app-router",
    framework_implementation: "vinext",
    build_tool: "vite",
    language: "typescript",
    runtime: "cloudflare-workers",
  },
  workspace: {
    package_manager: "pnpm",
    script_runtime: "bun",
    orchestration: "turborepo",
  },
  deployment: {
    web: { provider: "cloudflare", deployer: "@vinext/cloudflare" },
    ancillary_resources: {
      provider: "cloudflare",
      infrastructure: "alchemy",
      enabled: false,
    },
  },
  database: {
    engine: "postgres",
    orm: "drizzle",
    provider: "postgres",
    extensions_first: true,
  },
  api: { provider: "orpc", style: "contract-first", openapi: true },
  auth: { provider: "better-auth" },
  ui: {
    styling: "tailwind",
    components: "shadcn",
    typography: "sans-serif",
    public_reference: "https://www.squarespace.com/",
    portal_reference: "https://ui.shadcn.com/blocks",
  },
  ai: { provider: "groq" },
  email: { provider: "resend", local_transport: "preview" },
  analytics: { provider: "posthog", adapter_required: true },
  telemetry: { provider: "opentelemetry" },
  logging: { provider: "evlog" },
  quality: {
    formatter_linter: "ultracite",
    git_hooks: "husky",
    unit_tests: "vitest",
    browser_tests: "playwright",
  },
  developer_context: { code_graph: { provider: "graphify", enabled: true } },
  examples: {
    feature_stub: { enabled: true, removable: true, generator_source: true },
  },
  development: {
    https: {
      enabled: true,
      provider: "portless",
      service_name: "darkfactory",
      canonical_url: "https://darkfactory.localhost",
      certificate_fallback: "mkcert",
      fallback_hostnames: ["localhost", "*.localhost", "127.0.0.1", "::1"],
    },
    seeded_accounts: {
      enabled: true,
      production_allowed: false,
      users: ["admin", "alice", "bob"],
    },
  },
  state: { workflows: "xstate", client_local: "zustand" },
  integrations: {
    native_quant: {
      provider: "nautilus-trader",
      enabled: false,
      runtime_state: "disabled",
    },
    research: {
      provider: "gamma-agno",
      enabled: false,
      runtime_state: "disabled",
    },
    rust_kernel: {
      provider: "gamma-rust",
      enabled: false,
      runtime_state: "disabled",
    },
    market_data: {
      provider: "quantdata-financialdatasets",
      enabled: false,
      runtime_state: "disabled",
    },
    charts: {
      provider: "tanstack-charts-alpha",
      enabled: false,
      runtime_state: "disabled",
    },
    notifications: {
      provider: "ntfy-resend",
      enabled: false,
      runtime_state: "disabled",
    },
    browser_watch: {
      provider: "jev",
      enabled: false,
      runtime_state: "disabled",
    },
  },
} as const;

describe("capability manifest", () => {
  it("loads the exact provider and capability contract", async () => {
    return expect(loadCapabilityManifest(await readManifest())).toEqual(
      expectedManifest
    );
  });

  it("parses a renamed project with its own identity", async () => {
    const source = (await readManifest())
      .replace(`name: ${projectName}`, "name: Acme Widgets")
      .replace("slug: darkfactory", "slug: acme-widgets")
      .replace("version: 0.3.1", "version: 1.0.0-rc.1+build.7")
      .replace("service_name: darkfactory", "service_name: acme-widgets")
      .replace(
        "canonical_url: https://darkfactory.localhost",
        "canonical_url: https://acme-widgets.localhost"
      )
      .replace(
        "provider: postgres\n  extensions_first",
        "provider: planetscale\n  extensions_first"
      );

    return expect(loadCapabilityManifest(source)).toMatchObject({
      project: {
        name: "Acme Widgets",
        slug: "acme-widgets",
        version: "1.0.0-rc.1+build.7",
      },
      database: { provider: "planetscale" },
      development: {
        https: { canonical_url: "https://acme-widgets.localhost" },
      },
    });
  });

  it.each([
    ["slug", "slug: darkfactory", "slug: Dark-Factory", "project.slug"],
    ["version", "version: 0.3.1", "version: v0.2", "project.version"],
    [
      "canonical URL",
      "canonical_url: https://darkfactory.localhost",
      "canonical_url: http://darkfactory.localhost",
      "development.https.canonical_url",
    ],
  ])(
    "rejects a malformed %s without reflecting it",
    async (_label, valid, invalid, path) => {
      const error = captureManifestError(
        (await readManifest()).replace(valid, invalid)
      );

      expect(error.issues).toEqual([
        {
          code: "invalid_manifest",
          path,
          message: "Manifest value is invalid",
        },
      ]);
      return expect(JSON.stringify(error)).not.toContain(
        invalid.split(": ")[1]
      );
    }
  );

  it("contains no superseded providers or capabilities", async () => {
    const source = await readManifest();
    return expect(source).not.toMatch(/redis|rabbitmq|sst|payments|leads/i);
  });

  it.each([
    [
      "unknown root key",
      (source: string) => `${source}\nunexpected: true\n`,
      "manifest",
    ],
    [
      "unknown nested key",
      (source: string) =>
        source.replace("  orm: drizzle", "  orm: drizzle\n  token: hidden"),
      "database",
    ],
    [
      "unsupported provider",
      (source: string) =>
        source.replace("provider: better-auth", "provider: another-auth"),
      "auth.provider",
    ],
    [
      "unsupported script runtime",
      (source: string) =>
        source.replace("script_runtime: bun", "script_runtime: node"),
      "workspace.script_runtime",
    ],
    [
      "missing script runtime",
      (source: string) => source.replace("  script_runtime: bun\n", ""),
      "workspace.script_runtime",
    ],
    [
      "missing required field",
      (source: string) => source.replace("  orm: drizzle\n", ""),
      "database.orm",
    ],
  ])("rejects $0", async (_label, mutate, expectedPath) => {
    const invalidManifest = mutate(await readManifest());
    expect(() => loadCapabilityManifest(invalidManifest)).toThrow(
      CapabilityManifestValidationError
    );
    try {
      loadCapabilityManifest(invalidManifest);
    } catch (error) {
      const hasExpectedPath = (
        error as CapabilityManifestValidationError
      ).issues.some(({ path }) => path.startsWith(expectedPath));
      expect(hasExpectedPath).toBe(true);
    }
  });

  it("rejects duplicate YAML mapping keys", async () => {
    const source = (await readManifest()).replace(
      `  name: ${projectName}`,
      `  name: ${projectName}\n  name: Duplicate`
    );
    return expect(() => loadCapabilityManifest(source)).toThrow(
      CapabilityManifestValidationError
    );
  });

  it.each(["disabled", "unknown", "incompatible"])(
    "preserves non-operational integration runtime state %s",
    async (runtimeState) => {
      const source = (await readManifest()).replaceAll(
        "runtime_state: disabled",
        `runtime_state: ${runtimeState}`
      );
      const manifest = loadCapabilityManifest(source);
      expect(manifest.integrations.native_quant.runtime_state).toBe(
        runtimeState
      );
      return expect(manifest.integrations.browser_watch.enabled).toBe(false);
    }
  );

  it.each([
    [
      "a runtime readiness claim",
      (source: string) =>
        source.replace("runtime_state: disabled", "runtime_state: ready"),
      "integrations.native_quant.runtime_state",
    ],
    [
      "an unreviewed activation",
      (source: string) =>
        source.replace(
          "provider: nautilus-trader\n    enabled: false",
          "provider: nautilus-trader\n    enabled: true"
        ),
      "integrations.native_quant.enabled",
    ],
    [
      "an unknown integration field",
      (source: string) =>
        source.replace(
          "provider: nautilus-trader",
          "provider: nautilus-trader\n    secret: private"
        ),
      "integrations.native_quant",
    ],
    [
      "a swapped integration provider",
      (source: string) =>
        source.replace("provider: jev", "provider: another-watcher"),
      "integrations.browser_watch.provider",
    ],
    [
      "a missing integration",
      (source: string) =>
        source.replace(
          "  browser_watch:\n    provider: jev\n    enabled: false\n    runtime_state: disabled\n",
          ""
        ),
      "integrations.browser_watch",
    ],
  ])("rejects %s", async (_label, mutate, expectedPath) => {
    const source = await readManifest();
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);
    const error = captureManifestError(mutated);
    expect(error.issues.some(({ path }) => path.startsWith(expectedPath))).toBe(
      true
    );
    return expect(JSON.stringify(error)).not.toContain("private");
  });

  it("rejects non-JSON mapping keys before conversion", () => {
    const error = captureManifestError("? [nested, key]\n: true\n");
    return expect(error.issues).toEqual([
      {
        code: "invalid_yaml",
        path: "yaml",
        message: "Manifest must contain valid, unique-key YAML",
      },
    ]);
  });

  it.each(["1", "true"])("rejects the non-string scalar key %s", (key) => {
    const error = captureManifestError(`${key}: value\n`);
    return expect(error.issues).toEqual([
      {
        code: "invalid_yaml",
        path: "yaml",
        message: "Manifest must contain valid, unique-key YAML",
      },
    ]);
  });

  it("rejects aliases before conversion", () => {
    const error = captureManifestError(
      "first: &shared { value: true }\nsecond: *shared\n"
    );
    return expect(error.issues).toEqual([
      {
        code: "invalid_yaml",
        path: "yaml",
        message: "Manifest must contain valid, unique-key YAML",
      },
    ]);
  });

  it.each(["__proto__", "constructor"])(
    "rejects the %s key without prototype pollution",
    (key) => {
      const error = captureManifestError(`${key}:\n  polluted: true\n`);
      expect(error.issues.every(({ message }) => !message.includes(key))).toBe(
        true
      );
      return expect(
        ({} as Record<string, unknown>)["polluted"]
      ).toBeUndefined();
    }
  );

  it.each([
    ["oversized whitespace", async () => " ".repeat(32_769)],
    [
      "UTF-8 byte size",
      async () => `${await readManifest()}\n# ${"é".repeat(17_000)}\n`,
    ],
    [
      "structural depth",
      async () => {
        return `${Array.from(
          { length: 40 },
          (_, index) => `${"  ".repeat(index)}level_${index}:\n`
        ).join("")}${"  ".repeat(40)}value: true\n`;
      },
    ],
    [
      "node count",
      async () => {
        return `items:\n${Array.from(
          { length: 600 },
          (_, index) => `  - item-${index}\n`
        ).join("")}`;
      },
    ],
    ["key length", async () => `${"k".repeat(300)}: true\n`],
    ["string length", async () => `extra: "${"x".repeat(5000)}"\n`],
  ])(
    "rejects YAML exceeding the $0 budget before conversion",
    async (_label, source) => {
      const error = captureManifestError(await source());
      expect(error.issues).toEqual([
        {
          code: "resource_limit",
          path: "yaml",
          message: "Manifest exceeds safe parsing limits",
        },
      ]);
    }
  );

  it("uses stable errors without reflecting attacker-controlled keys", async () => {
    const attackerKey = "SECRET-AS-KEY";
    const error = captureManifestError(
      `${await readManifest()}\n${attackerKey}: true\n`
    );
    const serialized = JSON.stringify(error);

    expect(error.issues).toEqual([
      {
        code: "unknown_key",
        path: "manifest",
        message: "Manifest contains an unknown key",
      },
    ]);
    expect(String(error)).not.toContain(attackerKey);
    return expect(serialized).not.toContain(attackerKey);
  });

  it("never reflects manifest values in validation errors", async () => {
    const secret = "provider-secret-value-that-must-not-leak";
    const source = (await readManifest()).replace(
      "    public: false",
      `    public: false\n    access_token: ${secret}`
    );

    try {
      loadCapabilityManifest(source);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      return expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("sanitizes an untrusted schema issue path before returning it", () => {
    const privatePath = "PRIVATE-SCHEMA-PATH";
    const privateValue = "private-schema-failure-detail";
    const validation = vi
      .spyOn(capabilityManifestSchema, "safeParse")
      .mockReturnValue({
        success: false,
        error: {
          issues: [
            {
              code: "invalid_type",
              path: [privatePath],
              message: privateValue,
            },
          ],
        },
      } as never);
    let failure: unknown;
    try {
      failure = captureManifestError("safe: true\n");
    } finally {
      validation.mockRestore();
    }

    expect(failure).toMatchObject({
      issues: [
        {
          code: "missing_requirement",
          path: "manifest",
          message: "Required manifest value is missing",
        },
      ],
    });
    expect(String(failure)).not.toContain(privatePath);
    expect(String(failure)).not.toContain(privateValue);
    expect(JSON.stringify(failure)).not.toContain(privatePath);
    return expect(JSON.stringify(failure)).not.toContain(privateValue);
  });

  it("rejects non-string and empty manifest sources with one stable issue", () => {
    for (const source of [null as never, "   "]) {
      expect(captureManifestError(source).issues).toEqual([
        {
          code: "invalid_yaml",
          path: "yaml",
          message: "Manifest must contain valid, unique-key YAML",
        },
      ]);
    }
  });

  it.each([
    ["multi-byte key", `${"é".repeat(65)}: true\n`],
    ["multi-byte string", `extra: "${"é".repeat(2049)}"\n`],
  ])("enforces the UTF-8 byte budget for a $0", (_label, source) =>
    expect(captureManifestError(source).issues).toEqual([
      {
        code: "resource_limit",
        path: "yaml",
        message: "Manifest exceeds safe parsing limits",
      },
    ])
  );

  it("rejects non-finite YAML scalars before schema validation", () =>
    expect(captureManifestError("value: .inf\n").issues).toEqual([
      {
        code: "invalid_yaml",
        path: "yaml",
        message: "Manifest must contain valid, unique-key YAML",
      },
    ]));

  it.each([
    [
      "array",
      "  provider:\n    - provider-secret-value",
      "provider-secret-value",
    ],
    ["number", "  provider: 982451653", "982451653"],
  ])(
    "classifies a wrong-type $0 without reflecting it",
    async (_label, replacement, secretValue) => {
      const source = (await readManifest()).replace(
        "  provider: better-auth",
        replacement
      );
      const error = captureManifestError(source);

      expect(error.issues).toContainEqual({
        code: "invalid_type",
        path: "auth.provider",
        message: "Manifest value has an invalid type",
      });
      return expect(JSON.stringify(error)).not.toContain(secretValue);
    }
  );

  it("classifies a null literal value as an invalid type", async () => {
    const source = (await readManifest()).replace(
      "  provider: better-auth",
      "  provider:"
    );

    return expect(captureManifestError(source).issues).toContainEqual({
      code: "invalid_type",
      path: "auth.provider",
      message: "Manifest value has an invalid type",
    });
  });

  it.each([
    [
      "string",
      "  script_runtime: bun",
      "  script_runtime: unsupported-runtime",
      "workspace.script_runtime",
      "unsupported-runtime",
    ],
    [
      "boolean",
      "    production_allowed: false",
      "    production_allowed: true",
      "development.seeded_accounts.production_allowed",
      "true",
    ],
  ])(
    "classifies an unsupported same-type $0 without reflecting it",
    async (_label, supported, unsupported, path, secretValue) => {
      const source = (await readManifest()).replace(supported, unsupported);
      const error = captureManifestError(source);

      expect(error.issues).toContainEqual({
        code: "unsupported_value",
        path,
        message: "Manifest value is not supported",
      });
      return expect(JSON.stringify(error)).not.toContain(secretValue);
    }
  );

  it("uses the generic classification for array cardinality failures", async () => {
    const source = (await readManifest()).replace(
      'fallback_hostnames: [localhost, "*.localhost", 127.0.0.1, "::1"]',
      "fallback_hostnames: []"
    );
    const error = captureManifestError(source);

    return expect(error.issues).toContainEqual({
      code: "invalid_manifest",
      path: "development.https.fallback_hostnames",
      message: "Manifest value is invalid",
    });
  });

  it("preserves allowlisted array indexes while sanitizing schema paths", async () => {
    const source = (await readManifest()).replace(
      "users: [admin, alice, bob]",
      "users: [admin, alice, Mallory]"
    );

    return expect(captureManifestError(source).issues).toContainEqual({
      code: "invalid_manifest",
      path: "development.seeded_accounts.users.2",
      message: "Manifest value is invalid",
    });
  });

  it("accepts null scalar structure before reporting the schema contract", () => {
    const error = captureManifestError("value:\n");
    expect(error).toBeInstanceOf(CapabilityManifestValidationError);
    return expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects a comments-only manifest without reflecting its contents", () => {
    const privateComment = "private-comment-content";
    const error = captureManifestError(`# ${privateComment}\n`);

    expect(error.issues).toEqual([
      {
        code: "invalid_type",
        path: "manifest",
        message: "Manifest value has an invalid type",
      },
    ]);
    expect(String(error)).not.toContain(privateComment);
    return expect(JSON.stringify(error)).not.toContain(privateComment);
  });

  it("treats unresolved YAML tag warnings as invalid input", () =>
    expect(captureManifestError("value: !untrusted tagged\n").issues).toEqual([
      {
        code: "invalid_yaml",
        path: "yaml",
        message: "Manifest must contain valid, unique-key YAML",
      },
    ]));

  it.each([
    ["an empty document", "---\n"],
    ["a finite numeric scalar", "value: 1\n"],
  ])(
    "accepts safe YAML structure for $0 before schema rejection",
    (_case, source) => {
      const error = captureManifestError(source);
      expect(error).toBeInstanceOf(CapabilityManifestValidationError);
      return expect(error.issues.length).toBeGreaterThan(0);
    }
  );

  it("rejects an unknown parser node without reflecting its properties", async () => {
    const privateDetail = "private-parser-node-detail";
    vi.doUnmock("yaml");
    vi.resetModules();
    vi.doMock("yaml", async (importOriginal) => {
      const actual = await importOriginal<typeof import("yaml")>();
      return {
        ...actual,
        parseDocument() {
          return {
            errors: [],
            warnings: [],
            contents: { privateDetail },
            toJS() {
              return {};
            },
          };
        },
      };
    });
    let failure: unknown;
    try {
      const isolated = await import("./server/capabilities-loader.ts");
      try {
        isolated.loadCapabilityManifest("project: {}\n");
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock("yaml");
      vi.resetModules();
    }

    expect(failure).toMatchObject({
      name: "CapabilityManifestValidationError",
      issues: [
        {
          code: "invalid_yaml",
          path: "yaml",
          message: "Manifest must contain valid, unique-key YAML",
        },
      ],
    });
    expect(String(failure)).not.toContain(privateDetail);
    return expect(JSON.stringify(failure)).not.toContain(privateDetail);
  });

  it("sanitizes an unexpected YAML parser failure", async () => {
    const privateDetail = "private-parser-failure-detail";
    vi.doUnmock("yaml");
    vi.resetModules();
    vi.doMock("yaml", async (importOriginal) => {
      const actual = await importOriginal<typeof import("yaml")>();
      return {
        ...actual,
        parseDocument() {
          throw new Error(privateDetail);
        },
      };
    });
    let failure: unknown;
    try {
      const isolated = await import("./server/capabilities-loader.ts");
      try {
        isolated.loadCapabilityManifest("project: {}\n");
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock("yaml");
      vi.resetModules();
    }

    expect(failure).toMatchObject({
      name: "CapabilityManifestValidationError",
      issues: [
        {
          code: "invalid_yaml",
          path: "yaml",
          message: "Manifest must contain valid, unique-key YAML",
        },
      ],
    });
    expect(String(failure)).not.toContain(privateDetail);
    return expect(JSON.stringify(failure)).not.toContain(privateDetail);
  });
});
