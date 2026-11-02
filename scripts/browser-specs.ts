import {
  runBrowserSpecs,
  systemBrowserSpecsDependencies,
} from "./lib/browser-specs.ts";

process.exitCode = runBrowserSpecs(
  process.argv.slice(2),
  systemBrowserSpecsDependencies
);
