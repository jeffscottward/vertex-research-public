// @vitest-environment jsdom
import {
  NAUTILUS_ARM_STATEMENT,
  type NautilusArmChangeOutput,
  type NautilusArmState,
  type NautilusArmStatusOutput,
} from "@darkfactory/api";
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

import {
  createBrowserNautilusArmGateway,
  createNautilusArmGateway,
  type NautilusArmGateway,
} from "./nautilus-arm-client.ts";
import { AccountGlance } from "./account-glance.tsx";
import { nautilusArmView, reasonProblem } from "./nautilus-arm-model.ts";
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

const REASON = "Owner review done; arm for the open";
const PASSWORD = "correct horse battery";

const armState = (
  overrides: Partial<NautilusArmState> = {}
): NautilusArmState => ({
  armed: false,
  armedAt: null,
  armedBy: null,
  detail: "no_arm_record",
  imageVersion: "1.4.2",
  killSwitchActive: false,
  reason: null,
  state: "disarmed",
  ...overrides,
});

const ARMED = armState({
  armed: true,
  armedAt: "2026-10-30T14:59:00Z",
  armedBy: "operator",
  detail: "armed",
  reason: REASON,
  state: "armed",
});

const status = (
  overrides: Partial<NautilusArmStatusOutput> = {}
): NautilusArmStatusOutput => ({
  arm: armState(),
  armError: null,
  badge: "running-disarmed",
  checkedAt: "2026-10-30T15:00:00.000Z",
  container: { health: "healthy", state: "running" },
  ...overrides,
});

const armedStatus = status({ arm: ARMED, badge: "running-armed" });
const downStatus = status({
  arm: null,
  armError: "not-running",
  badge: "down",
  container: { health: null, state: "exited" },
});

type Result =
  | NautilusArmStatusOutput
  | Readonly<{ code: string; message: string }>;

const change = (action: "arm" | "disarm"): NautilusArmChangeOutput => ({
  action,
  arm: action === "arm" ? ARMED : armState(),
  auditId: "node-audit-1",
});

const gatewayOf = (...results: Result[]) => {
  let call = 0;
  return {
    arm: vi.fn(async () => change("arm")),
    disarm: vi.fn(async () => change("disarm")),
    status: vi.fn(async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      if (result === undefined || !("badge" in result)) throw result;
      return result;
    }),
  } satisfies NautilusArmGateway;
};

const portfolio = () => ({ snapshot: vi.fn(async () => fixtureSnapshot()) });

const monitor = (gateway: NautilusArmGateway, configured = true) => (
  <AccountGlance gateway={portfolio()} nautilus={{ configured, gateway }} />
);

const badge = () => document.querySelector("[data-nautilus-badge]");
// StatusBadge adds a screen-reader "Status:" prefix; the visible text follows it.
const badgeText = () => badge()?.textContent?.replace(/^Status:/u, "");
const armButton = () =>
  document.querySelector<HTMLButtonElement>("[data-nautilus-arm-button]");
const disarmButton = () =>
  document.querySelector<HTMLButtonElement>("[data-nautilus-disarm-button]");
const dialog = () => document.querySelector<HTMLFormElement>("[role=dialog]");
const submit = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === "Arm the node"
  );
const cancel = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === "Cancel"
  );

// React tracks the value property; set it through the native setter, then fire input.
const type = (selector: string, value: string) => {
  const element = document.querySelector<
    HTMLInputElement | HTMLTextAreaElement
  >(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value"
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const fill = (reason = REASON, password = PASSWORD) =>
  run(() => {
    type("#nautilus-arm-reason", reason);
    type("#nautilus-arm-password", password);
  });

describe("nautilusArmView", () => {
  it("uses the exact badge texts", () => {
    expect(nautilusArmView(status()).badge.label).toBe("Running · Disarmed");
    expect(nautilusArmView(armedStatus).badge.label).toBe("Running · Armed");
    expect(nautilusArmView(downStatus).badge.label).toBe("Down");
    return expect(
      nautilusArmView(status({ arm: null, badge: "unknown" })).badge.label
    ).toBe("Unknown");
  });

  it("offers Arm only while disarmed and Disarm only while armed", () => {
    expect(nautilusArmView(status())).toMatchObject({
      arm: { enabled: true, hint: null },
      disarm: false,
    });
    expect(nautilusArmView(armedStatus)).toMatchObject({
      arm: null,
      detail: `Armed by operator at 2026-10-30T14:59:00Z: ${REASON}`,
      disarm: true,
    });
    expect(
      nautilusArmView(
        status({
          arm: { ...ARMED, armedAt: null, armedBy: null, reason: null },
          badge: "running-armed",
        })
      ).detail
    ).toBe("Armed by unknown at unknown time");
    expect(nautilusArmView(downStatus)).toMatchObject({
      arm: null,
      disarm: false,
    });
    expect(
      nautilusArmView(
        status({
          arm: armState({
            detail: "kill_switch_active",
            killSwitchActive: true,
          }),
        })
      ).arm
    ).toEqual({
      enabled: false,
      hint: "The kill switch is active; the node cannot be armed.",
    });
    return expect(
      nautilusArmView(
        status({ arm: armState({ detail: "image_version_changed" }) })
      ).arm?.hint
    ).toContain("another image version");
  });

  it("checks the reason like the server", () => {
    expect(reasonProblem(REASON)).toBeNull();
    expect(reasonProblem("short")).toBe("Write at least 10 characters.");
    expect(reasonProblem("x".repeat(281))).toBe("Use at most 280 characters.");
    expect(reasonProblem(` ${REASON}`)).toBe(
      "Remove the spaces at the start and end."
    );
    expect(reasonProblem("one\ttwo three")).toBe("Use one line only.");
    return expect(reasonProblem(`-${REASON}`)).toBe("Do not start with -.");
  });
});

describe("Nautilus arm switch in the Monitor", () => {
  it("sends nothing and shows nothing when not configured", async () => {
    const gateway = gatewayOf(status());
    await mount(monitor(gateway, false));
    expect(gateway.status).not.toHaveBeenCalled();
    return expect(badge()).toBeNull();
  });

  it("shows the disarmed badge and arms only after reason, password and statement", async () => {
    const gateway = gatewayOf(status(), armedStatus);
    await mount(monitor(gateway));
    expect(badgeText()).toBe("Running · Disarmed");
    expect(disarmButton()).toBeNull();
    await run(() => armButton()?.click());
    expect(dialog()?.textContent).toContain("Image version: 1.4.2.");
    expect(
      document.querySelector("[data-nautilus-statement]")?.textContent
    ).toBe(NAUTILUS_ARM_STATEMENT);
    expect(document.activeElement?.id).toBe("nautilus-arm-reason");
    expect(submit()?.disabled).toBe(true);
    await fill("short", PASSWORD);
    expect(submit()?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain("Write at least 10 characters.");
    await fill(REASON, "");
    expect(submit()?.disabled).toBe(true);
    await fill();
    expect(dialog()?.textContent).toContain(`${REASON.length} / 280`);
    expect(submit()?.disabled).toBe(false);
    await run(() => submit()?.click());
    expect(gateway.arm).toHaveBeenCalledExactlyOnceWith({
      imageVersion: "1.4.2",
      password: PASSWORD,
      reason: REASON,
    });
    expect(dialog()).toBeNull();
    expect(badgeText()).toBe("Running · Armed");
    expect(
      document.querySelector("[data-nautilus-detail]")?.textContent
    ).toContain(REASON);
    return expect(armButton()).toBeNull();
  });

  it("disarms with one click and no password", async () => {
    const gateway = gatewayOf(armedStatus, status());
    await mount(monitor(gateway));
    expect(badgeText()).toBe("Running · Armed");
    await run(() => disarmButton()?.click());
    expect(gateway.disarm).toHaveBeenCalledOnce();
    expect(gateway.arm).not.toHaveBeenCalled();
    return expect(badgeText()).toBe("Running · Disarmed");
  });

  it("shows a refused arm in the dialog and clears the password", async () => {
    const gateway = gatewayOf(status());
    gateway.arm.mockRejectedValueOnce({
      code: "FORBIDDEN",
      message:
        "Password check failed; the node was not armed (1 of 5 attempts)",
    });
    await mount(monitor(gateway));
    await run(() => armButton()?.click());
    await fill();
    await run(() => submit()?.click());
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toBe(
      "The node was not armed (FORBIDDEN: Password check failed; the node was not armed (1 of 5 attempts))."
    );
    expect(
      document.querySelector<HTMLInputElement>("#nautilus-arm-password")?.value
    ).toBe("");
    return expect(dialog()).not.toBeNull();
  });

  it("says the outcome is unknown when the VPS did not answer a disarm", async () => {
    const gateway = gatewayOf(armedStatus);
    gateway.disarm.mockRejectedValueOnce({
      code: "UNAVAILABLE",
      message: "Nautilus arm request timed out",
    });
    await mount(monitor(gateway));
    await run(() => disarmButton()?.click());
    expect(
      document.querySelector("[data-nautilus-arm] [role=alert]")?.textContent
    ).toBe(
      "No answer from the VPS (UNAVAILABLE: Nautilus arm request timed out). The node may have changed; check the badge."
    );
    gateway.disarm.mockRejectedValueOnce(null);
    await run(() => disarmButton()?.click());
    expect(
      document.querySelector("[data-nautilus-arm] [role=alert]")?.textContent
    ).toMatch(/^The node was not disarmed \(/u);
    gateway.disarm.mockRejectedValueOnce({ code: "CONFLICT", message: "" });
    await run(() => disarmButton()?.click());
    return expect(
      document.querySelector("[data-nautilus-arm] [role=alert]")?.textContent
    ).toMatch(/^The node was not disarmed \(CONFLICT: /u);
  });

  it("closes the dialog with Cancel or Escape, returns focus and keeps nothing", async () => {
    const gateway = gatewayOf(status());
    await mount(monitor(gateway));
    await run(() => armButton()?.click());
    await fill();
    await run(() => cancel()?.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(armButton());
    await run(() => armButton()?.click());
    expect(
      document.querySelector<HTMLInputElement>("#nautilus-arm-password")?.value
    ).toBe("");
    await run(() =>
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      )
    );
    expect(dialog()).not.toBeNull();
    // Submitting an incomplete form sends nothing.
    await run(() => dialog()?.requestSubmit());
    expect(gateway.arm).not.toHaveBeenCalled();
    await run(() =>
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      )
    );
    expect(dialog()).toBeNull();
    return expect(gateway.arm).not.toHaveBeenCalled();
  });

  it("ignores Escape while an arm is being sent", async () => {
    const gateway = gatewayOf(status());
    let finish: ((value: NautilusArmChangeOutput) => void) | undefined;
    gateway.arm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await mount(monitor(gateway));
    await run(() => armButton()?.click());
    await fill();
    await run(() => submit()?.click());
    await run(() =>
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      )
    );
    expect(dialog()).not.toBeNull();
    await run(() => finish?.(change("arm")));
    return expect(dialog()).toBeNull();
  });

  it("shows Down and the kill switch hint", async () => {
    await mount(monitor(gatewayOf(downStatus)));
    expect(badgeText()).toBe("Down");
    expect(armButton()).toBeNull();
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await mount(
      monitor(
        gatewayOf(
          status({
            arm: armState({
              detail: "kill_switch_active",
              killSwitchActive: true,
            }),
          })
        )
      )
    );
    expect(armButton()?.disabled).toBe(true);
    return expect(
      document.querySelector("#nautilus-arm-hint")?.textContent
    ).toBe("The kill switch is active; the node cannot be armed.");
  });

  it("shows Unreachable when the status call fails and polls again", async () => {
    vi.useFakeTimers();
    const gateway = gatewayOf(
      { code: "UNAVAILABLE", message: "Nautilus arm service unavailable" },
      status()
    );
    await mount(monitor(gateway));
    expect(badgeText()).toBe("Unreachable");
    expect(badge()?.getAttribute("title")).toBe(
      "UNAVAILABLE: Nautilus arm service unavailable"
    );
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await flush();
    });
    expect(badgeText()).toBe("Running · Disarmed");
    return expect(gateway.status).toHaveBeenCalledTimes(2);
  });

  it("hides itself for operator-only failures and stops polling", async () => {
    vi.useFakeTimers();
    const gateway = gatewayOf({ code: "FORBIDDEN", message: "Forbidden" });
    await mount(monitor(gateway));
    expect(badge()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await flush();
    });
    return expect(gateway.status).toHaveBeenCalledOnce();
  });

  it("shows nothing before the first status and ignores answers after unmount", async () => {
    let answer: ((value: NautilusArmStatusOutput) => void) | undefined;
    let refuse: ((reason: unknown) => void) | undefined;
    const pending = {
      arm: vi.fn(),
      disarm: vi.fn(),
      status: vi
        .fn<() => Promise<NautilusArmStatusOutput>>()
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
    };
    await mount(monitor(pending));
    expect(badge()).toBeNull();
    expect(document.querySelector("[data-nautilus-arm]")).toBeNull();
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

  it("uses the browser client by default and sends nothing while not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await mount(
      <AccountGlance gateway={portfolio()} nautilus={{ configured: false }} />
    );
    expect(badge()).toBeNull();
    return expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("nautilus arm client", () => {
  it("adds the exact statement and calls the oRPC procedures", async () => {
    const statusFn = vi.fn(async () => status());
    const armFn = vi.fn(async () => change("arm"));
    const disarmFn = vi.fn(async () => change("disarm"));
    const gateway = createNautilusArmGateway({
      nautilusArm: { arm: armFn, disarm: disarmFn, status: statusFn },
    } as unknown as Parameters<typeof createNautilusArmGateway>[0]);
    await gateway.status();
    await gateway.arm({
      imageVersion: "1.4.2",
      password: PASSWORD,
      reason: REASON,
    });
    await gateway.disarm();
    expect(statusFn).toHaveBeenCalledWith({});
    expect(disarmFn).toHaveBeenCalledWith({});
    return expect(armFn).toHaveBeenCalledWith({
      imageVersion: "1.4.2",
      password: PASSWORD,
      reason: REASON,
      statement: NAUTILUS_ARM_STATEMENT,
    });
  });

  it("creates the browser client lazily on the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: status() }));
    const gateway = createBrowserNautilusArmGateway();
    expect(fetchSpy).not.toHaveBeenCalled();
    await gateway.status().catch(() => undefined);
    await gateway
      .arm({ imageVersion: "1.4.2", password: PASSWORD, reason: REASON })
      .catch(() => undefined);
    await gateway.disarm().catch(() => undefined);
    return expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
