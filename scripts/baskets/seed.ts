// Seeds named custom baskets ("fake ETFs") for one user through the basket repository.
// Usage: DATABASE_URL=... VERTEX_BASKET_OWNER_EMAIL=... bun run vertex:baskets:seed -- <seed.json> [--dry-run]
// seed.json: { baskets: [{ symbol, name, weighting: "equal", members: ["VSXY", ...] }] }.
// Existing baskets with the same symbol are kept unchanged, so a rerun is safe.
// It writes tracking rows only; nothing here creates orders or connects to a broker.
import { readFile } from "node:fs/promises";

import {
  type BasketSeed,
  createBasketRepository,
  createNodeDatabase,
  equalBasketWeights,
  findUserIdByEmail,
  normalizeBasketSymbol,
  seedUserBaskets,
  validateBasketMembers,
} from "@darkfactory/db/server";

const USAGE =
  "usage: bun run vertex:baskets:seed -- <seed.json> [--dry-run] (env DATABASE_URL, VERTEX_BASKET_OWNER_EMAIL)";

/** Parses and validates the seed file; equal weights are computed here. */
export const parseBasketSeeds = (text: string): BasketSeed[] => {
  const raw = JSON.parse(text) as { baskets?: unknown };
  if (!Array.isArray(raw.baskets) || raw.baskets.length === 0) {
    throw new Error("seed file needs a non-empty baskets array");
  }
  const seen = new Set<string>();
  return raw.baskets.map((entry: unknown, index: number) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const symbol =
      typeof item["symbol"] === "string"
        ? normalizeBasketSymbol(item["symbol"])
        : null;
    if (symbol === null) {
      throw new Error(`basket ${index + 1}: invalid symbol`);
    }
    if (seen.has(symbol)) throw new Error(`duplicate basket symbol: ${symbol}`);
    seen.add(symbol);
    const name = typeof item["name"] === "string" ? item["name"].trim() : "";
    if (name === "") throw new Error(`basket ${symbol}: name is required`);
    if (item["weighting"] !== "equal") {
      throw new Error(`basket ${symbol}: weighting must be "equal"`);
    }
    const members = item["members"];
    if (
      !Array.isArray(members) ||
      members.some((member) => typeof member !== "string")
    ) {
      throw new Error(`basket ${symbol}: members must be a list of symbols`);
    }
    const weights = equalBasketWeights(Math.max(members.length, 1));
    return {
      members: validateBasketMembers(
        (members as string[]).map((member, position) => ({
          symbol: member,
          // equalBasketWeights returns exactly one weight per member.
          weight: weights[position] as string,
        }))
      ),
      name,
      symbol,
    };
  });
};

const run = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const dryRun = argv.includes("--dry-run");
  const paths = argv.filter((arg) => arg !== "--dry-run");
  const [seedPath] = paths;
  if (seedPath === undefined || paths.length !== 1) throw new Error(USAGE);
  const seeds = parseBasketSeeds(await readFile(seedPath, "utf8"));
  if (dryRun) {
    return JSON.stringify({
      baskets: seeds.map((seed) => ({
        members: seed.members.length,
        symbol: seed.symbol,
      })),
      dryRun: true,
    });
  }
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  const email = env["VERTEX_BASKET_OWNER_EMAIL"];
  if (email === undefined || email.trim() === "") {
    throw new Error("VERTEX_BASKET_OWNER_EMAIL is required");
  }
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  try {
    const userId = await findUserIdByEmail(resource.db, email);
    if (userId === null) throw new Error("no user has that email");
    const result = await seedUserBaskets(
      createBasketRepository(resource.db),
      userId,
      seeds
    );
    return JSON.stringify(result);
  } finally {
    await resource.close();
  }
};

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

/** Runs the seed and returns the process exit code (0 on success). */
export const runBasketSeed = async (
  argv: readonly string[],
  io: CliIo
): Promise<number> => {
  try {
    io.stdout.write(`${await run(argv, io.env)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `basket seed failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
