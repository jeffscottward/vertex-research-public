import { vi } from "vitest";

import { fileTimeouts } from "./test-timeout-scale.ts";

// Load-aware deadlines per test file (card
// vertex-timeout-scale-stale-under-load): measure the CPU shortage again
// before each file, so a long run follows the load of the run's own workers
// and of other sessions. Vitest resets vi.setConfig after each file.
vi.setConfig(fileTimeouts(process.env));
