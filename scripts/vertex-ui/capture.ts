// What: Capture UI lab entries as full-page PNGs with headless Chromium (Playwright used as a library,
// not the test runner). Dark mode by default. Capture only: no assertions.
// Usage: bun scripts/vertex-ui/capture.ts --base <url> --entry <id|all> --out <dir>
//          [--widths 1440,820,375] [--name capture] [--query "symbol=NVDA"] [--theme dark|light]
// Writes <out>/<name>-<width>.png (with --entry all: <out>/<entry>/<name>-<width>.png).
// See: ~/Documents/reports/web/firstmate/vertex-ui-program.md ("Capture + review tooling").
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

export type Viewport = Readonly<{ width: number; height: number }>;

/** The lab fixture clock (apps/web/src/lab/fixtures/core.ts LAB_NOW_ISO), so time text never drifts. */
export const LAB_CLOCK_ISO = "2026-10-30T20:00:00.000Z";

/** The skip link is a keyboard aid; it is hidden in captures so it never covers the page. */
const HIDE_SKIP_LINK = ".skip-link{display:none!important}";

/** Owner device sizes: iPhone 375x812, iPad 820x1180, laptop 1440x900. Other widths use 900 high. */
const DEVICE_HEIGHTS: Readonly<Record<number, number>> = Object.freeze({
  375: 812,
  820: 1180,
  1440: 900,
});

export const viewportFor = (width: number): Viewport => ({
  height: DEVICE_HEIGHTS[width] ?? 900,
  width,
});

export type CaptureOptions = Readonly<{
  base: string;
  entry: string;
  out: string;
  widths: readonly number[];
  name: string;
  query: string;
  theme: "dark" | "light";
  settleMs: number;
}>;

export class CaptureUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureUsageError";
  }
}

const ENTRY = /^(?:all|[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/u;

export const parseCaptureArgs = (argv: readonly string[]): CaptureOptions => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      base: { type: "string" },
      entry: { type: "string" },
      name: { default: "capture", type: "string" },
      out: { type: "string" },
      query: { default: "", type: "string" },
      "settle-ms": { default: "1500", type: "string" },
      theme: { default: "dark", type: "string" },
      widths: { default: "1440,820,375", type: "string" },
    },
    strict: true,
  });
  const { base, entry, out, widths, name, query, theme } = values;
  if (base === undefined || entry === undefined || out === undefined)
    throw new CaptureUsageError("--base, --entry and --out are required");
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    throw new CaptureUsageError(`--base is not a URL: ${base}`);
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:")
    throw new CaptureUsageError("--base must be http or https");
  if (!ENTRY.test(entry))
    throw new CaptureUsageError(`--entry is not a lab entry id: ${entry}`);
  if (!NAME.test(name))
    throw new CaptureUsageError(`--name must be lowercase words: ${name}`);
  if (theme !== "dark" && theme !== "light")
    throw new CaptureUsageError("--theme must be dark or light");
  const parsedWidths = widths.split(",").map((value) => Number(value.trim()));
  if (
    parsedWidths.length === 0 ||
    parsedWidths.some(
      (width) => !Number.isInteger(width) || width < 320 || width > 3840
    )
  )
    throw new CaptureUsageError("--widths must be integers from 320 to 3840");
  const settleMs = Number(values["settle-ms"]);
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60_000)
    throw new CaptureUsageError("--settle-ms must be 0 to 60000");
  return {
    base: origin.origin,
    entry,
    name,
    out,
    query: query.replace(/^\?/u, ""),
    settleMs,
    theme,
    widths: parsedWidths,
  };
};

/** /lab/<entry>?<query>&theme=<theme> on the base origin. */
export const entryUrl = (
  base: string,
  entry: string,
  query: string,
  theme: "dark" | "light"
): string => {
  const url = new URL(`/lab/${encodeURIComponent(entry)}`, base);
  url.search = new URLSearchParams(query).toString();
  url.searchParams.set("theme", theme);
  return url.toString();
};

/** Entry ids linked from the lab index HTML (data-lab-entry="<id>"), in page order, deduplicated. */
export const entryIdsFromIndex = (html: string): string[] => [
  // The capture group always matches, so String() only narrows the type.
  ...new Set(
    [...html.matchAll(/data-lab-entry="([a-z0-9-]+)"/gu)].map(([, id]) =>
      String(id)
    )
  ),
];

/** The small part of a Playwright page that capture uses (a fake in tests). */
export interface CapturePage {
  readonly close: () => Promise<void>;
  readonly goto: (url: string) => Promise<unknown>;
  /** Before navigation: freeze the page clock at LAB_CLOCK_ISO. */
  readonly prepare: () => Promise<void>;
  readonly screenshot: (options: {
    path: string;
    fullPage: true;
  }) => Promise<unknown>;
  /** After render: hide the skip link and scroll to the top, so fixed parts sit at the top. */
  readonly settle: () => Promise<void>;
  readonly waitForSelector: (selector: string) => Promise<unknown>;
  readonly waitForTimeout: (ms: number) => Promise<void>;
}

export interface CaptureBrowser {
  readonly close: () => Promise<void>;
  readonly newPage: (options: {
    viewport: Viewport;
    colorScheme: "dark" | "light";
    reducedMotion: "reduce";
  }) => Promise<CapturePage>;
}

export type CaptureDependencies = Readonly<{
  launch: () => Promise<CaptureBrowser>;
  fetchText: (url: string) => Promise<string>;
  makeDirectory: (path: string) => Promise<unknown>;
  log: (line: string) => void;
}>;

const captureOne = async (
  browser: CaptureBrowser,
  options: CaptureOptions,
  entry: string,
  width: number,
  directory: string
): Promise<string> => {
  const page = await browser.newPage({
    colorScheme: options.theme,
    reducedMotion: "reduce",
    viewport: viewportFor(width),
  });
  try {
    await page.prepare();
    await page.goto(
      entryUrl(options.base, entry, options.query, options.theme)
    );
    // The entry view itself: an unknown id shows only the frame and fails here.
    await page.waitForSelector(`[data-lab-entry-view="${entry}"]`);
    await page.waitForTimeout(options.settleMs);
    await page.settle();
    const path = join(directory, `${options.name}-${width}.png`);
    await page.screenshot({ fullPage: true, path });
    return path;
  } finally {
    await page.close();
  }
};

/** Captures every requested entry and width; returns the written PNG paths. */
export const runCapture = async (
  options: CaptureOptions,
  dependencies: CaptureDependencies
): Promise<string[]> => {
  const entries =
    options.entry === "all"
      ? entryIdsFromIndex(
          await dependencies.fetchText(new URL("/lab", options.base).toString())
        )
      : [options.entry];
  if (entries.length === 0)
    throw new CaptureUsageError("The lab index lists no entries");
  const browser = await dependencies.launch();
  const written: string[] = [];
  const failures: string[] = [];
  try {
    for (const entry of entries) {
      const directory =
        options.entry === "all" ? join(options.out, entry) : options.out;
      await dependencies.makeDirectory(directory);
      for (const width of options.widths) {
        try {
          const path = await captureOne(
            browser,
            options,
            entry,
            width,
            directory
          );
          written.push(path);
          dependencies.log(path);
        } catch (error) {
          // One slow or broken entry must not stop a full baseline run.
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push(`${entry}@${width}: ${message.split("\n")[0]}`);
          dependencies.log(`FAILED ${entry}@${width}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length > 0)
    throw new Error(`Capture failed for ${failures.join("; ")}`);
  return written;
};

/** The part of Playwright's chromium launcher that capture uses. */
export interface ChromiumLauncher {
  readonly launch: (options: { headless: true }) => Promise<{
    newPage: (
      options: Parameters<CaptureBrowser["newPage"]>[0] & {
        ignoreHTTPSErrors: true;
      }
    ) => Promise<{
      readonly addStyleTag: (options: { content: string }) => Promise<unknown>;
      readonly clock: {
        readonly setFixedTime: (time: Date) => Promise<void>;
      };
      readonly evaluate: (expression: string) => Promise<unknown>;
      readonly goto: (
        url: string,
        options: { waitUntil: "load"; timeout: number }
      ) => Promise<unknown>;
      readonly waitForLoadState: (
        state: "networkidle",
        options: { timeout: number }
      ) => Promise<void>;
      readonly waitForSelector: (selector: string) => Promise<unknown>;
      readonly waitForTimeout: (ms: number) => Promise<void>;
      readonly screenshot: (options: {
        path: string;
        fullPage: true;
      }) => Promise<unknown>;
      readonly close: () => Promise<void>;
    }>;
    readonly close: () => Promise<void>;
  }>;
}

/** Real dependencies: headless Chromium from the installed Playwright browsers. */
export const createCaptureDependencies = (
  log: (line: string) => void,
  launcher: ChromiumLauncher,
  fetchImpl: (url: string) => Promise<Response>
): CaptureDependencies => ({
  fetchText: async (url) => {
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new CaptureUsageError(`GET ${url} returned ${response.status}`);
    return response.text();
  },
  launch: async () => {
    const browser = await launcher.launch({ headless: true });
    return {
      close: () => browser.close(),
      newPage: async (options) => {
        const page = await browser.newPage({
          ...options,
          ignoreHTTPSErrors: true,
        });
        return {
          close: () => page.close(),
          goto: async (url) => {
            // A dev server compiles on first visit: allow 2 minutes, then give
            // late requests a short, best-effort chance to settle.
            await page.goto(url, { timeout: 120_000, waitUntil: "load" });
            await page
              .waitForLoadState("networkidle", { timeout: 15_000 })
              .catch(() => undefined);
          },
          prepare: () => page.clock.setFixedTime(new Date(LAB_CLOCK_ISO)),
          screenshot: (screenshotOptions) => page.screenshot(screenshotOptions),
          settle: async () => {
            await page.addStyleTag({ content: HIDE_SKIP_LINK });
            await page.evaluate("window.scrollTo(0, 0)");
          },
          waitForSelector: (selector) => page.waitForSelector(selector),
          waitForTimeout: (ms) => page.waitForTimeout(ms),
        };
      },
    };
  },
  log,
  makeDirectory: (path) => mkdir(path, { recursive: true }),
});

export interface OutputStream {
  readonly write: (text: string) => unknown;
}

export type CaptureEntrypoint = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  stdout: OutputStream;
  stderr: OutputStream;
  exitState: { exitCode?: number | string | null | undefined };
  launcher?: ChromiumLauncher;
  fetchImpl?: (url: string) => Promise<Response>;
}>;

/** CLI entry: runs only when this module is the process entry point. */
export const runCaptureEntrypoint = async ({
  isMain,
  argv,
  stdout,
  stderr,
  exitState,
  launcher = chromium,
  fetchImpl = fetch,
}: CaptureEntrypoint): Promise<void> => {
  if (!isMain) return;
  try {
    await runCapture(
      parseCaptureArgs(argv.slice(2)),
      createCaptureDependencies(
        (line) => stdout.write(`${line}\n`),
        launcher,
        fetchImpl
      )
    );
    exitState.exitCode = 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exitState.exitCode = error instanceof CaptureUsageError ? 2 : 1;
  }
};

await runCaptureEntrypoint({
  argv: process.argv,
  exitState: process,
  isMain: import.meta.main,
  stderr: process.stderr,
  stdout: process.stdout,
});
