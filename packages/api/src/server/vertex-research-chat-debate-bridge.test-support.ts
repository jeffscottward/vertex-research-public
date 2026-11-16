// How the five-turn debate test starts its native consumer: the script and the
// import search path after the script's own folder, as repository paths. The
// launcher (vertex-research-chat-debate.test-support.ts) and the closure test
// (scripts/ci/debate-path-closure.test.ts) both read them, so the two cannot
// differ. The closure test checks that each first-party Python file that the
// consumer loads at start matches touches_debate in scripts/ci/ci-changes.sh.
export const DEBATE_BRIDGE_SCRIPT =
  "services/research/adapters/tests/chat_debate_bridge.py";

export const DEBATE_BRIDGE_PYTHON_PATH = [
  "services/research",
  "services/market-data",
  "services/control-client",
  "services/host",
  "services/gateway",
  "services/execution",
] as const;
