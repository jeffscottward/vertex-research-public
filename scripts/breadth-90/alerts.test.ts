import { describe, expect, it, vi } from "vitest";

import {
  type AlertContext,
  type AlertIo,
  alertKey,
  composeAlert,
  composeTestAlert,
  deliver,
  sendDiscord,
  sendEmail,
  sendNtfy,
} from "./alerts.ts";
import { readBasket } from "./basket.ts";
import { type BreadthDay, evaluate, type SignalEvent } from "./classifier.ts";

const day = (
  date: string,
  up: number,
  adv: number,
  final = true
): BreadthDay => ({
  adv,
  asOf: "t",
  date,
  decl: 100 - adv,
  dvol: 100 - up,
  final,
  source: "tradingview",
  uvol: up,
});

const basket = readBasket(
  JSON.stringify({
    reportPath: "/r/report.html",
    rulesNote: "no orders",
    summary: "🧺 dip basket",
  })
);
const context = (days: BreadthDay[]): AlertContext => ({
  basket,
  evaluation: evaluate(days),
  sourceLine: "Source: tradingview",
});

const event = (overrides: Partial<SignalEvent>): SignalEvent => ({
  advPct: 91,
  armedOn: "2026-11-05",
  date: "2026-11-09",
  grade: "major",
  kind: "FIRED",
  strict: false,
  tier: "major",
  trigger: "UP_90",
  upPct: 93.2,
  ...overrides,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const io = (overrides: Partial<AlertIo> = {}): AlertIo => ({
  env: {},
  fetch: vi.fn(async () => json(200, { id: "abc" })),
  fileSize: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(900),
  home: "/home/u",
  readText: vi.fn(async () =>
    JSON.stringify({
      enabled: true,
      server: "https://ntfy.sh",
      topic: "omp-secret",
    })
  ),
  run: vi.fn(async () => ({ code: 0, stderr: "" })),
  ...overrides,
});

describe("alert copy", () => {
  const ctx = context([
    day("2026-11-05", 16, 15),
    day("2026-11-06", 55, 55, false),
  ]);

  it("FIRED is the loudest all-channel copy with the basket and grade", () => {
    const alert = composeAlert(event({}), ctx);
    expect(alert.key).toBe("FIRED:2026-11-09:major");
    expect(alert.title).toContain("🚨🟢 NOW'S THE TIME TO BUY THE DIP");
    expect(alert.priority).toBe(5);
    expect(alert.tags).toEqual(["rotating_light", "rocket", "moneybag"]);
    expect(alert.channels).toEqual(["ntfy", "email", "discord"]);
    expect(alert.body).toContain("🏆 Grade MAJOR");
    expect(alert.body).toContain("📄 Report: /r/report.html");
    expect(alert.body).toContain("a 90% up-volume day");
  });

  it("volume-only and back-to-back copy name Desmond rule 7 and the trigger", () => {
    const alert = composeAlert(
      event({
        grade: "volume-only",
        strict: true,
        tier: "volume-only",
        trigger: "UP_80_X2",
      }),
      ctx
    );
    expect(alert.body).toContain("Desmond rule 7");
    expect(alert.body).toContain("back-to-back 80% up-volume days");
    expect(alert.body).toContain("STRICT");
  });

  it("FORMING is all-channel priority 5 and says act before the close", () => {
    const alert = composeAlert(event({ advPct: null, kind: "FORMING" }), ctx);
    expect(alert.title).toContain("FORMING");
    expect(alert.title).toContain("ACT BEFORE THE CLOSE");
    expect(alert.body).toContain("advancers n/a");
    expect(alert.priority).toBe(5);
    expect(alert.channels).toHaveLength(3);
  });

  it("THRUST is a priority 4 notice, not the buy-the-dip copy", () => {
    const alert = composeAlert(
      event({ armedOn: null, grade: "volume-only", kind: "THRUST" }),
      ctx
    );
    expect(alert.priority).toBe(4);
    expect(alert.title).not.toContain("BUY THE DIP");
    expect(alert.body).toContain("not the buy-the-dip signal");
  });

  it("ARMED goes to Discord and ntfy only at default priority, with no basket", () => {
    const standard = composeAlert(
      event({
        grade: null,
        kind: "ARMED",
        tier: "standard",
        trigger: null,
        upPct: 16.37,
      }),
      ctx
    );
    expect(standard.channels).toEqual(["discord", "ntfy"]);
    expect(standard.priority).toBe(3);
    expect(standard.title).toContain("83.6% down volume");
    expect(standard.body).toContain("An 80% down-volume day");
    expect(standard.body).not.toContain("Report:");
    const strict = composeAlert(
      event({ kind: "ARMED", strict: true, tier: "strict", upPct: 7 }),
      ctx
    );
    expect(strict.title).toContain("(STRICT)");
    expect(strict.body).toContain("A 90% down-volume day");
  });

  it("names arming fallback and the alert key", () => {
    expect(composeAlert(event({ armedOn: null }), ctx).body).toContain(
      "down day of n/a"
    );
    expect(alertKey(event({ kind: "ARMED", tier: "strict" }))).toBe(
      "ARMED:2026-11-09:strict"
    );
  });

  it("the test alert is clearly labelled and reports the state", () => {
    const alert = composeTestAlert(ctx, "2026-11-06T20:45:00Z");
    expect(alert.title.startsWith("🧪 TEST")).toBe(true);
    expect(alert.body).toContain("NO SIGNAL FIRED");
    expect(alert.body).toContain(
      "State: ARMED (armed by 2026-11-05, 30 sessions left)"
    );
    expect(alert.body).toContain("intraday");
    const strict = composeTestAlert(context([day("2026-11-05", 8, 8)]), "x");
    expect(strict.body).toContain(", strict,");
    expect(strict.body).toContain("close");
    const empty = composeTestAlert(context([]), "x");
    expect(empty.body).toContain("No session data yet.");
    expect(empty.body).toContain("State: IDLE.");
  });
});

describe("channels", () => {
  const alert = composeTestAlert(context([]), "x");

  it("ntfy publishes JSON to the configured server and returns the message id", async () => {
    const fake = io();
    expect(await sendNtfy(fake, alert)).toEqual({
      channel: "ntfy",
      detail: "HTTP 200 id=abc",
      ok: true,
    });
    expect(fake.readText).toHaveBeenCalledWith(
      "/home/u/.config/omp-notify/ntfy.json"
    );
    const [url, init] = vi.mocked(fake.fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://ntfy.sh");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      priority: 3,
      tags: ["test_tube"],
      topic: "omp-secret",
    });
  });

  it("ntfy fails closed on missing, invalid or disabled config and on a reply without id", async () => {
    expect(
      (await sendNtfy(io({ readText: async () => null }), alert)).detail
    ).toBe("ntfy config missing or invalid");
    expect(
      (
        await sendNtfy(
          io({
            env: { BREADTH90_NTFY_CONFIG: "/c.json" },
            readText: async () => "{}",
          }),
          alert
        )
      ).ok
    ).toBe(false);
    const disabled = io({
      readText: async () =>
        JSON.stringify({
          enabled: false,
          server: "https://ntfy.sh",
          topic: "t",
        }),
    });
    expect((await sendNtfy(disabled, alert)).detail).toBe(
      "ntfy disabled in config"
    );
    const noId = await sendNtfy(
      io({ fetch: async () => new Response("nope", { status: 500 }) }),
      alert
    );
    expect(noId).toEqual({
      channel: "ntfy",
      detail: "HTTP 500 (no message id)",
      ok: false,
    });
  });

  it("email sends nothing without a recipient", async () => {
    for (const env of [{}, { BREADTH90_EMAIL_TO: "  " }]) {
      const fake = io({ env });
      expect(await sendEmail(fake, alert, "/state")).toEqual({
        channel: "email",
        detail: "BREADTH90_EMAIL_TO is not set",
        ok: false,
      });
      expect(fake.run).not.toHaveBeenCalled();
    }
  });

  it("email runs mutt with a local sent copy and reports its growth", async () => {
    const fake = io({ env: { BREADTH90_EMAIL_TO: "owner@example.com" } });
    const result = await sendEmail(fake, alert, "/state");
    expect(result).toEqual({
      channel: "email",
      detail: "mutt exit 0, sent copy +900 bytes in /state/sent.mbox",
      ok: true,
    });
    expect(fake.run).toHaveBeenCalledWith(
      "mutt",
      [
        "-e",
        "set copy=yes",
        "-e",
        "set record=/state/sent.mbox",
        "-s",
        alert.title,
        "--",
        "owner@example.com",
      ],
      `${alert.body}\n`
    );
  });

  it("email reports a failed exit and a missing sent copy", async () => {
    const fake = io({
      env: { BREADTH90_EMAIL_TO: "a@b.c", BREADTH90_MUTT: "/usr/bin/mutt" },
      fileSize: async () => 10,
      run: async () => ({ code: 1, stderr: " smtp refused \n" }),
    });
    expect(await sendEmail(fake, alert, "/s")).toEqual({
      channel: "email",
      detail: "/usr/bin/mutt exit 1, no sent copy: smtp refused",
      ok: false,
    });
  });

  it("Discord posts urgent text to #trading-alerts and reports the message id", async () => {
    const fake = io({
      fetch: vi.fn(async () =>
        json(200, {
          channel: "trading-alerts",
          id: "42",
          messages: [{}],
          ok: true,
        })
      ),
    });
    expect(await sendDiscord(fake, alert)).toEqual({
      channel: "discord",
      detail: "HTTP 200 ok channel=trading-alerts id=42",
      ok: true,
    });
    const [url, init] = vi.mocked(fake.fetch).mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:47821/post");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      channel: "trading-alerts",
      urgent: true,
    });
    const bare = io({ fetch: async () => json(200, { ok: true }) });
    expect((await sendDiscord(bare, alert)).detail).toBe("HTTP 200 ok");
  });

  it("Discord reports a refused post", async () => {
    const fake = io({
      env: {
        BREADTH90_DISCORD_CHANNEL: "c",
        BREADTH90_DISCORD_URL: "http://x/post",
      },
      fetch: async () => json(400, { error: "unknown channel" }),
    });
    expect(await sendDiscord(fake, alert)).toEqual({
      channel: "discord",
      detail: "HTTP 400 (not ok)",
      ok: false,
    });
    const html = io({
      fetch: async () => new Response("<html>", { status: 502 }),
    });
    expect((await sendDiscord(html, alert)).detail).toBe("HTTP 502 (not ok)");
  });

  it("deliver sends to the alert's channels and turns a throw into a failed result", async () => {
    const fake = io({
      env: { BREADTH90_EMAIL_TO: "owner@example.com" },
      fetch: vi.fn(async (url: string) => {
        if (url.includes("47821")) {
          throw new Error("connection refused");
        }
        return json(200, { id: "n1" });
      }),
    });
    const results = await deliver(fake, alert, "/s");
    expect(results.map((r) => `${r.channel}:${r.ok}`)).toEqual([
      "ntfy:true",
      "email:true",
      "discord:false",
    ]);
    expect(results[2]?.detail).toBe("error: connection refused");
    const only = await deliver(io(), alert, "/s", ["ntfy"]);
    expect(only).toHaveLength(1);
  });
});
