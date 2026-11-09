// Renders Academy lesson media into apps/web/public/academy-media/<slug>/ and records them in
// packages/academy/src/lessons/media-manifest.json.
// Usage: bun src/render.ts [--all | <slug>...] [--force] [--concurrency N]
// A lesson is re-rendered only when its spec hash changed (or with --force). Chrome renders the frames
// with GPU acceleration (ANGLE/EGL) on the rig; ffmpeg in Remotion encodes H.264.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  courseOf,
  DEFAULT_COURSE_ID,
  lessonVtt,
  narrationTimingFor,
} from "@darkfactory/academy";
import { ACADEMY_LESSONS } from "@darkfactory/academy/lessons";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";

export interface MediaManifestEntry {
  video: string;
  captions: string;
  thumbnail: string;
  durationSeconds: number;
  bytes: number;
  sha256: string;
  renderedAt: string;
  specHash: string;
}

interface Writer {
  write: (text: string) => unknown;
}

export type RenderDependencies = Readonly<{
  /** Repository root: media and the manifest are resolved under it. */
  root: string;
  /** Remotion entry point bundled once per run. */
  entryPoint: string;
  bundle: typeof bundle;
  selectComposition: typeof selectComposition;
  renderMedia: typeof renderMedia;
  renderStill: typeof renderStill;
  now: () => number;
  env: Readonly<Record<string, string | undefined>>;
  stdout: Writer;
  stderr: Writer;
}>;

type AcademyLesson = (typeof ACADEMY_LESSONS)[number];

/** Spec hash recorded in the manifest; the knowledge-base source does not affect the render.
 * Narration timing changes the timeline, so it is part of the hash. The default course is left out
 * so specs that predate courses keep their recorded hash. */
export const lessonSpecHash = (lesson: AcademyLesson): string => {
  const { source: _source, course, ...rest } = lesson;
  const spec = course === DEFAULT_COURSE_ID ? rest : { course, ...rest };
  const narration = narrationTimingFor(lesson);
  return createHash("sha256")
    .update(JSON.stringify(narration === null ? spec : { ...spec, narration }))
    .digest("hex")
    .slice(0, 16);
};

/** Renders the lessons selected by `args` (argv without runtime and script); returns the exit code. */
export const renderLessons = async (
  args: readonly string[],
  dependencies: RenderDependencies
): Promise<number> => {
  const { root, now, stdout } = dependencies;
  const mediaRoot = join(root, "apps/web/public/academy-media");
  const manifestPath = join(
    root,
    "packages/academy/src/lessons/media-manifest.json"
  );
  const force = args.includes("--force");
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency =
    concurrencyIndex >= 0 ? Number(args[concurrencyIndex + 1]) : 8;
  const slugs = args.filter(
    (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--concurrency"
  );
  const browserExecutable =
    dependencies.env["ACADEMY_CHROME"] ?? "/usr/bin/google-chrome-stable";

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    MediaManifestEntry
  >;

  // --all renders narrated courses only (courses.ts); others play the live animation on the page.
  const lessons = ACADEMY_LESSONS.filter((lesson) =>
    args.includes("--all")
      ? courseOf(lesson).narrated
      : slugs.includes(lesson.slug)
  );
  if (lessons.length === 0) {
    dependencies.stderr.write("No lessons selected. Pass --all or slugs.\n");
    return 1;
  }

  const pending = lessons.filter(
    (lesson) =>
      force || manifest[lesson.slug]?.specHash !== lessonSpecHash(lesson)
  );
  stdout.write(
    `${pending.length} of ${lessons.length} lessons need rendering\n`
  );
  if (pending.length === 0) return 0;

  const started = now();
  const serveUrl = await dependencies.bundle({
    entryPoint: dependencies.entryPoint,
    onProgress: () => undefined,
  });
  const chromiumOptions = {
    gl: "angle-egl" as const,
    enableMultiProcessOnLinux: true,
  };

  for (const [position, lesson] of pending.entries()) {
    const t0 = now();
    const directory = join(mediaRoot, lesson.slug);
    mkdirSync(directory, { recursive: true });
    const inputProps = { slug: lesson.slug };
    const composition = await dependencies.selectComposition({
      serveUrl,
      id: "AcademyLesson",
      inputProps,
      browserExecutable,
      chromiumOptions,
    });
    const videoPath = join(directory, "lesson.mp4");
    await dependencies.renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf: 26,
      pixelFormat: "yuv420p",
      outputLocation: videoPath,
      inputProps,
      concurrency,
      browserExecutable,
      chromiumOptions,
      overwrite: true,
    });
    // Thumbnail: the frame where the last step has finished drawing.
    const lastStep =
      composition.durationInFrames - Math.round(composition.fps * 3.2);
    await dependencies.renderStill({
      composition,
      serveUrl,
      output: join(directory, "thumb.jpg"),
      frame: Math.max(lastStep, 0),
      imageFormat: "jpeg",
      jpegQuality: 80,
      scale: 0.5,
      inputProps,
      browserExecutable,
      chromiumOptions,
      overwrite: true,
    });
    writeFileSync(join(directory, "captions.vtt"), lessonVtt(lesson));
    const bytes = statSync(videoPath).size;
    const entry: MediaManifestEntry = {
      video: `/academy-media/${lesson.slug}/lesson.mp4`,
      captions: `/academy-media/${lesson.slug}/captions.vtt`,
      thumbnail: `/academy-media/${lesson.slug}/thumb.jpg`,
      durationSeconds:
        Math.round((composition.durationInFrames / composition.fps) * 10) / 10,
      bytes,
      sha256: createHash("sha256")
        .update(readFileSync(videoPath))
        .digest("hex"),
      renderedAt: new Date(now()).toISOString(),
      specHash: lessonSpecHash(lesson),
    };
    manifest[lesson.slug] = entry;
    // Write after each lesson so an interrupted batch keeps its finished renders. Re-read first:
    // parallel render processes (disjoint slugs) share this manifest file.
    const latest = {
      ...(JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        MediaManifestEntry
      >),
      [lesson.slug]: entry,
    };
    writeFileSync(
      manifestPath,
      `${JSON.stringify(Object.fromEntries(Object.entries(latest).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`
    );
    stdout.write(
      `[${position + 1}/${pending.length}] ${lesson.slug} ${(bytes / 1e6).toFixed(2)} MB in ${((now() - t0) / 1000).toFixed(1)} s\n`
    );
  }
  stdout.write(`done in ${((now() - started) / 1000).toFixed(0)} s\n`);
  return 0;
};

export type RenderEntrypoint = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  dependencies: RenderDependencies;
  exitState: { exitCode?: number | string | null | undefined };
}>;

/** CLI entry: runs only when this module is the process entry point (`bun src/render.ts`). */
export const runRenderEntrypoint = async ({
  isMain,
  argv,
  dependencies,
  exitState,
}: RenderEntrypoint): Promise<void> => {
  if (!isMain) return;
  exitState.exitCode = await renderLessons(argv.slice(2), dependencies);
};

await runRenderEntrypoint({
  isMain: import.meta.main,
  argv: process.argv,
  dependencies: {
    root: resolve(import.meta.dirname, "../../.."),
    entryPoint: join(import.meta.dirname, "index.ts"),
    bundle,
    selectComposition,
    renderMedia,
    renderStill,
    now: Date.now,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  exitState: process,
});
