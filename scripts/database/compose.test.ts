import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL } from "../lib/test-env.ts";
import { LOCAL_DATABASE_URL } from "../setup/setup.ts";

const execFileAsync = promisify(execFile);
const readYaml = async (path: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    "bun",
    [
      "-e",
      "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))",
      fileURLToPath(new URL(path, import.meta.url)),
    ],
    { maxBuffer: 1024 * 1024, timeout: 10_000 }
  );
  return JSON.parse(stdout);
};

interface Compose {
  configs: Record<string, { content: string }>;
  name: string;
  services: Record<
    string,
    {
      image: string;
      ports: string[];
      tmpfs: string[];
      volumes?: unknown;
      container_name?: unknown;
      environment: Record<string, string>;
      configs: { source: string; target: string }[];
    }
  >;
  volumes?: unknown;
}
interface Workflow {
  jobs: {
    verification: {
      env: Record<string, string>;
      strategy: { matrix: { lane: string[] } };
      steps: { name: string; run?: string }[];
    };
  };
}
const [compose, workflow] = (await Promise.all([
  readYaml("../../infra/docker/postgres.compose.yml"),
  readYaml("../../.github/workflows/ci.yml"),
])) as [Compose, Workflow];
const rootPackage = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8")
) as { scripts: Record<string, string> };

// Inspect deployable configuration, never run Docker or open a database.
describe("disposable Vertex PostgreSQL configuration", () => {
  it("isolates the project, loopback listener and disposable storage from inherited projects", () => {
    expect(compose.name).toBe("vertex-research-platform");
    expect(Object.keys(compose.services)).toEqual(["postgres"]);
    const postgres = compose.services["postgres"]!;
    expect(postgres.ports).toEqual([
      "127.0.0.1:${VERTEX_POSTGRES_PORT:-55582}:5432",
    ]);
    expect(postgres.tmpfs).toEqual(["/var/lib/postgresql/data"]);
    expect(postgres.volumes).toBeUndefined();
    expect(postgres.container_name).toBeUndefined();
    expect(compose.volumes).toBeUndefined();
    return expect(postgres.image).toBe(
      "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
    );
  });

  it("pins lifecycle commands against ambient Compose project and env-file settings", () => {
    const base =
      "docker compose --project-name vertex-research-platform --env-file /dev/null -f infra/docker/postgres.compose.yml";
    expect(rootPackage.scripts["db:test:up"]).toBe(
      `${base} up --detach --wait`
    );
    expect(rootPackage.scripts["db:test:down"]).toBe(
      `${base} down --volumes --remove-orphans`
    );
    const steps = workflow.jobs.verification.steps;
    expect(
      steps.find((step) => step.name === "Start PostgreSQL integration service")
        ?.run
    ).toBe("bash scripts/ci/rig-postgres.sh up");
    return expect(
      steps.find((step) => step.name === "Stop PostgreSQL integration service")
        ?.run
    ).toBe("bash scripts/ci/rig-postgres.sh down");
  });

  return it("uses CI-only loopback ports and the same maintenance identity across every CI lane", () => {
    const verification = workflow.jobs.verification;
    const portStep =
      verification.steps.find((step) => step.name === "Choose PostgreSQL port")
        ?.run ?? "";
    // Each runner and lane gets its own port at or above 61682, set through GITHUB_ENV.
    // That is above the Linux ephemeral range (32768-60999), so an outgoing
    // connection never holds the port as its local port.
    expect(portStep).toContain("port=$((61682 + 10 * runner + lane))");
    // A port held by another process (for example an agent's local compose
    // database) moves the lane up by 100 instead of failing the lane.
    expect(portStep).toContain(
      '[[ -z "$(ss -Hltn "sport = :${port}")" ]] && break'
    );
    expect(portStep).toContain("port=$((port + 100))");
    expect(portStep).toContain('echo "DATABASE_URL=${url}"');
    expect(portStep).toContain('echo "TEST_DATABASE_URL=${url}"');
    expect(verification.env["DATABASE_URL"]).toBeUndefined();
    const template = /url="([^"]+)"/.exec(portStep)?.[1] ?? "";
    const url = new URL(template.replace("${port}", "61682"));
    expect(url.protocol).toBe("postgresql:");
    expect(url.hostname).toBe("127.0.0.1");
    // Local runs use the compose listener on 55582, never a CI port or the default 5432.
    for (const local of [DEFAULT_TEST_DATABASE_URL, LOCAL_DATABASE_URL]) {
      expect(new URL(local).port).toBe("55582");
    }
    expect(url.username).toBe("darkfactory_test_runner");
    expect(url.pathname).toBe("/darkfactory_test_maintenance");
    // The coverage lane is a separate job; it merges shard reports and uses no database.
    expect(verification.strategy.matrix.lane).toEqual([
      "core",
      "integration",
      "browser",
    ]);
    return expect(
      compose.services["postgres"]!.environment["POSTGRES_DB"]
    ).toBe(url.pathname.slice(1));
  });
});
