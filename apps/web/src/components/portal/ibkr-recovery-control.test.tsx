// @vitest-environment jsdom
import type {
  IbkrRecoveryRequest,
  IbkrRecoveryStatusOutput,
} from "@darkfactory/api";
import { RECOVERY_CONFIRMATION } from "@darkfactory/shared/vertex";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { IbkrRecoveryGateway } from "./ibkr-recovery-client.ts";
import {
  createIbkrRecoveryGateway,
  createBrowserIbkrRecoveryGateway,
} from "./ibkr-recovery-client.ts";
import {
  RECENT_RESULT_MS,
  pollIntervalMs,
  recoveryView,
} from "./ibkr-recovery-model.ts";
import { AccountGlance } from "./account-glance.tsx";
import { fixtureSnapshot } from "./portfolio-monitor-fixture.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

const memory = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => memory.clear(),
    getItem: (name: string) => memory.get(name) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (name: string) => memory.delete(name),
    setItem: (name: string, value: string) => memory.set(name, String(value)),
  },
});

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  memory.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await flush();
  });
  return container;
};

const run = (action: () => void) =>
  act(async () => {
    action();
    await flush();
  });

const NOW = Date.parse("2026-10-28T15:00:00.000Z");

const request = (
  overrides: Partial<IbkrRecoveryRequest> = {}
): IbkrRecoveryRequest => ({
  requestId: "req-00000001",
  requestedAt: "2026-10-28T14:58:00Z",
  updatedAt: "2026-10-28T14:58:30Z",
  finishedAt: null,
  state: "waiting-for-approval",
  detail: "",
  scriptRunning: true,
  requestedByYou: true,
  recheckAt: null,
  recheck: null,
  ...overrides,
});

const status = (
  overrides: Partial<IbkrRecoveryStatusOutput> = {}
): IbkrRecoveryStatusOutput => ({
  gateway: {
    loginState: "logged-out",
    needsLogin: true,
    since: "2026-10-28T14:50:00Z",
    reason: "2fa-timeout",
    feedsMissing: false,
  },
  request: null,
  cooldownUntil: null,
  canRequest: true,
  checkedAt: "2026-10-28T15:00:00.000Z",
  ...overrides,
});

const loggedIn = status({
  gateway: {
    loginState: "logged-in",
    needsLogin: false,
    since: "2026-10-28T14:00:00Z",
    reason: "logged-in",
    feedsMissing: false,
  },
  canRequest: false,
});

type Result =
  | IbkrRecoveryStatusOutput
  | Readonly<{ code: string; message: string }>;

const gatewayOf = (...results: Result[]) => {
  let call = 0;
  const statusFn = vi.fn(async () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    if (result === undefined || !("gateway" in result)) throw result;
    return result;
  });
  const requestFn = vi.fn(async () => ({
    outcome: "started" as const,
    request: request({ state: "requested" }),
  }));
  return {
    status: statusFn,
    request: requestFn,
  } satisfies IbkrRecoveryGateway;
};

const portfolio = () => ({ snapshot: vi.fn(async () => fixtureSnapshot()) });

const monitor = (gateway: IbkrRecoveryGateway, configured = true) => (
  <AccountGlance gateway={portfolio()} recovery={{ configured, gateway }} />
);

const sendButton = () =>
  document.querySelector<HTMLButtonElement>("[data-ibkr-recovery-button]");

const buttonNamed = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label
  );
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const text = () => document.body.textContent ?? "";

describe("recoveryView", () => {
  it("shows the button only for logged-out and stopped gateways", () => {
    for (const loginState of [
      "logged-in",
      "awaiting-2fa",
      "starting",
      "unknown",
    ] as const) {
      const view = recoveryView(
        status({
          gateway: {
            loginState,
            needsLogin: false,
            since: null,
            reason: "x",
            feedsMissing: false,
          },
          canRequest: false,
        }),
        NOW
      );
      expect(view.button).toBeNull();
      expect(view.badge === null).toBe(loginState !== "awaiting-2fa");
    }
    expect(recoveryView(status(), NOW)).toMatchObject({
      badge: { label: "IBKR login: logged out", tone: "destructive" },
      button: { enabled: true, hint: null },
      progress: null,
    });
    return expect(
      recoveryView(
        status({
          gateway: {
            loginState: "stopped",
            needsLogin: true,
            since: null,
            reason: "container-not-running",
            feedsMissing: false,
          },
        }),
        NOW
      ).badge?.label
    ).toBe("IBKR login: gateway stopped");
  });

  it("shows the button for a logged-in gateway with missing account feeds", () => {
    const feeds = (loginState: "logged-in" | "awaiting-2fa") =>
      recoveryView(
        status({
          gateway: {
            feedsMissing: true,
            loginState,
            needsLogin: false,
            reason: "x",
            since: null,
          },
        }),
        NOW
      );
    expect(feeds("logged-in")).toMatchObject({
      badge: { label: "IBKR account feeds missing", tone: "destructive" },
      button: { enabled: true, hint: null },
    });
    return expect(feeds("awaiting-2fa").button).toBeNull();
  });

  it("shows the scheduled re-check and keeps a failed re-check visible", () => {
    expect(
      recoveryView(
        status({ request: request({ recheckAt: "2026-10-28T15:13:00Z" }) }),
        NOW
      ).progress?.recheck
    ).toMatch(/^Auth re-check at \d\d:\d\d:\d\d$/);
    const failed = request({
      finishedAt: "2026-10-28T14:00:00Z",
      recheck: {
        at: "2026-10-28T14:13:00Z",
        detail: "not authenticated (login logged-out, account feeds missing)",
        ok: false,
      },
      recheckAt: "2026-10-28T14:13:00Z",
      scriptRunning: false,
      state: "timed-out",
    });
    const late = Date.parse("2026-10-28T14:00:00Z") + RECENT_RESULT_MS + 1;
    expect(
      recoveryView(status({ request: failed }), late).progress?.recheck
    ).toMatch(
      /^Re-check at .+: not authenticated \(login logged-out, account feeds missing\)$/
    );
    return expect(
      recoveryView(
        status({
          request: {
            ...failed,
            recheck: { at: "2026-10-28T14:13:00Z", detail: "ok", ok: true },
          },
        }),
        late
      ).progress
    ).toBeNull();
  });

  it("explains a disabled button", () => {
    expect(
      recoveryView(
        status({ canRequest: false, cooldownUntil: "2026-10-28T15:10:00Z" }),
        NOW
      ).button?.hint
    ).toMatch(/^Next request possible at \d\d:\d\d:\d\d\.$/);
    expect(
      recoveryView(status({ canRequest: false, request: request() }), NOW)
        .button?.hint
    ).toBe("A 2FA request is in progress.");
    return expect(
      recoveryView(status({ canRequest: false }), NOW).button?.hint
    ).toBeNull();
  });

  it("describes each request state and hides old results", () => {
    const labels = (
      [
        ["requested", "2FA request sent to the VPS"],
        ["waiting-for-approval", "Waiting for approval on your phone"],
        ["verifying", "Login completed; checking the account snapshot"],
        ["logged-in", "Logged in; account snapshot OK"],
        ["timed-out", "Timed out; no approval was received"],
        ["failed", "Failed"],
      ] as const
    ).map(([state, label]) => {
      const view = recoveryView(
        status({ request: request({ state, detail: "detail text" }) }),
        NOW
      );
      expect(view.progress?.label).toBe(label);
      return view.progress?.detail;
    });
    expect(labels).toEqual([
      null,
      "detail text",
      "detail text",
      null,
      "detail text",
      "detail text",
    ]);
    const finished = request({
      state: "failed",
      detail: " ",
      scriptRunning: false,
      finishedAt: "2026-10-28T14:59:00Z",
      requestedByYou: false,
    });
    const recent = recoveryView(status({ request: finished }), NOW).progress;
    expect(recent?.detail).toBeNull();
    expect(recent?.active).toBe(false);
    expect(recent?.meta).toMatch(
      /^Requested by another operator at .+ · finished .+$/
    );
    return expect(
      recoveryView(
        status({ request: finished }),
        Date.parse("2026-10-28T14:59:00Z") + RECENT_RESULT_MS + 1
      ).progress
    ).toBeNull();
  });

  it("polls faster while a request moves", () => {
    expect(pollIntervalMs(null)).toBe(15_000);
    expect(pollIntervalMs(status({ request: request() }))).toBe(3000);
    return expect(
      pollIntervalMs(
        status({
          request: request({
            state: "logged-in",
            scriptRunning: false,
            finishedAt: "2026-10-28T14:59:00Z",
          }),
        })
      )
    ).toBe(15_000);
  });
});

describe("IbkrRecoveryControl in the Mission control account card", () => {
  it("sends nothing and shows nothing when not configured", async () => {
    const gateway = gatewayOf(status());
    await mount(monitor(gateway, false));
    expect(gateway.status).not.toHaveBeenCalled();
    return expect(sendButton()).toBeNull();
  });

  it("renders the auth re-check line", async () => {
    await mount(
      monitor(
        gatewayOf(
          status({
            canRequest: false,
            request: request({ recheckAt: "2026-10-28T15:13:00Z" }),
          })
        )
      )
    );
    return expect(
      document.querySelector("[data-ibkr-recovery-recheck]")?.textContent
    ).toMatch(/^Auth re-check at /);
  });

  it("hides the button while the gateway is logged in", async () => {
    const gateway = gatewayOf(loggedIn);
    await mount(monitor(gateway));
    expect(gateway.status).toHaveBeenCalledOnce();
    expect(sendButton()).toBeNull();
    return expect(text()).not.toContain("IBKR login:");
  });

  it("warns that a feeds-missing request restarts a logged-in gateway", async () => {
    const feeds = status({
      gateway: {
        loginState: "logged-in",
        needsLogin: false,
        since: null,
        reason: "logged-in",
        feedsMissing: true,
      },
    });
    await mount(monitor(gatewayOf(feeds)));
    await run(() => sendButton()?.click());
    return expect(
      document.querySelector("[data-ibkr-recovery-feeds-warning]")?.textContent
    ).toContain("ends the current session");
  });

  it("asks for the recovery statement before it sends one request", async () => {
    const gateway = gatewayOf(
      status(),
      status({ request: request({ state: "requested" }), canRequest: false })
    );
    await mount(monitor(gateway));
    expect(text()).toContain("IBKR login: logged out");
    const send = sendButton();
    expect(send?.textContent).toContain("Send IBKR 2FA request");
    await run(() => send?.click());
    const dialog = document.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain(RECOVERY_CONFIRMATION);
    expect(
      document.querySelector("[data-ibkr-recovery-feeds-warning]")
    ).toBeNull();
    expect(
      document.querySelector("[data-recovery-statement]")?.textContent
    ).toBe(RECOVERY_CONFIRMATION);
    expect(document.activeElement?.textContent).toBe("Confirm and send");
    expect(gateway.request).not.toHaveBeenCalled();
    await run(() => buttonNamed("Confirm and send").click());
    expect(gateway.request).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    expect(
      document.querySelector("[data-ibkr-recovery-state]")?.textContent
    ).toContain("2FA request sent to the VPS");
    return expect(sendButton()?.disabled).toBe(true);
  });

  it("closes the dialog with Cancel or Escape and returns focus", async () => {
    const gateway = gatewayOf(status());
    await mount(monitor(gateway));
    await run(() => sendButton()?.click());
    await run(() => buttonNamed("Cancel").click());
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(document.activeElement).toBe(sendButton());
    await run(() => sendButton()?.click());
    const dialog = document.querySelector("[role=alertdialog]");
    await run(() =>
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(document.querySelector("[role=alertdialog]")).not.toBeNull();
    await run(() =>
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    return expect(gateway.request).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the reason when the server refuses", async () => {
    const gateway = gatewayOf(status());
    gateway.request.mockRejectedValueOnce({
      code: "RATE_LIMITED",
      message: "IBKR 2FA requests are limited to one per 15 minutes",
    });
    await mount(monitor(gateway));
    await run(() => sendButton()?.click());
    await run(() => buttonNamed("Confirm and send").click());
    expect(
      document.querySelector("[role=alertdialog] [role=alert]")?.textContent
    ).toBe(
      "The request was not sent (RATE_LIMITED: IBKR 2FA requests are limited to one per 15 minutes)."
    );
    return expect(document.querySelector("[role=alertdialog]")).not.toBeNull();
  });

  it("says the outcome is unknown when the VPS did not answer", async () => {
    const gateway = gatewayOf(status());
    gateway.request.mockRejectedValueOnce({
      code: "UNAVAILABLE",
      message: "IBKR recovery request timed out",
    });
    await mount(monitor(gateway));
    await run(() => sendButton()?.click());
    await run(() => buttonNamed("Confirm and send").click());
    return expect(
      document.querySelector("[role=alertdialog] [role=alert]")?.textContent
    ).toBe(
      "No answer from the VPS (UNAVAILABLE: IBKR recovery request timed out). The request may have been sent; check the progress below."
    );
  });

  it("disables the button during the cooldown and explains why", async () => {
    const gateway = gatewayOf(
      status({ canRequest: false, cooldownUntil: "2026-10-28T15:10:00Z" })
    );
    await mount(monitor(gateway));
    expect(sendButton()?.disabled).toBe(true);
    expect(sendButton()?.getAttribute("aria-describedby")).toBe(
      "ibkr-recovery-hint"
    );
    return expect(
      document.getElementById("ibkr-recovery-hint")?.textContent
    ).toMatch(/^Next request possible at /);
  });

  it("hides itself for operators-only failures and stops polling", async () => {
    vi.useFakeTimers();
    const gateway = gatewayOf({ code: "FORBIDDEN", message: "Forbidden" });
    await mount(monitor(gateway));
    expect(document.querySelector("[data-ibkr-recovery]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await flush();
    });
    return expect(gateway.status).toHaveBeenCalledOnce();
  });

  it("reports an unavailable service and polls again", async () => {
    vi.useFakeTimers();
    const gateway = gatewayOf(
      { code: "UNAVAILABLE", message: "IBKR recovery service unavailable" },
      status({ request: request(), canRequest: false }),
      status({
        request: request({ detail: "IBC reported login", state: "verifying" }),
        canRequest: false,
      })
    );
    await mount(monitor(gateway));
    expect(
      document.querySelector("[data-ibkr-recovery-failure]")?.textContent
    ).toBe(
      "IBKR login state unavailable (UNAVAILABLE: IBKR recovery service unavailable)."
    );
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await flush();
    });
    expect(
      document.querySelector("[data-ibkr-recovery-state]")?.textContent
    ).toContain("Waiting for approval on your phone");
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flush();
    });
    expect(
      document.querySelector("[data-ibkr-recovery-state]")?.textContent
    ).toContain("Login completed; checking the account snapshot");
    expect(text()).toContain("IBC reported login");
    return expect(gateway.status).toHaveBeenCalledTimes(3);
  });

  it("uses the browser client by default and sends nothing while not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await mount(
      <AccountGlance gateway={portfolio()} recovery={{ configured: false }} />
    );
    expect(sendButton()).toBeNull();
    return expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores answers that arrive after unmount", async () => {
    let answer: ((value: IbkrRecoveryStatusOutput) => void) | undefined;
    let refuse: ((reason: unknown) => void) | undefined;
    const pending = {
      status: vi
        .fn<() => Promise<IbkrRecoveryStatusOutput>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              refuse = reject;
            })
        ),
      request: vi.fn(),
    };
    await mount(monitor(pending));
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      answer?.(status());
      await flush();
    });
    await mount(monitor(pending));
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      refuse?.({ code: "UNAVAILABLE", message: "down" });
      await flush();
    });
    return expect(pending.status).toHaveBeenCalledTimes(2);
  });

  it("shows nothing before the first status arrives", async () => {
    const gateway = {
      status: vi.fn(
        () => new Promise<IbkrRecoveryStatusOutput>(() => undefined)
      ),
      request: vi.fn(),
    };
    await mount(monitor(gateway));
    expect(document.querySelector("[data-ibkr-recovery]")).toBeNull();
    return expect(sendButton()).toBeNull();
  });
});

describe("ibkr recovery client", () => {
  it("sends the exact statement through the oRPC client", async () => {
    const statusFn = vi.fn(async () => status());
    const requestFn = vi.fn(async () => ({
      outcome: "started" as const,
      request: request(),
    }));
    const gateway = createIbkrRecoveryGateway({
      ibkrRecovery: { status: statusFn, request: requestFn },
    } as unknown as Parameters<typeof createIbkrRecoveryGateway>[0]);
    await gateway.status();
    await gateway.request();
    expect(statusFn).toHaveBeenCalledWith({});
    return expect(requestFn).toHaveBeenCalledWith({
      confirmation: RECOVERY_CONFIRMATION,
    });
  });

  it("creates the browser client lazily on the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: status() }));
    const gateway = createBrowserIbkrRecoveryGateway();
    expect(fetchSpy).not.toHaveBeenCalled();
    await gateway.status().catch(() => undefined);
    await gateway.request().catch(() => undefined);
    return expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
