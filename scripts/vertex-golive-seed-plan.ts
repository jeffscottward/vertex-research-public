// Go-live allocation plan seed (plan document → golive_plans). See scripts/golive/seed-plan.ts.
import { runGoLiveSeedPlan } from "./golive/seed-plan.ts";

process.exitCode = await runGoLiveSeedPlan(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
