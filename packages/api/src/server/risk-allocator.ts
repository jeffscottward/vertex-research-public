import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { OWNER_RISK_CAPS, suggestAllocation } from "../risk-allocator.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Advisory only: these handlers compute numbers from their input. They read no account data,
// write nothing and cannot place, change or cancel an order.
const api = implement(appContract).$context<ApiContext>();

const caps = api.riskAllocator.caps
  .use(requireOperator)
  .handler(() => OWNER_RISK_CAPS);

const suggest = api.riskAllocator.suggest
  .use(requireOperator)
  .handler(({ input }) => suggestAllocation(input));

export const riskAllocatorRouter = { caps, suggest };
