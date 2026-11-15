import {
  DatabasePersistenceError,
  type PlayRecord,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { Play } from "../contracts/plays.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Plays view: reads the plays table (packages/db plays repository), newest first. Read-only:
// rows are written server-side (seeds, operator scripts), never through the API, and nothing
// here places an order.

type Failures = Readonly<{ STORAGE_ERROR: () => Error }>;

export const toPlayOutput = (play: PlayRecord): Play => ({
  id: play.id,
  ticker: play.ticker,
  structure: play.structure,
  legs: play.legs.map((leg) => ({
    side: leg.side,
    right: leg.right,
    strike: leg.strike,
    expiry: leg.expiry,
    quantity: leg.quantity,
  })),
  maxLossUsd: Number(play.maxLossUsd),
  definedRisk: true,
  thesis: play.thesis,
  trigger: play.trigger,
  exitRule: play.exitRule,
  status: play.status,
  notes: play.notes,
  sourceUrl: play.sourceUrl,
  createdAt: play.createdAt.toISOString(),
  updatedAt: play.updatedAt.toISOString(),
});

const api = implement(appContract).$context<ApiContext>();

const playsList = api.plays.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = context.repositories.plays;
    if (repository === undefined) throw failures.STORAGE_ERROR();
    try {
      const rows = await repository.list();
      return { plays: rows.map(toPlayOutput) };
    } catch (error) {
      if (error instanceof DatabasePersistenceError) {
        throw failures.STORAGE_ERROR();
      }
      throw error;
    }
  });

export const playsRouter = { list: playsList };
