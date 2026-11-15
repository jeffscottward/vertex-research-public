import { runPostCheckout } from "./index.ts";

process.exitCode = runPostCheckout(process.argv.slice(2));
