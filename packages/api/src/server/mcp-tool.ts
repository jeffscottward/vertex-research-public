import type { z } from "zod";

// One MCP tool: a name, a description, the oRPC procedure it forwards to (slash path such as
// "backtestRuns/get") and the Zod input schema the tool checks before the call. `prepare` maps
// tool arguments to procedure input; `present` shapes the procedure output for the agent.
export type McpTool = Readonly<{
  name: string;
  title: string;
  description: string;
  procedure: string;
  input: z.ZodType;
  readOnly: boolean;
  prepare?: (args: Record<string, unknown>) => unknown;
  present?: (value: unknown, args: Record<string, unknown>) => unknown;
}>;
