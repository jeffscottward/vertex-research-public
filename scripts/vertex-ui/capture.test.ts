import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LAB_NOW_ISO } from "../../apps/web/src/lab/fixtures/core.ts";
import {
  type CaptureBrowser,
  type CaptureDependencies,
  type CapturePage,
  CaptureUsageError,
  type ChromiumLauncher,
  createCaptureDependencies,
  entryIdsFromIndex,
  entryUrl,
  LAB_CLOCK_ISO,
  parseCaptureArgs,
  runCapture,
  runCaptureEntrypoint,
  viewportFor,
} from "./capture.ts";

const fakePage = (): CapturePage & { visited: string[] } => {
  const visited: string[] = [];
  return {
    close: async () => undefined,
    goto: async (url) => {
      visited.push(url);
    },
    prepare: async () => undefined,
    screenshot: async () => undefined,
    settle: async () => undefined,
    visited,
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
  };
};

const fakeDependencies = (
  indexHtml = ""
): CaptureDependencies & {
  pages: ReturnType<typeof fakePage>[];
  newPage: ReturnType<typeof vi.fn>;
  closed: () => boolean;
  lines: string[];
} => {
  const pages: ReturnType<typeof fakePage>[] = [];
  let closed = false;
  const lines: string[] = [];
  const newPage = vi.fn(async () => {
    const page = fakePage();
    pages.push(page);
    return page;
  });
  const browser: CaptureBrowser = {
    close: async () => {
      closed = true;
    },
    newPage,
  };
  return {
    closed: () => closed,
    fetchText: async () => indexHtml,
    launch: async () => browser,
    lines,
    log: (line) => lines.push(line),
    makeDirectory: async () => undefined,
    newPage,
    pages,
  };
};

describe("parseCaptureArgs", () => {
  it("applies defaults", () => {
    expect(
      parseCaptureArgs([
        "--base",
        "https://demo.example.ts.net:8450/lab",
        "--entry",
        "charts",
        "--out",
        "/tmp/x",
      ])
    ).toEqual({
      base: "https://demo.example.ts.net:8450",
      entry: "charts",
      name: "capture",
      out: "/tmp/x",
      query: "",
      settleMs: 1500,
      theme: "dark",
      widths: [1440, 820, 375],
    });
  });

  it("reads every option", () => {
    expect(
      parseCaptureArgs([
        "--base=http://127.0.0.1:9450",
        "--entry=all",
        "--out=/tmp/y",
        "--widths=1440, 375",
        "--name=before",
        "--query=?symbol=NVDA",
        "--theme=light",
        "--settle-ms=0",
      ])
    ).toMatchObject({
      entry: "all",
      name: "before",
      query: "symbol=NVDA",
      settleMs: 0,
      theme: "light",
      widths: [1440, 375],
    });
  });

  it.each([
    [["--entry", "charts", "--out", "/tmp"], "required"],
    [["--base", "nope", "--entry", "c", "--out", "/tmp"], "not a URL"],
    [["--base", "ftp://x", "--entry", "c", "--out", "/tmp"], "http or https"],
    [["--base", "http://x", "--entry", "Bad", "--out", "/tmp"], "lab entry id"],
    [
      ["--base", "http://x", "--entry", "c", "--out", "/tmp", "--name", "A"],
      "lowercase",
    ],
    [
      [
        "--base",
        "http://x",
        "--entry",
        "c",
        "--out",
        "/tmp",
        "--theme",
        "blue",
      ],
      "dark or light",
    ],
    [
      [
        "--base",
        "http://x",
        "--entry",
        "c",
        "--out",
        "/tmp",
        "--widths",
        "100",
      ],
      "320 to 3840",
    ],
    [
      [
        "--base",
        "http://x",
        "--entry",
        "c",
        "--out",
        "/tmp",
        "--settle-ms",
        "x",
      ],
      "0 to 60000",
    ],
  ])("rejects bad arguments (%#)", (argv, message) => {
    expect(() => parseCaptureArgs(argv)).toThrow(CaptureUsageError);
    expect(() => parseCaptureArgs(argv)).toThrow(message);
  });
});

describe("capture helpers", () => {
  it("uses the owner device sizes", () => {
    expect(viewportFor(375)).toEqual({ height: 812, width: 375 });
    expect(viewportFor(820)).toEqual({ height: 1180, width: 820 });
    expect(viewportFor(1440)).toEqual({ height: 900, width: 1440 });
    expect(viewportFor(1280)).toEqual({ height: 900, width: 1280 });
  });

  it("builds entry URLs with the theme", () => {
    expect(entryUrl("http://h:1", "charts", "symbol=NVDA", "dark")).toBe(
      "http://h:1/lab/charts?symbol=NVDA&theme=dark"
    );
    expect(entryUrl("http://h:1", "todos", "theme=light", "dark")).toBe(
      "http://h:1/lab/todos?theme=dark"
    );
  });

  it("reads entry ids from the index HTML once each", () => {
    expect(
      entryIdsFromIndex(
        '<a data-lab-entry="dashboard"></a><a data-lab-entry="charts"></a><a data-lab-entry="dashboard"></a>'
      )
    ).toEqual(["dashboard", "charts"]);
  });
});

describe("runCapture", () => {
  it("keeps going after a failed entry and reports every failure", async () => {
    const dependencies = fakeDependencies(
      '<a data-lab-entry="dashboard"></a><a data-lab-entry="charts"></a>'
    );
    dependencies.newPage.mockRejectedValueOnce(new Error("slow\nstack"));
    await expect(
      runCapture(
        parseCaptureArgs([
          "--base=http://h:1",
          "--entry=all",
          "--out=/out",
          "--widths=375",
        ]),
        dependencies
      )
    ).rejects.toThrow("Capture failed for dashboard@375: slow");
    expect(dependencies.lines).toEqual([
      "FAILED dashboard@375",
      "/out/charts/capture-375.png",
    ]);
  });

  it("freezes the page clock at the lab fixture time", () => {
    expect(LAB_CLOCK_ISO).toBe(LAB_NOW_ISO);
  });

  it("captures one entry at every width and closes the browser", async () => {
    const dependencies = fakeDependencies();
    const written = await runCapture(
      parseCaptureArgs([
        "--base=http://h:1",
        "--entry=charts",
        "--out=/out",
        "--widths=1440,375",
        "--query=symbol=NVDA",
      ]),
      dependencies
    );
    expect(written).toEqual(["/out/capture-1440.png", "/out/capture-375.png"]);
    expect(dependencies.newPage).toHaveBeenCalledWith({
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { height: 812, width: 375 },
    });
    expect(dependencies.pages[0]?.visited).toEqual([
      "http://h:1/lab/charts?symbol=NVDA&theme=dark",
    ]);
    expect(dependencies.lines).toEqual(written);
    expect(dependencies.closed()).toBe(true);
  });

  it("captures every index entry into its own folder", async () => {
    const dependencies = fakeDependencies(
      '<a data-lab-entry="dashboard"></a><a data-lab-entry="charts"></a>'
    );
    const written = await runCapture(
      parseCaptureArgs([
        "--base=http://h:1",
        "--entry=all",
        "--out=/out",
        "--widths=375",
        "--name=before",
      ]),
      dependencies
    );
    expect(written).toEqual([
      "/out/dashboard/before-375.png",
      "/out/charts/before-375.png",
    ]);
  });

  it("refuses an empty index and still closes the browser on failure", async () => {
    await expect(
      runCapture(
        parseCaptureArgs(["--base=http://h:1", "--entry=all", "--out=/o"]),
        fakeDependencies("")
      )
    ).rejects.toThrow("no entries");
    const dependencies = fakeDependencies();
    dependencies.newPage.mockRejectedValueOnce(new Error("crash"));
    await expect(
      runCapture(
        parseCaptureArgs(["--base=http://h:1", "--entry=c", "--out=/o"]),
        dependencies
      )
    ).rejects.toThrow("Capture failed for c@1440: crash");
    expect(dependencies.closed()).toBe(true);
  });
});

type Call = string[];

const fakeLauncher = (calls: Call, fail = false): ChromiumLauncher => ({
  launch: async (options) => {
    calls.push(`launch:${String(options.headless)}`);
    return {
      close: async () => {
        calls.push("browser-close");
      },
      newPage: async (pageOptions) => {
        if (fail) throw "boom";
        calls.push(
          `page:${pageOptions.viewport.width}:${String(pageOptions.ignoreHTTPSErrors)}`
        );
        let lastUrl = "";
        return {
          addStyleTag: async (style) => {
            calls.push(`style:${style.content}`);
          },
          clock: {
            setFixedTime: async (time) => {
              calls.push(`clock:${time.toISOString()}`);
            },
          },
          close: async () => {
            calls.push("page-close");
          },
          evaluate: async (expression) => {
            calls.push(`eval:${expression}`);
          },
          goto: async (url, gotoOptions) => {
            lastUrl = url;
            calls.push(`goto:${url}:${gotoOptions.waitUntil}`);
          },
          screenshot: async (shot) => {
            calls.push(`shot:${shot.path}`);
          },
          waitForLoadState: async (state) => {
            if (lastUrl.endsWith("/slow")) throw new Error("idle timeout");
            calls.push(`state:${state}`);
          },
          waitForSelector: async (selector) => {
            calls.push(`wait:${selector}`);
          },
          waitForTimeout: async (ms) => {
            calls.push(`sleep:${ms}`);
          },
        };
      },
    };
  },
});

const fakeFetch = async (url: string) =>
  url.endsWith("/bad")
    ? new Response("no", { status: 500 })
    : new Response('<a data-lab-entry="charts"></a>');

describe("createCaptureDependencies", () => {
  it("wraps the Chromium launcher, fetch and mkdir", async () => {
    const calls: Call = [];
    const log = vi.fn();
    const dependencies = createCaptureDependencies(
      log,
      fakeLauncher(calls),
      fakeFetch
    );
    const browser = await dependencies.launch();
    const page = await browser.newPage({
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { height: 812, width: 375 },
    });
    await page.prepare();
    await page.goto("http://h/lab/x");
    await page.goto("http://h/lab/slow");
    await page.waitForSelector("[data-lab-frame]");
    await page.waitForTimeout(5);
    await page.settle();
    await page.screenshot({ fullPage: true, path: "/tmp/a.png" });
    await page.close();
    await browser.close();
    expect(calls).toEqual([
      "launch:true",
      "page:375:true",
      `clock:${LAB_CLOCK_ISO}`,
      "goto:http://h/lab/x:load",
      "state:networkidle",
      "goto:http://h/lab/slow:load",
      "wait:[data-lab-frame]",
      "sleep:5",
      "style:.skip-link{display:none!important}",
      "eval:window.scrollTo(0, 0)",
      "shot:/tmp/a.png",
      "page-close",
      "browser-close",
    ]);
    await expect(dependencies.fetchText("http://h/lab")).resolves.toContain(
      "charts"
    );
    await expect(dependencies.fetchText("http://h/bad")).rejects.toThrow(
      "returned 500"
    );
    const directory = await mkdtemp(join(tmpdir(), "vertex-ui-capture-"));
    await dependencies.makeDirectory(join(directory, "a/b"));
    expect((await stat(join(directory, "a/b"))).isDirectory()).toBe(true);
    await rm(directory, { recursive: true });
    dependencies.log("line");
    expect(log).toHaveBeenCalledWith("line");
  });
});

describe("runCaptureEntrypoint", () => {
  let outDirectory = "";
  beforeAll(async () => {
    outDirectory = await mkdtemp(join(tmpdir(), "vertex-ui-entry-"));
  });
  afterAll(async () => {
    await rm(outDirectory, { recursive: true });
  });
  const run = async (argv: string[], fail = false) => {
    const exitState: { exitCode?: number | string | null } = {};
    const out: string[] = [];
    const err: string[] = [];
    const calls: Call = [];
    await runCaptureEntrypoint({
      argv: ["bun", "capture.ts", ...argv],
      exitState,
      fetchImpl: fakeFetch,
      isMain: true,
      launcher: fakeLauncher(calls, fail),
      stderr: { write: (text) => err.push(text) },
      stdout: { write: (text) => out.push(text) },
    });
    return { calls, code: exitState.exitCode, err, out };
  };

  it("does nothing when imported", async () => {
    const exitState: { exitCode?: number } = {};
    const write = vi.fn();
    await runCaptureEntrypoint({
      argv: [],
      exitState,
      isMain: false,
      stderr: { write },
      stdout: { write },
    });
    expect(write).not.toHaveBeenCalled();
    expect(exitState.exitCode).toBeUndefined();
  });

  it("captures and prints each PNG path", async () => {
    const result = await run([
      "--base=http://h",
      "--entry=all",
      `--out=${outDirectory}`,
      "--widths=375",
      "--settle-ms=0",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `${join(outDirectory, "charts/capture-375.png")}\n`,
    ]);
  });

  it("reports a non-Error failure from the index fetch", async () => {
    const exitState: { exitCode?: number | string | null } = {};
    const err: string[] = [];
    await runCaptureEntrypoint({
      argv: ["bun", "capture.ts", "--base=http://h", "--entry=all", "--out=/o"],
      exitState,
      fetchImpl: async () => {
        throw "offline";
      },
      isMain: true,
      launcher: fakeLauncher([]),
      stderr: { write: (text) => err.push(text) },
      stdout: { write: vi.fn() },
    });
    expect({ code: exitState.exitCode, err }).toEqual({
      code: 1,
      err: ["offline\n"],
    });
  });

  it("sets exit code 2 for usage errors and 1 for runtime errors", async () => {
    expect(await run([])).toMatchObject({
      code: 2,
      err: ["--base, --entry and --out are required\n"],
    });
    expect(
      await run(["--base=http://h", "--entry=c", `--out=${outDirectory}`], true)
    ).toMatchObject({
      code: 1,
      err: ["Capture failed for c@1440: boom; c@820: boom; c@375: boom\n"],
    });
  });
});
