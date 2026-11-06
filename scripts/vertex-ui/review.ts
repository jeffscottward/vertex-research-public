// What: Build one vertical BEFORE/AFTER review image (title, BEFORE on top, AFTER below, dark frame,
// red boxes on changed areas, plain explanation under it) and post it with the demo link to the
// Discord review channel through the bot loopback. Reads the message back to confirm the image.
// Usage: bun scripts/vertex-ui/review.ts --page <name> --before <png> --after <png> --caption <file>
//          --demo <url> [--title <text>] [--out <jpg>] [--channel <id>] [--no-post]
// Image: ~/Documents/reports/vertex-ui-review/<page>/review.jpg by default (never committed).
// The image step runs scripts/vertex-ui/stack.py (Pillow), ported from the owner-approved stack.py.
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

/** Discord 🎨-vertex-ui-review. */
export const REVIEW_CHANNEL_ID = "1567602627884093492";
export const BOT_ORIGIN = "http://127.0.0.1:47821";

export class ReviewUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewUsageError";
  }
}

export type ReviewOptions = Readonly<{
  page: string;
  before: string;
  after: string;
  caption: string;
  demo: string;
  title: string;
  out: string;
  channel: string;
  post: boolean;
}>;

const PAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CHANNEL = /^\d{17,20}$/u;

export const parseReviewArgs = (
  argv: readonly string[],
  home: string
): ReviewOptions => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      after: { type: "string" },
      before: { type: "string" },
      caption: { type: "string" },
      channel: { default: REVIEW_CHANNEL_ID, type: "string" },
      demo: { type: "string" },
      "no-post": { default: false, type: "boolean" },
      out: { type: "string" },
      page: { type: "string" },
      title: { type: "string" },
    },
    strict: true,
  });
  const { page, before, after, caption, demo, title, out, channel } = values;
  if (
    page === undefined ||
    before === undefined ||
    after === undefined ||
    caption === undefined ||
    demo === undefined
  )
    throw new ReviewUsageError(
      "--page, --before, --after, --caption and --demo are required"
    );
  if (!PAGE.test(page))
    throw new ReviewUsageError(`--page must be lowercase words: ${page}`);
  let demoUrl: URL;
  try {
    demoUrl = new URL(demo);
  } catch {
    throw new ReviewUsageError(`--demo is not a URL: ${demo}`);
  }
  if (demoUrl.protocol !== "https:" || !demoUrl.hostname.endsWith(".ts.net"))
    throw new ReviewUsageError(
      "--demo must be an https tailnet (*.ts.net) URL"
    );
  if (!CHANNEL.test(channel))
    throw new ReviewUsageError("--channel must be a Discord channel id");
  // stack.py overwrites --out and the bot posts it: keep it inside the review folder.
  const reviewRoot = join(home, "Documents/reports/vertex-ui-review");
  const output = resolve(out ?? join(reviewRoot, page, "review.jpg"));
  const inside = relative(reviewRoot, output);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    throw new ReviewUsageError(`--out must be a file inside ${reviewRoot}`);
  return {
    after: resolve(after),
    before: resolve(before),
    caption: resolve(caption),
    channel,
    demo: demoUrl.toString(),
    out: output,
    page,
    post: !values["no-post"],
    title: title ?? `Vertex UI review: ${page}`,
  };
};

/** The Discord message text: title, explanation and demo link (under Discord's 2000 limit). */
export const reviewMessage = (
  options: Pick<ReviewOptions, "title" | "demo">,
  caption: string
): string => {
  const head = `**${options.title}**\n`;
  // The label keeps host, port and path: the bot's short link label drops the port.
  const url = new URL(options.demo);
  const label = `${url.host}${url.pathname}${url.search}`;
  const tail = `\nDemo (tailnet only): [${label}](<${options.demo}>)`;
  const room = 1900 - head.length - tail.length;
  const body =
    caption.length > room ? `${caption.slice(0, room - 1)}…` : caption;
  return `${head}${body}${tail}`;
};

export type PostedMessage = Readonly<{ id: string; url: string }>;

export type ReviewDependencies = Readonly<{
  readText: (path: string) => Promise<string>;
  makeDirectory: (path: string) => Promise<unknown>;
  /** Runs stack.py; returns its stdout. */
  stack: (
    before: string,
    after: string,
    out: string,
    title: string,
    caption: string
  ) => Promise<string>;
  postJson: (path: string, body: unknown) => Promise<unknown>;
  getJson: (path: string) => Promise<unknown>;
  log: (line: string) => void;
}>;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, name)
    : undefined;

/** The first message id/url of a bot /post response. */
export const postedMessage = (response: unknown): PostedMessage => {
  const id = field(response, "id");
  const url = field(response, "url");
  if (
    field(response, "ok") !== true ||
    typeof id !== "string" ||
    typeof url !== "string"
  )
    throw new Error(
      `The bot did not post the review: ${JSON.stringify(response)}`
    );
  return { id, url };
};

/** True when GET /messages shows the message with at least one attachment. */
export const hasAttachment = (response: unknown, id: string): boolean => {
  const messages = field(response, "messages");
  if (!Array.isArray(messages)) return false;
  return messages.some((message: unknown) => {
    const attachments = field(message, "attachments");
    return (
      field(message, "id") === id &&
      Array.isArray(attachments) &&
      attachments.length > 0
    );
  });
};

/** Builds the image and (unless --no-post) posts it; returns the message URL or the image path. */
export const runReview = async (
  options: ReviewOptions,
  dependencies: ReviewDependencies
): Promise<string> => {
  const caption = (await dependencies.readText(options.caption)).trim();
  if (caption === "") throw new ReviewUsageError("--caption file is empty");
  await dependencies.makeDirectory(dirname(options.out));
  dependencies.log(
    (
      await dependencies.stack(
        options.before,
        options.after,
        options.out,
        options.title,
        caption
      )
    ).trim()
  );
  if (!options.post) return options.out;
  const posted = postedMessage(
    await dependencies.postJson("/post", {
      channel: options.channel,
      files: [options.out],
      text: reviewMessage(options, caption),
    })
  );
  const readBack = await dependencies.getJson(
    `/messages?channel=${options.channel}&limit=10`
  );
  if (!hasAttachment(readBack, posted.id))
    throw new Error(`Posted ${posted.url}, but the read-back shows no image`);
  dependencies.log(`Review posted with image: ${posted.url}`);
  return posted.url;
};

const run = promisify(execFile);

export const createReviewDependencies = (
  stackScript: string,
  log: (line: string) => void,
  fetchImpl: typeof fetch
): ReviewDependencies => {
  const json = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetchImpl(`${BOT_ORIGIN}${path}`, init);
    return response.json();
  };
  return {
    getJson: (path) => json(path),
    log,
    makeDirectory: (path) => mkdir(path, { recursive: true }),
    postJson: (path, body) =>
      json(path, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    readText: (path) => readFile(path, "utf8"),
    stack: async (before, after, out, title, caption) =>
      (await run("python3", [stackScript, before, after, out, title, caption]))
        .stdout,
  };
};

export interface OutputStream {
  readonly write: (text: string) => unknown;
}

export type ReviewEntrypoint = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  home: string;
  stackScript: string;
  stdout: OutputStream;
  stderr: OutputStream;
  exitState: { exitCode?: number | string | null | undefined };
  fetchImpl?: typeof fetch;
}>;

/** CLI entry: runs only when this module is the process entry point. */
export const runReviewEntrypoint = async ({
  isMain,
  argv,
  home,
  stackScript,
  stdout,
  stderr,
  exitState,
  fetchImpl = fetch,
}: ReviewEntrypoint): Promise<void> => {
  if (!isMain) return;
  try {
    await runReview(
      parseReviewArgs(argv.slice(2), home),
      createReviewDependencies(
        stackScript,
        (line) => stdout.write(`${line}\n`),
        fetchImpl
      )
    );
    exitState.exitCode = 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exitState.exitCode = error instanceof ReviewUsageError ? 2 : 1;
  }
};

await runReviewEntrypoint({
  argv: process.argv,
  exitState: process,
  home: homedir(),
  isMain: import.meta.main,
  stackScript: join(import.meta.dirname, "stack.py"),
  stderr: process.stderr,
  stdout: process.stdout,
});
