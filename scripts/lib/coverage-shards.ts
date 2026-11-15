// The native-evidence suite was the longest unit work: one file, about 20 min
// in one hashed CI shard. Its tests are bound by the JavaScript main thread of
// their worker, so in-file concurrency does not help. It is split by test group
// into four files that run as two named shards; the two files of a shard run
// in parallel workers on a runner with 3 or more vCPUs (GitHub-hosted
// ubuntu-latest has 4 for public repositories) (card orochi-impl). This leaf module has no imports, so
// vitest.config.ts can read it. vitest.config.ts builds one project per
// entry and keeps these files out of the unit project.
export const NATIVE_EVIDENCE_SHARDS = {
  "native-evidence-1": [
    "packages/api/src/server/vertex-research-chat-native-evidence.test.ts",
    "packages/api/src/server/vertex-research-chat-native-evidence-phase-two.test.ts",
  ],
  "native-evidence-2": [
    "packages/api/src/server/vertex-research-chat-native-evidence-rejects.test.ts",
    "packages/api/src/server/vertex-research-chat-native-evidence-final.test.ts",
  ],
} as const;

// The five-turn debate acceptance test is one test of 10 to 15 minutes on a
// GitHub-hosted runner (3.1 million SQL reads of security rechecks), the
// longest pull-request job. Owner decision 2026-11-15 (card
// vertex-debate-5turn-ci-speed): it is its own named shard. The nightly run,
// a manual run (the exact-SHA run before a deploy) and a pull request or push
// that changes a debate file run it (scripts/ci/ci-changes.sh). Pre-push still
// runs it through the packages/api test:unit script.
export const DEBATE_FIVE_TURN_SHARD = "debate-five-turn";
export const DEBATE_FIVE_TURN_SHARDS = {
  [DEBATE_FIVE_TURN_SHARD]: [
    "packages/api/src/server/vertex-research-chat-debate-five-turn.test.ts",
  ],
} as const;

// Every named shard that is a fixed list of files: one Vitest project each,
// kept out of the unit project.
export const FILE_SHARDS: Readonly<Record<string, readonly string[]>> = {
  ...NATIVE_EVIDENCE_SHARDS,
  ...DEBATE_FIVE_TURN_SHARDS,
};
