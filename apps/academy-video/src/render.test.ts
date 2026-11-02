import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lessonVtt, narrationTimingFor } from "@darkfactory/academy";
import { ACADEMY_LESSONS, lessonBySlug } from "@darkfactory/academy/lessons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real bundler and renderer start webpack and Chrome; every test injects fakes instead.
vi.mock("@remotion/bundler", () => ({ bundle: vi.fn() }));
vi.mock("@remotion/renderer", () => ({
  renderMedia: vi.fn(),
  renderStill: vi.fn(),
  selectComposition: vi.fn(),
}));

import {
  lessonSpecHash,
  type MediaManifestEntry,
  type RenderDependencies,
  renderLessons,
  runRenderEntrypoint,
} from "./render.ts";

const SLUG_A = "covered-call-asymmetry-fixes";
const SLUG_B = "high-iv-needs-low-hv";
const MANIFEST = "packages/academy/src/lessons/media-manifest.json";
const lesson = (slug: string) => {
  const found = lessonBySlug(slug);
  if (found === null) throw new Error(`missing lesson ${slug}`);
  return found;
};

let root: string;
let clock: number;
let stdout: string[];
let stderr: string[];
let calls: Record<string, unknown[]>;

const writer = (sink: string[]) => ({
  write: (text: string) => sink.push(text),
});

const fakes = (
  composition: Readonly<{ durationInFrames: number; fps: number }>
): RenderDependencies => ({
  root,
  entryPoint: "/entry/index.ts",
  bundle: (async (options: unknown) => {
    calls["bundle"]?.push(options);
    return "http://bundle.test";
  }) as unknown as RenderDependencies["bundle"],
  selectComposition: (async (options: unknown) => {
    calls["selectComposition"]?.push(options);
    return composition;
  }) as unknown as RenderDependencies["selectComposition"],
  renderMedia: (async (options: { outputLocation: string }) => {
    calls["renderMedia"]?.push(options);
    writeFileSync(options.outputLocation, `video:${options.outputLocation}`);
    return {};
  }) as unknown as RenderDependencies["renderMedia"],
  renderStill: (async (options: { output: string }) => {
    calls["renderStill"]?.push(options);
    writeFileSync(options.output, "jpeg");
    return {};
  }) as unknown as RenderDependencies["renderStill"],
  now: () => {
    clock += 1500;
    return clock;
  },
  env: {},
  stdout: writer(stdout),
  stderr: writer(stderr),
});

const readManifest = () =>
  JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as Record<
    string,
    MediaManifestEntry
  >;

const staleEntry: MediaManifestEntry = {
  video: "/academy-media/zz-other/lesson.mp4",
  captions: "/academy-media/zz-other/captions.vtt",
  thumbnail: "/academy-media/zz-other/thumb.jpg",
  durationSeconds: 1,
  bytes: 1,
  sha256: "0",
  renderedAt: "2026-01-01T00:00:00.000Z",
  specHash: "old",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "academy-render-"));
  mkdirSync(join(root, "packages/academy/src/lessons"), { recursive: true });
  writeFileSync(join(root, MANIFEST), JSON.stringify({}));
  clock = Date.UTC(2026, 9, 29, 12);
  stdout = [];
  stderr = [];
  calls = {
    bundle: [],
    selectComposition: [],
    renderMedia: [],
    renderStill: [],
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lessonSpecHash", () => {
  it("hashes the spec without its knowledge-base source", () => {
    const value = lesson(SLUG_A);
    const { source: _source, ...spec } = value;
    const narration = narrationTimingFor(value);
    expect(lessonSpecHash(value)).toBe(
      createHash("sha256")
        .update(
          JSON.stringify(narration === null ? spec : { ...spec, narration })
        )
        .digest("hex")
        .slice(0, 16)
    );
    expect(
      lessonSpecHash({
        ...value,
        source: { ...value.source, caption: "changed" },
      })
    ).toBe(lessonSpecHash(value));
  });

  it("hashes only the spec when a lesson has no narration timing", () => {
    const value = lesson(SLUG_A);
    const unnarrated = { ...value, steps: value.steps.slice(1) };
    expect(narrationTimingFor(unnarrated)).toBeNull();
    const { source: _source, ...spec } = unnarrated;
    expect(lessonSpecHash(unnarrated)).toBe(
      createHash("sha256")
        .update(JSON.stringify(spec))
        .digest("hex")
        .slice(0, 16)
    );
  });

  it("includes narration timing in the hash of a narrated lesson", () => {
    const value = lesson(SLUG_A);
    expect(narrationTimingFor(value)).not.toBeNull();
    const { source: _source, ...spec } = value;
    expect(lessonSpecHash(value)).not.toBe(
      createHash("sha256")
        .update(JSON.stringify(spec))
        .digest("hex")
        .slice(0, 16)
    );
  });
});

describe("renderLessons", () => {
  it("fails when no lesson is selected", async () => {
    const code = await renderLessons(
      ["--force", "not-a-lesson"],
      fakes({ durationInFrames: 90, fps: 30 })
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["No lessons selected. Pass --all or slugs.\n"]);
    expect(stdout).toEqual([]);
  });

  it("skips every lesson whose spec hash is current", async () => {
    writeFileSync(
      join(root, MANIFEST),
      JSON.stringify(
        Object.fromEntries(
          ACADEMY_LESSONS.map((value) => [
            value.slug,
            { ...staleEntry, specHash: lessonSpecHash(value) },
          ])
        )
      )
    );
    const code = await renderLessons(
      ["--all"],
      fakes({ durationInFrames: 90, fps: 30 })
    );
    expect(code).toBe(0);
    expect(stdout).toEqual([
      `0 of ${ACADEMY_LESSONS.length} lessons need rendering\n`,
    ]);
    expect(calls["bundle"]).toEqual([]);
  });

  it("renders stale lessons with defaults and keeps other manifest entries", async () => {
    writeFileSync(
      join(root, MANIFEST),
      JSON.stringify({
        "zz-other": staleEntry,
        [SLUG_A]: { ...staleEntry, specHash: lessonSpecHash(lesson(SLUG_A)) },
        [SLUG_B]: staleEntry,
      })
    );
    const code = await renderLessons(
      [SLUG_A, SLUG_B],
      fakes({ durationInFrames: 900, fps: 30 })
    );
    expect(code).toBe(0);
    expect(calls["bundle"]).toEqual([
      { entryPoint: "/entry/index.ts", onProgress: expect.any(Function) },
    ]);
    const [bundleOptions] = calls["bundle"] as [
      { onProgress: () => undefined },
    ];
    expect(bundleOptions.onProgress()).toBeUndefined();
    const directory = join(root, "apps/web/public/academy-media", SLUG_B);
    const chromiumOptions = {
      gl: "angle-egl",
      enableMultiProcessOnLinux: true,
    };
    expect(calls["selectComposition"]).toEqual([
      {
        serveUrl: "http://bundle.test",
        id: "AcademyLesson",
        inputProps: { slug: SLUG_B },
        browserExecutable: "/usr/bin/google-chrome-stable",
        chromiumOptions,
      },
    ]);
    expect(calls["renderMedia"]).toEqual([
      {
        composition: { durationInFrames: 900, fps: 30 },
        serveUrl: "http://bundle.test",
        codec: "h264",
        crf: 26,
        pixelFormat: "yuv420p",
        outputLocation: join(directory, "lesson.mp4"),
        inputProps: { slug: SLUG_B },
        concurrency: 8,
        browserExecutable: "/usr/bin/google-chrome-stable",
        chromiumOptions,
        overwrite: true,
      },
    ]);
    expect(calls["renderStill"]).toEqual([
      {
        composition: { durationInFrames: 900, fps: 30 },
        serveUrl: "http://bundle.test",
        output: join(directory, "thumb.jpg"),
        frame: 900 - 96,
        imageFormat: "jpeg",
        jpegQuality: 80,
        scale: 0.5,
        inputProps: { slug: SLUG_B },
        browserExecutable: "/usr/bin/google-chrome-stable",
        chromiumOptions,
        overwrite: true,
      },
    ]);
    expect(readFileSync(join(directory, "captions.vtt"), "utf8")).toBe(
      lessonVtt(lesson(SLUG_B))
    );
    const video = readFileSync(join(directory, "lesson.mp4"));
    const manifestText = readFileSync(join(root, MANIFEST), "utf8");
    const manifest = readManifest();
    expect(Object.keys(manifest)).toEqual([SLUG_A, SLUG_B, "zz-other"]);
    expect(manifestText.endsWith("}\n")).toBe(true);
    expect(manifestText).toBe(`${JSON.stringify(manifest, null, 1)}\n`);
    expect(manifest[SLUG_B]).toEqual({
      video: `/academy-media/${SLUG_B}/lesson.mp4`,
      captions: `/academy-media/${SLUG_B}/captions.vtt`,
      thumbnail: `/academy-media/${SLUG_B}/thumb.jpg`,
      durationSeconds: 30,
      bytes: video.length,
      sha256: createHash("sha256").update(video).digest("hex"),
      // The fake clock ticks 1.5 s per read: run start, lesson start, then this timestamp.
      renderedAt: new Date(Date.UTC(2026, 9, 29, 12) + 4500).toISOString(),
      specHash: lessonSpecHash(lesson(SLUG_B)),
    });
    expect(manifest["zz-other"]).toEqual(staleEntry);
    expect(stdout).toEqual([
      "1 of 2 lessons need rendering\n",
      `[1/1] ${SLUG_B} ${(video.length / 1e6).toFixed(2)} MB in 3.0 s\n`,
      "done in 6 s\n",
    ]);
  });

  it("forces renders with the configured Chrome and concurrency", async () => {
    writeFileSync(
      join(root, MANIFEST),
      JSON.stringify({
        [SLUG_A]: { ...staleEntry, specHash: lessonSpecHash(lesson(SLUG_A)) },
      })
    );
    const dependencies = {
      ...fakes({ durationInFrames: 30, fps: 30 }),
      env: { ACADEMY_CHROME: "/opt/chrome" },
    };
    const code = await renderLessons(
      ["--concurrency", "3", SLUG_B, "--force", SLUG_A],
      dependencies
    );
    expect(code).toBe(0);
    expect(stdout[0]).toBe("2 of 2 lessons need rendering\n");
    // Rendering follows catalog order, not argument order.
    const order = ACADEMY_LESSONS.map((value) => value.slug).filter(
      (slug) => slug === SLUG_A || slug === SLUG_B
    );
    expect(
      (calls["renderMedia"] as { inputProps: { slug: string } }[]).map(
        (options) => options.inputProps.slug
      )
    ).toEqual(order);
    for (const options of calls["renderMedia"] as {
      concurrency: number;
      browserExecutable: string;
    }[]) {
      expect(options.concurrency).toBe(3);
      expect(options.browserExecutable).toBe("/opt/chrome");
    }
    // Short compositions take the thumbnail from the first frame.
    for (const options of calls["renderStill"] as { frame: number }[])
      expect(options.frame).toBe(0);
    const manifest = readManifest();
    expect(Object.keys(manifest)).toEqual([SLUG_A, SLUG_B].sort());
    expect(manifest[SLUG_A]?.durationSeconds).toBe(1);
    expect(stdout.at(-1)).toMatch(/^done in \d+ s\n$/u);
  });

  it("re-reads the manifest so parallel renders keep their entries", async () => {
    const dependencies = fakes({ durationInFrames: 300, fps: 30 });
    const renderMedia = dependencies.renderMedia;
    const code = await renderLessons([SLUG_A], {
      ...dependencies,
      renderMedia: (async (
        options: Parameters<RenderDependencies["renderMedia"]>[0]
      ) => {
        // Another render process records its lesson while this one is busy.
        writeFileSync(
          join(root, MANIFEST),
          JSON.stringify({ "aa-parallel": staleEntry })
        );
        return renderMedia(options);
      }) as RenderDependencies["renderMedia"],
    });
    expect(code).toBe(0);
    expect(Object.keys(readManifest())).toEqual(["aa-parallel", SLUG_A]);
  });
});

describe("runRenderEntrypoint", () => {
  it("does nothing when the module is imported", async () => {
    const exitState: { exitCode?: number } = {};
    await runRenderEntrypoint({
      isMain: undefined,
      argv: ["bun", "render.ts", "--all"],
      dependencies: fakes({ durationInFrames: 90, fps: 30 }),
      exitState,
    });
    await runRenderEntrypoint({
      isMain: false,
      argv: ["bun", "render.ts", "--all"],
      dependencies: fakes({ durationInFrames: 90, fps: 30 }),
      exitState,
    });
    expect(exitState).toEqual({});
    expect(stdout).toEqual([]);
  });

  it("runs the CLI with argv after the runtime and script", async () => {
    const exitState: { exitCode?: number } = {};
    await runRenderEntrypoint({
      isMain: true,
      argv: ["bun", "src/render.ts", "missing-lesson"],
      dependencies: fakes({ durationInFrames: 90, fps: 30 }),
      exitState,
    });
    expect(exitState.exitCode).toBe(1);
    await runRenderEntrypoint({
      isMain: true,
      argv: ["bun", "src/render.ts", SLUG_A],
      dependencies: fakes({ durationInFrames: 90, fps: 30 }),
      exitState,
    });
    expect(exitState.exitCode).toBe(0);
    expect(
      existsSync(
        join(root, "apps/web/public/academy-media", SLUG_A, "thumb.jpg")
      )
    ).toBe(true);
  });

  it("stays inert under the test runner", () => {
    expect(import.meta.main).toBeFalsy();
  });
});
