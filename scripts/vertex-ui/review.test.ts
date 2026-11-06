import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  BOT_ORIGIN,
  createReviewDependencies,
  hasAttachment,
  parseReviewArgs,
  postedMessage,
  REVIEW_CHANNEL_ID,
  type ReviewDependencies,
  ReviewUsageError,
  reviewMessage,
  runReview,
  runReviewEntrypoint,
} from "./review.ts";

const DEMO = "https://demo-host.tail000000.ts.net:8450/lab/charts";
const DEMO_LABEL = "demo-host.tail000000.ts.net:8450/lab/charts";
const BASE_ARGS = [
  "--page=charts",
  "--before=/r/before.png",
  "--after=/r/after.png",
  "--caption=/r/caption.txt",
  `--demo=${DEMO}`,
];

const posted = {
  id: "1567600000000000001",
  ok: true,
  url: "owner Discord message (private)",
};
const readBack = {
  messages: [{ attachments: ["review.jpg"], id: posted.id }],
  ok: true,
};

const fakeDependencies = (
  overrides: Partial<ReviewDependencies> = {}
): ReviewDependencies & { posts: unknown[]; lines: string[] } => {
  const posts: unknown[] = [];
  const lines: string[] = [];
  return {
    getJson: async () => readBack,
    lines,
    log: (line) => lines.push(line),
    makeDirectory: async () => undefined,
    postJson: async (_path, body) => {
      posts.push(body);
      return posted;
    },
    posts,
    readText: async () => "Header row now uses small uppercase labels.\n",
    stack: async (_before, _after, out) => `${out} 3 boxes\n`,
    ...overrides,
  };
};

describe("parseReviewArgs", () => {
  it("fills defaults under the review folder", () => {
    expect(parseReviewArgs(BASE_ARGS, "/home/demo")).toEqual({
      after: "/r/after.png",
      before: "/r/before.png",
      caption: "/r/caption.txt",
      channel: REVIEW_CHANNEL_ID,
      demo: DEMO,
      out: "/home/demo/Documents/reports/vertex-ui-review/charts/review.jpg",
      page: "charts",
      post: true,
      title: "Vertex UI review: charts",
    });
  });

  it("reads optional title, output, channel and --no-post", () => {
    expect(
      parseReviewArgs(
        [
          ...BASE_ARGS,
          "--title=Charts page",
          "--out=/home/demo/Documents/reports/vertex-ui-review/charts/x.jpg",
          "--channel=1234567890123456789",
          "--no-post",
        ],
        "/home/demo"
      )
    ).toMatchObject({
      channel: "1234567890123456789",
      out: "/home/demo/Documents/reports/vertex-ui-review/charts/x.jpg",
      post: false,
      title: "Charts page",
    });
  });

  it.each([
    [["--page=charts"], "required"],
    [[...BASE_ARGS, "--page=Charts"], "lowercase"],
    [[...BASE_ARGS, "--demo=nope"], "not a URL"],
    [[...BASE_ARGS, "--demo=https://example.com/lab"], "tailnet"],
    [[...BASE_ARGS, "--demo=http://h.ts.net/lab"], "tailnet"],
    [[...BASE_ARGS, "--channel=general"], "channel id"],
    [
      [...BASE_ARGS, "--out=/tmp/x.jpg"],
      "inside /h/Documents/reports/vertex-ui-review",
    ],
    [[...BASE_ARGS, "--out=/h/Documents/reports/vertex-ui-review"], "inside"],
    [
      [...BASE_ARGS, "--out=/h/Documents/reports/vertex-ui-review/../x.jpg"],
      "inside",
    ],
  ])("rejects %j", (argv, message) => {
    expect(() => parseReviewArgs(argv, "/h")).toThrow(ReviewUsageError);
    expect(() => parseReviewArgs(argv, "/h")).toThrow(message);
  });
});

describe("review helpers", () => {
  it("formats the message under the Discord limit", () => {
    expect(reviewMessage({ demo: DEMO, title: "T" }, "Short.")).toBe(
      `**T**\nShort.\nDemo (tailnet only): [${DEMO_LABEL}](<${DEMO}>)`
    );
    const long = reviewMessage({ demo: DEMO, title: "T" }, "x".repeat(5000));
    expect(long.length).toBeLessThanOrEqual(1900);
    expect(long).toContain("…\nDemo (tailnet only)");
  });

  it("reads the posted message and the read-back", () => {
    expect(postedMessage(posted)).toEqual({ id: posted.id, url: posted.url });
    for (const bad of [null, {}, { id: 1, ok: true }, { ...posted, ok: false }])
      expect(() => postedMessage(bad)).toThrow("did not post");
    expect(hasAttachment(readBack, posted.id)).toBe(true);
    expect(hasAttachment(readBack, "other")).toBe(false);
    expect(hasAttachment({ messages: "x" }, posted.id)).toBe(false);
    expect(
      hasAttachment(
        { messages: [{ attachments: [], id: posted.id }] },
        posted.id
      )
    ).toBe(false);
    expect(hasAttachment({ messages: [null] }, posted.id)).toBe(false);
  });
});

describe("runReview", () => {
  it("builds the image, posts it with the demo link and checks the read-back", async () => {
    const dependencies = fakeDependencies();
    await expect(
      runReview(parseReviewArgs(BASE_ARGS, "/home/demo"), dependencies)
    ).resolves.toBe(posted.url);
    expect(dependencies.posts).toEqual([
      {
        channel: REVIEW_CHANNEL_ID,
        files: [
          "/home/demo/Documents/reports/vertex-ui-review/charts/review.jpg",
        ],
        text: `**Vertex UI review: charts**\nHeader row now uses small uppercase labels.\nDemo (tailnet only): [${DEMO_LABEL}](<${DEMO}>)`,
      },
    ]);
    expect(dependencies.lines).toEqual([
      "/home/demo/Documents/reports/vertex-ui-review/charts/review.jpg 3 boxes",
      `Review posted with image: ${posted.url}`,
    ]);
  });

  it("stops after the image with --no-post", async () => {
    const dependencies = fakeDependencies();
    await expect(
      runReview(
        parseReviewArgs(
          [
            ...BASE_ARGS,
            "--no-post",
            "--out=/h/Documents/reports/vertex-ui-review/x/r.jpg",
          ],
          "/h"
        ),
        dependencies
      )
    ).resolves.toBe("/h/Documents/reports/vertex-ui-review/x/r.jpg");
    expect(dependencies.posts).toEqual([]);
  });

  it("rejects an empty caption and a post without an image", async () => {
    const options = parseReviewArgs(BASE_ARGS, "/h");
    await expect(
      runReview(options, fakeDependencies({ readText: async () => "  \n" }))
    ).rejects.toThrow("caption file is empty");
    await expect(
      runReview(
        options,
        fakeDependencies({ getJson: async () => ({ messages: [] }) })
      )
    ).rejects.toThrow("read-back shows no image");
  });
});

describe("createReviewDependencies", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "vertex-ui-review-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  it("reads files, makes folders, runs the stack script and calls the bot", async () => {
    const script = join(directory, "stack.py");
    await writeFile(script, "import sys\nprint(' '.join(sys.argv[1:]))\n");
    const caption = join(directory, "caption.txt");
    await writeFile(caption, "text");
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ init, url: String(input) });
      return Response.json({ ok: true });
    };
    const log = vi.fn();
    const dependencies = createReviewDependencies(script, log, fetchImpl);
    await expect(dependencies.readText(caption)).resolves.toBe("text");
    await dependencies.makeDirectory(join(directory, "a/b"));
    expect((await stat(join(directory, "a/b"))).isDirectory()).toBe(true);
    await expect(
      dependencies.stack("b.png", "a.png", "o.jpg", "T", "C")
    ).resolves.toBe("b.png a.png o.jpg T C\n");
    await expect(
      dependencies.postJson("/post", { channel: "c", text: "t" })
    ).resolves.toEqual({ ok: true });
    await expect(dependencies.getJson("/messages?channel=c")).resolves.toEqual({
      ok: true,
    });
    expect(requests).toEqual([
      {
        init: {
          body: '{"channel":"c","text":"t"}',
          headers: { "content-type": "application/json" },
          method: "POST",
        },
        url: `${BOT_ORIGIN}/post`,
      },
      { init: undefined, url: `${BOT_ORIGIN}/messages?channel=c` },
    ]);
    dependencies.log("x");
    expect(log).toHaveBeenCalledWith("x");
  });
});

describe("runReviewEntrypoint", () => {
  const run = async (argv: string[], fetchImpl: typeof fetch) => {
    const exitState: { exitCode?: number | string | null } = {};
    const out: string[] = [];
    const err: string[] = [];
    await runReviewEntrypoint({
      argv: ["bun", "review.ts", ...argv],
      exitState,
      fetchImpl,
      home: "/h",
      isMain: true,
      stackScript: "/no/such/stack.py",
      stderr: { write: (text) => err.push(text) },
      stdout: { write: (text) => out.push(text) },
    });
    return { code: exitState.exitCode, err, out };
  };

  it("does nothing when imported", async () => {
    const write = vi.fn();
    const exitState: { exitCode?: number } = {};
    await runReviewEntrypoint({
      argv: [],
      exitState,
      home: "/h",
      isMain: false,
      stackScript: "/x",
      stderr: { write },
      stdout: { write },
    });
    expect(write).not.toHaveBeenCalled();
    expect(exitState.exitCode).toBeUndefined();
  });

  it("returns 2 for usage errors and 1 for runtime errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await run([], fetchImpl)).toMatchObject({
      code: 2,
      err: ["--page, --before, --after, --caption and --demo are required\n"],
    });
    const failed = await run(BASE_ARGS, fetchImpl);
    expect(failed.code).toBe(1);
    expect(failed.err[0]).toContain("caption.txt");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the posted message URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vertex-ui-review-ok-"));
    const caption = join(directory, "caption.txt");
    await writeFile(caption, "Plain explanation.");
    const script = join(directory, "stack.py");
    await writeFile(script, "print('ok 0 boxes')\n");
    const exitState: { exitCode?: number | string | null } = {};
    const out: string[] = [];
    await runReviewEntrypoint({
      argv: [
        "bun",
        "review.ts",
        "--page=charts",
        `--before=${caption}`,
        `--after=${caption}`,
        `--caption=${caption}`,
        `--demo=${DEMO}`,
      ],
      exitState,
      fetchImpl: async (input) =>
        Response.json(String(input).endsWith("/post") ? posted : readBack),
      home: directory,
      isMain: true,
      stackScript: script,
      stderr: { write: vi.fn() },
      stdout: { write: (text) => out.push(text) },
    });
    await rm(directory, { recursive: true });
    expect(exitState.exitCode).toBe(0);
    expect(out).toEqual([
      "ok 0 boxes\n",
      `Review posted with image: ${posted.url}\n`,
    ]);
  });

  it("reports a non-Error failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vertex-ui-review-throw-"));
    const caption = join(directory, "caption.txt");
    await writeFile(caption, "Plain explanation.");
    const script = join(directory, "stack.py");
    await writeFile(script, "print('ok')\n");
    const exitState: { exitCode?: number | string | null } = {};
    const err: string[] = [];
    await runReviewEntrypoint({
      argv: [
        "bun",
        "review.ts",
        "--page=charts",
        `--before=${caption}`,
        `--after=${caption}`,
        `--caption=${caption}`,
        `--demo=${DEMO}`,
      ],
      exitState,
      fetchImpl: async () => {
        throw "offline";
      },
      home: directory,
      isMain: true,
      stackScript: script,
      stderr: { write: (text) => err.push(text) },
      stdout: { write: vi.fn() },
    });
    await rm(directory, { recursive: true });
    expect({ code: exitState.exitCode, err }).toEqual({
      code: 1,
      err: ["offline\n"],
    });
  });
});
