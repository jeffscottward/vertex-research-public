import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";

/** Reads owner-only TLS material without following links. */
const readLocalTlsFile = (path: string): Buffer => {
  let descriptor: number | undefined;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are combined as a bit mask.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = fstatSync(descriptor);
    if (
      !details.isFile() ||
      details.uid !== process.getuid?.() ||
      details.nlink !== 1 ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits are extracted with a bit mask.
      (details.mode & 0o777) !== 0o600 ||
      details.size < 1 ||
      details.size > 65_536
    ) {
      throw new Error("Local TLS file metadata is unsafe.");
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

// Ordinary loopback development: no E2E fixtures or installed CA trust.
const localDevelopment = process.env["VERTEX_LOCAL_HTTPS"] === "1";
const localAppUrl = "https://localhost:3443";
const localDirectory = fileURLToPath(
  new URL("../../private/basic-app/", import.meta.url)
);
const localHttps = localDevelopment
  ? (() => {
      if (
        process.env["APP_ENV"] !== "development" ||
        process.env["NODE_ENV"] !== "development" ||
        process.env["APP_URL"] !== localAppUrl ||
        process.env["BETTER_AUTH_URL"] !== localAppUrl ||
        process.env["HOST"] !== "127.0.0.1" ||
        process.env["PORT"] !== "3443" ||
        process.env["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] !== "false" ||
        process.env["CLOUDFLARE_INCLUDE_PROCESS_ENV"] !== "false"
      ) {
        throw new Error(
          "Local HTTPS requires the ordinary loopback development environment."
        );
      }
      try {
        const tls = {
          cert: readLocalTlsFile(join(localDirectory, "tls/localhost.pem")),
          key: readLocalTlsFile(join(localDirectory, "tls/localhost-key.pem")),
          minVersion: "TLSv1.2" as const,
        };
        createSecureContext(tls);
        return tls;
      } catch {
        throw new Error(
          "Local development TLS material is unavailable or invalid."
        );
      }
    })()
  : undefined;

// Named loopback development behind the Mac portless proxy: http://vertex.localhost -> 127.0.0.1:3450.
// Plain HTTP is acceptable only because *.localhost is a browser secure context and the
// listener is loopback-only; production origins stay HTTPS (packages/config enforces this).
const localNamed = process.env["VERTEX_LOCAL_NAMED"] === "1";
const localNamedUrl = "http://vertex.localhost";
const localNamedDirectory = fileURLToPath(
  new URL("../../private/basic-app-named/", import.meta.url)
);
if (
  localNamed &&
  (localDevelopment ||
    process.env["APP_ENV"] !== "development" ||
    process.env["NODE_ENV"] !== "development" ||
    process.env["APP_URL"] !== localNamedUrl ||
    process.env["BETTER_AUTH_URL"] !== localNamedUrl ||
    process.env["HOST"] !== "127.0.0.1" ||
    process.env["PORT"] !== "3450" ||
    process.env["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] !== "false" ||
    process.env["CLOUDFLARE_INCLUDE_PROCESS_ENV"] !== "false")
) {
  throw new Error(
    "Named local development requires the vertex.localhost loopback environment."
  );
}
const LOCAL_FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem,key}",
  "**/.git/**",
  "**/private/**",
  "**/.dev.vars*",
  "**/.wrangler/**",
];

// Self-hosted production serve (QuantVPS): `vite preview` serves the built Worker on
// loopback behind a TLS front door. The front door keeps the public Host header and
// sets X-Forwarded-Proto: https, so the Worker's request.url origin equals APP_URL.
// VERTEX_SELF_HOSTED_ORIGIN names that public HTTPS origin; only its host is allowed.
export const selfHostedPreviewAllowedHosts = (
  environment: Readonly<Record<string, string | undefined>>
): string[] | undefined => {
  const origin = environment["VERTEX_SELF_HOSTED_ORIGIN"];
  if (origin === undefined) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(origin);
  } catch {
    url = undefined;
  }
  if (
    url?.protocol !== "https:" ||
    url.origin !== origin ||
    environment["VERTEX_LOCAL_NAMED"] === "1" ||
    environment["VERTEX_LOCAL_HTTPS"] === "1" ||
    environment["HOST"] !== "127.0.0.1" ||
    environment["CLOUDFLARE_INCLUDE_PROCESS_ENV"] !== "false"
  ) {
    throw new Error(
      "Self-hosted preview requires an exact HTTPS origin, HOST=127.0.0.1 and no process-env forwarding."
    );
  }
  return [url.hostname];
};
const selfHostedAllowedHosts = selfHostedPreviewAllowedHosts(process.env);

const rawPort = process.env["PORT"];
let port: number | undefined;

if (rawPort !== undefined) {
  const parsedPort = Number(rawPort);
  if (!/^\d+$/u.test(rawPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  port = parsedPort;
}

const host = process.env["HOST"]?.trim() || "127.0.0.1";
const isDottedNumericAddress = /^[\d.]+$/u.test(host) && host.includes(".");
const isHostname =
  !isDottedNumericAddress &&
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
    host
  );

if (isIP(host) === 0 && !isHostname) {
  throw new Error(
    "HOST must be a valid hostname or IP address without a scheme, path, or port."
  );
}

// Pre-bundle lucide-react. When it is excluded, its barrel export makes the
// dev browser fetch about 1,900 icon modules (12 MB) on each cold page load.
const CLIENT_OPTIMIZE_DEPS_INCLUDE = [
  "@tanstack/react-form",
  "@darkfactory/auth > better-auth/client",
  "@darkfactory/auth > better-auth/client/plugins",
  "@darkfactory/state > zustand/vanilla",
  "@darkfactory/state > xstate",
  "@darkfactory/ui > radix-ui",
  "@darkfactory/ui > sonner",
  "lucide-react",
  // Pre-bundled so first visits to chart and research-chat pages do not trigger
  // runtime dependency discovery, which forces a full reload and can leave open
  // tabs requesting outdated optimized chunks ("module" errors).
  "@copilotkit/react-core/v2",
  "@tanstack/charts",
  "@tanstack/charts/react",
  "d3-scale",
  "klinecharts",
] as const;
const CLIENT_OPTIMIZE_DEPS_EXCLUDE = ["next/link"] as const;
const SERVER_OPTIMIZE_DEPS_INCLUDE = [
  "@darkfactory/auth > @better-auth/api-key",
  "@darkfactory/auth > @better-auth/drizzle-adapter",
  "@darkfactory/auth > better-auth",
  "@darkfactory/auth > better-auth/cookies",
  "@darkfactory/auth > better-auth/api",
  "@darkfactory/auth > better-auth/crypto",
  "@darkfactory/auth > drizzle-orm",
  "@darkfactory/db > drizzle-orm",
  "@darkfactory/db > drizzle-orm/pg-core",
  "@darkfactory/db > drizzle-orm/node-postgres",
  "@darkfactory/db > pg",
  "@darkfactory/api > zod",
] as const;

const mergeOptimizerEntries = (
  existing: readonly string[] | undefined,
  required: readonly string[]
): string[] => [...new Set([...(existing ?? []), ...required])];

const FONT_FILE_PATTERN = /\.(?:woff2?|ttf|otf|eot)$/iu;

// Never inline font files as base64. An inlined subset is downloaded with
// every stylesheet, even when its unicode-range never matches the page text.
export const keepFontFilesExternal = (filePath: string): false | undefined =>
  FONT_FILE_PATTERN.test(filePath) ? false : undefined;

const environmentOptimizerPolicy = (): Plugin => ({
  name: "darkfactory:environment-optimizer-policy",
  enforce: "post",
  configEnvironment: {
    order: "post",
    handler(name, environment) {
      if (name === "client") {
        environment.optimizeDeps = {
          ...environment.optimizeDeps,
          exclude: mergeOptimizerEntries(
            environment.optimizeDeps?.exclude,
            CLIENT_OPTIMIZE_DEPS_EXCLUDE
          ),
          include: mergeOptimizerEntries(
            environment.optimizeDeps?.include,
            CLIENT_OPTIMIZE_DEPS_INCLUDE
          ),
        };
        // Client assets are publicly served, so never emit maps for them.
        environment.build = { ...environment.build, sourcemap: false };
        return;
      }
      if (name !== "rsc" && name !== "ssr") {
        return;
      }
      environment.optimizeDeps = {
        ...environment.optimizeDeps,
        include: mergeOptimizerEntries(
          environment.optimizeDeps?.include,
          SERVER_OPTIMIZE_DEPS_INCLUDE
        ),
        noDiscovery: true,
      };
      // Worker (rsc/ssr) maps are uploaded privately via wrangler.jsonc
      // `upload_source_maps`, so production stack traces stay readable.
      environment.build = { ...environment.build, sourcemap: true };
    },
  },
});

// The commit the bundle is built from, for the UI click log (apps/web/src/features/click-log).
// VERTEX_BUILD_SHA wins; otherwise git HEAD; "unknown" when neither is available.
const BUILD_SHA_PATTERN = /^[0-9a-f]{7,40}$/u;
const buildSha = (() => {
  const fromEnvironment = process.env["VERTEX_BUILD_SHA"];
  if (fromEnvironment !== undefined && BUILD_SHA_PATTERN.test(fromEnvironment))
    return fromEnvironment;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return BUILD_SHA_PATTERN.test(head) ? head : "unknown";
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  ...(localDevelopment || localNamed || selfHostedAllowedHosts !== undefined
    ? { envDir: false as const }
    : {}),
  build: {
    assetsInlineLimit: keepFontFilesExternal,
  },
  define: {
    __VERTEX_BUILD_SHA__: JSON.stringify(buildSha),
  },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
  },
  server: {
    host,
    ...(port === undefined ? {} : { port }),
    strictPort: true,
    ...(localHttps === undefined
      ? {}
      : {
          https: localHttps,
          open: false,
          origin: localAppUrl,
          allowedHosts: ["localhost"],
          fs: { strict: true, deny: LOCAL_FS_DENY },
        }),
    ...(localNamed
      ? {
          open: false,
          origin: localNamedUrl,
          allowedHosts: ["vertex.localhost"],
          hmr: { protocol: "ws", host: "vertex.localhost", clientPort: 80 },
          fs: { strict: true, deny: LOCAL_FS_DENY },
        }
      : {}),
    // Reduces dev transform latency; the native popover remains the SSR fallback.
    warmup: {
      clientFiles: [
        "./src/components/portal-shell.tsx",
        "./src/components/public-shell.tsx",
      ],
    },
  },
  preview: {
    host,
    ...(port === undefined ? {} : { port }),
    strictPort: true,
    ...(selfHostedAllowedHosts === undefined
      ? {}
      : { allowedHosts: selfHostedAllowedHosts }),
  },
  plugins: [
    tailwindcss(),
    vinext({
      nextConfig: {
        pageExtensions: ["tsx", "ts", "jsx", "js"],
      },
    }),
    cloudflare({
      ...(localDevelopment
        ? {
            configPath: join(localDirectory, "wrangler.jsonc"),
            inspectorPort: false as const,
            remoteBindings: false,
            tunnel: false,
            persistState: { path: join(localDirectory, "state") },
          }
        : {}),
      ...(localNamed
        ? {
            configPath: join(localNamedDirectory, "wrangler.jsonc"),
            inspectorPort: false as const,
            remoteBindings: false,
            tunnel: false,
            persistState: { path: join(localNamedDirectory, "state") },
          }
        : {}),
      // Self-hosted preview: no Workers inspector and no /__debug devtools page.
      ...(selfHostedAllowedHosts === undefined
        ? {}
        : { inspectorPort: false as const, remoteBindings: false }),
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
    environmentOptimizerPolicy(),
  ],
});
