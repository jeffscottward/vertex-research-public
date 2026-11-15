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
