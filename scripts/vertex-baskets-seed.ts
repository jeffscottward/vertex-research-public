// Basket seed CLI. See scripts/baskets/seed.ts.
import { runBasketSeed } from "./baskets/seed.ts";

process.exitCode = await runBasketSeed(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
