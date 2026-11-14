import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Durable security and structure invariants for every GitHub workflow. Keep
// this file free of step text, versions and shell snippets: those are free to
// change without weakening the pipeline.

interface Step {
  env?: Record<string, unknown>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  steps?: Step[];
  strategy?: { matrix?: Record<string, unknown> };
  uses?: string;
  "runs-on"?: unknown;
}
interface Workflow {
  jobs: Record<string, Job>;
  on: unknown;
  permissions?: unknown;
}

const directory = new URL("../../.github/workflows/", import.meta.url);
const workflows = await Promise.all(
  (await readdir(directory))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map(async (file) => {
      const text = await readFile(new URL(file, directory), "utf8");
      return { file, text, workflow: parse(text) as Workflow };
    })
);
const jobs = workflows.flatMap(({ file, workflow }) => {
  return Object.entries(workflow.jobs).map(([id, job]) => ({ file, id, job }));
});
const steps = jobs.flatMap(({ file, id, job }) => {
  return (job.steps ?? []).map((step) => ({ file, id, step }));
});
const triggers = (on: unknown): string[] => {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on as Record<string, unknown>);
};

describe("GitHub workflow invariants", () => {
  it("finds the workflow set", () => {
    return expect(workflows.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "ci.yml",
        "codeql.yml",
        "dependency-review.yml",
        "scorecard.yml",
      ])
    );
  });

  it("pins every action to a full commit SHA with a version comment", () => {
    const parsedUses = [
      ...jobs.flatMap(({ job }) => job.uses ?? []),
      ...steps.flatMap(({ step }) => step.uses ?? []),
    ];
    const lines = workflows.flatMap(({ file, text }) => {
      return text
        .split("\n")
        .filter((line) => /^\s*(?:-\s+)?uses:/.test(line))
        .map((line) => ({ file, line: line.trim() }));
    });
    expect(lines).toHaveLength(parsedUses.length);
    expect(parsedUses.length).toBeGreaterThan(0);
    for (const { file, line } of lines) {
      expect(line, file).toMatch(
        /^(?:-\s+)?uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d[\w.-]*$/
      );
    }
  });

  it("never triggers on pull_request_target", () => {
    for (const { file, workflow } of workflows) {
      expect(triggers(workflow.on), file).not.toContain("pull_request_target");
    }
  });

  // Bundled Playwright Chromium lags Chrome stable security fixes (card
  // sec-pw-ci-vertex-research-platform, 2026-11-03). Browser jobs use the
  // runner's Google Chrome through the "chrome" channel.
  it("never installs Playwright's bundled Chromium", () => {
    for (const { file, id, step } of steps) {
      expect(step.run ?? "", `${file} ${id}`).not.toMatch(
        /playwright\s+install\b[^\n]*\bchromium/u
      );
    }
  });

  // Vertex development and CI moved to the public repository (owner 2026-11-04,
  // card vertex-ci-github-hosted). A public repository lets fork pull requests start
  // workflows, so no job may use a self-hosted runner: every job runs on a
  // GitHub-hosted runner, which is free for public repositories.
  it("runs every job on GitHub-hosted runners", () => {
    expect(jobs.length).toBeGreaterThan(0);
    for (const { file, id, job } of jobs) {
      const runsOn = JSON.stringify(job["runs-on"] ?? "");
      expect(runsOn, `${file}:${id}`).not.toMatch(/self-hosted|rig/u);
    }
  });

  it("defaults every workflow token to no or read-only permissions", () => {
    for (const { file, workflow } of workflows) {
      const permissions = workflow.permissions;
      if (permissions === "read-all") continue;
      expect(permissions, file).toBeTypeOf("object");
      expect(permissions, file).not.toBeNull();
      for (const scope of Object.values(
        permissions as Record<string, unknown>
      )) {
        expect(["read", "none"], file).toContain(scope);
      }
    }
  });

  it("never persists checkout credentials", () => {
    const checkouts = steps.filter(({ step }) => {
      return step.uses?.startsWith("actions/checkout@");
    });
    expect(checkouts.length).toBeGreaterThan(0);
    for (const { file, id, step } of checkouts) {
      expect(step.with?.["persist-credentials"], `${file}#${id}`).toBe(false);
    }
  });

  it("takes the CI Node.js version from .nvmrc", () => {
    const setups = steps.filter(({ step }) => {
      return step.uses?.startsWith("actions/setup-node@");
    });
    expect(setups.length).toBeGreaterThan(0);
    for (const { file, id, step } of setups) {
      expect(step.with?.["node-version-file"], `${file}#${id}`).toBe(".nvmrc");
      expect(step.with?.["node-version"], `${file}#${id}`).toBeUndefined();
    }
  });

  it("runs exactly the four CI verification lanes", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const lanes = Object.values(ci.workflow.jobs).flatMap(
      (job) => job.strategy?.matrix?.["lane"] ?? []
    );
    // The coverage lane is its own job (it waits for the shards), so compare
    // the set of lanes, not the job order.
    return expect([...lanes].sort()).toEqual([
      "browser",
      "core",
      "coverage",
      "integration",
    ]);
  });

  // Owner 2026-11-01: PR runs and non-live-line push runs replace older runs of the
  // same PR or branch. Owner 2026-11-02: live-line push runs share one group without
  // cancel-in-progress, so a running run finishes and only a queued one is replaced.
  // Manual runs are never cancelled.
  it("cancels superseded PR and branch runs and batches queued live-line runs", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const { concurrency } = ci.workflow as unknown as {
      concurrency: { group: string; "cancel-in-progress": string };
    };
    expect(concurrency.group).toContain(
      "github.event_name == 'workflow_dispatch' && format('run-{0}', github.run_id)"
    );
    expect(concurrency.group).toContain(
      "github.event.pull_request.number || github.ref"
    );
    return expect(concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref != 'refs/heads/vertex/rebuild-darkfactory-20260921') }}"
    );
  });

  // Owner 2026-11-11 (card vertex-code-stewardship): the template init acceptance shard
  // is the longest job. It runs on the nightly run and when the changes job plans it
  // (scripts/ci/ci-changes.sh); the coverage lane then requires its report.
  it("runs the acceptance shard nightly and only when the changes job plans it", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const on = ci.workflow.on as Record<string, unknown>;
    expect(on["schedule"]).toEqual([{ cron: expect.any(String) }]);
    const { concurrency } = ci.workflow as unknown as {
      concurrency: { group: string };
    };
    // Its own group: the nightly run never replaces a queued live-line run.
    expect(concurrency.group).toContain(
      "github.event_name == 'schedule' && format('nightly-{0}', github.run_id)"
    );
    const ciJobs = ci.workflow.jobs as Record<
      string,
      Job & {
        outputs?: Record<string, string>;
        steps?: (Step & { env?: Record<string, string> })[];
      }
    >;
    expect(ciJobs["changes"]!.outputs).toMatchObject({
      acceptance: "${{ steps.plan.outputs.acceptance }}",
      skip_shards: "${{ steps.plan.outputs.skip_shards }}",
    });
    const matrix = ciJobs["coverage-shards"]!.strategy?.matrix;
    expect(matrix?.["shard"]).toContain("acceptance");
    expect(matrix?.["exclude"]).toBe(
      "${{ fromJSON(needs.changes.outputs.skip_shards) }}"
    );
    // The merge counts the reports against the plan: 13 with the acceptance shard, else 12.
    return expect(
      ciJobs["verification-coverage"]!.steps?.map((step) => step.env)
    ).toContainEqual({
      EXPECTED: "${{ needs.changes.outputs.acceptance == 'true' && 13 || 12 }}",
    });
  });

  // Card vertex-ci-queue-pathfilter (2026-11-02): one required check, a light lane
  // that never waits for the coverage shards, and no workflow-level path filters.
  it("gates every CI job behind ci-gate and keeps the light lane independent", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const ciJobs = ci.workflow.jobs as Record<
      string,
      Job & { needs?: string | string[]; if?: string }
    >;
    const gate = ciJobs["ci-gate"]!;
    expect(gate.if).toBe("${{ always() }}");
    expect([...(gate.needs as string[])].sort()).toEqual(
      Object.keys(ciJobs)
        .filter((id) => id !== "ci-gate")
        .sort()
    );
    expect(ciJobs["verification"]!.needs).toBe("changes");
    expect(ciJobs["coverage-shards"]!.if).toBe(
      "needs.changes.outputs.heavy == 'true'"
    );
    const on = ci.workflow.on as Record<string, Record<string, unknown> | null>;
    expect(on["pull_request"]?.["types"]).toEqual(
      expect.arrayContaining([
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
      ])
    );
    for (const trigger of Object.values(on)) {
      expect(trigger?.["paths-ignore"]).toBeUndefined();
      expect(trigger?.["paths"]).toBeUndefined();
    }
  });

  // Card vertex-ci-draft-ready-race (PR #84): the draft flag in the event can be
  // stale, so the changes job reports the draft state it read from GitHub. The gate
  // is the required "ci-gate" check when the event says ready, or when the changes
  // job answered "not a draft". A draft run that was cancelled before the changes
  // job answered stays "ci-gate (draft)".
  it("names the gate from the draft state that the changes job read", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const ciJobs = ci.workflow.jobs as Record<
      string,
      Job & { outputs?: Record<string, string> }
    >;
    expect(ciJobs["changes"]!.outputs?.["draft"]).toBe(
      "${{ steps.plan.outputs.draft }}"
    );
    return expect(ciJobs["ci-gate"]!.name).toBe(
      "${{ github.event.pull_request.draft && needs.changes.outputs.draft != 'false' && 'ci-gate (draft)' || 'ci-gate' }}"
    );
  });

  return it("keeps the job names that required status checks reference", () => {
    const names = jobs.map(({ job }) => job.name);
    return expect(names).toEqual(
      expect.arrayContaining([
        "Verification (${{ matrix.lane }})",
        "Analyze (${{ matrix.language }})",
        "Dependency Review",
      ])
    );
  });
});
