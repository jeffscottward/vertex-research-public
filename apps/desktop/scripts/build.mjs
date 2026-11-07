// Bundles the Electron main process into dist/main.js (ESM, Node platform, electron external).
import { build } from "esbuild";

await build({
  banner: {
    // Bundled CommonJS dependencies may call require(); ESM has none by default.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  bundle: true,
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  external: ["electron"],
  format: "esm",
  logLevel: "info",
  outfile: new URL("../dist/main.js", import.meta.url).pathname,
  platform: "node",
  sourcemap: true,
  target: "node22",
});
