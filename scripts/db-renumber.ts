// `pnpm db:renumber [--base <ref>]`: after `git merge <base>`, moves this branch's new migrations
// behind the base's and stages the result. See scripts/migrations/renumber.ts.
import { runRenumber } from "./migrations/renumber.ts";

process.exitCode = runRenumber(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
