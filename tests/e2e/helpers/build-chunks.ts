import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Client output of the production build the browser lane serves (`start`). */
export const WEB_CLIENT_BUILD_DIRECTORY = fileURLToPath(
  new URL("../../../apps/web/dist/client/", import.meta.url)
);

// vinext emits client JS hash-only (`_next/static/chunks/[hash].js`), so a chunk URL
// no longer names its component. vinext also writes, next to Vite's build manifest,
// a map of App Router client reference source files (relative to apps/web) to the
// chunk that holds each reference. Neither file is deployed with the public assets.
const CLIENT_REFERENCE_SOURCES_FILE =
  ".vite/vinext-client-reference-sources.json";
const VITE_MANIFEST_FILE = ".vite/manifest.json";

const readJsonRecord = (
  path: string
): Readonly<Record<string, unknown>> | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/**
 * Fallback for a build without the reference map: Vite's manifest keys a client
 * reference as `virtual:vinext-client-reference-module/<id>/<name>`, with the chunk's
 * Rolldown name (the source file name without extension) in `name`.
 */
const chunkFromViteManifest = (
  clientDirectory: string,
  sourcePath: string
): string | undefined => {
  const manifest = readJsonRecord(join(clientDirectory, VITE_MANIFEST_FILE));
  if (manifest === undefined) return undefined;
  const name = (sourcePath.split("/").at(-1) ?? sourcePath).replace(
    /\.[cm]?[jt]sx?$/u,
    ""
  );
  const files = new Set<string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { file, name: entryName } = entry as {
      file?: unknown;
      name?: unknown;
    };
    if (
      typeof file === "string" &&
      entryName === name &&
      key.startsWith("virtual:vinext-client-reference-module/")
    ) {
      files.add(file);
    }
  }
  if (files.size > 1) {
    throw new Error(
      `Several client reference chunks are named ${name}: ${[...files].join(", ")}`
    );
  }
  return files.values().next().value;
};

/**
 * URL path (`/_next/static/chunks/<hash>.js`) of the client chunk that holds the
 * client component in `sourcePath` (relative to apps/web, e.g.
 * `src/components/portal-shell.tsx`). Throws when the build is missing or does not
 * hold that component, so a spec never waits on a request that cannot come.
 */
export const clientReferenceChunkPath = (
  sourcePath: string,
  clientDirectory: string = WEB_CLIENT_BUILD_DIRECTORY
): string => {
  const sources = readJsonRecord(
    join(clientDirectory, CLIENT_REFERENCE_SOURCES_FILE)
  );
  const mapped = sources?.[sourcePath];
  const file =
    typeof mapped === "string"
      ? mapped
      : chunkFromViteManifest(clientDirectory, sourcePath);
  if (file === undefined) {
    throw new Error(
      `No client chunk for ${sourcePath} in ${clientDirectory}; build apps/web first (pnpm --filter @darkfactory/web run build).`
    );
  }
  return `/${file.replace(/^\/+/u, "")}`;
};

/** Matches a request URL for that chunk, with or without a query string. */
export const clientReferenceChunkUrlPattern = (
  sourcePath: string,
  clientDirectory?: string
): RegExp => {
  const escapedPath = clientReferenceChunkPath(
    sourcePath,
    clientDirectory
  ).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escapedPath}(?:\\?.*)?$`, "u");
};
